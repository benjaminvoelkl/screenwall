// Screenwall – lokaler Server für Steuerseite (/) und Vollbild-Anzeige (/screen).
//
// Architektur (siehe README):
//   - Express liefert beide Seiten + statische Assets + Uploads aus.
//   - Der komplette Anzeige-Zustand liegt in state.json (überlebt Neustart).
//   - Jede Änderung wird per WebSocket an ALLE verbundenen Clients gepusht
//     (mehrere /screen-Geräte und mehrere Steuerseiten bleiben synchron).
//
// Datenfluss: / ändert etwas -> HTTP-Request an Server -> Server speichert
// state.json und broadcastet den neuen Zustand -> alle /screen reagieren sofort.

import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { randomUUID } from 'crypto';
import { networkInterfaces } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// An 0.0.0.0 binden, damit der Server im gesamten LAN erreichbar ist (nicht nur localhost).
const HOST = '0.0.0.0';

const STATE_FILE = join(__dirname, 'state.json');
const UPLOAD_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Zustands-Modell
// ---------------------------------------------------------------------------
// Annahmen (laut Aufgabenstellung, falls nicht anders angegeben):
//   - Crop-Seitenverhältnis 18:16 (= 9:8), exakt wie gefordert.
//   - Diashow-Videos laufen bis zum Videoende ("videoMode": "end"); alternativ
//     feste Anzeigedauer ("duration"). Standard: bis zum Ende.
//   - Kein Auth/Passwortschutz (rein lokal).
//   - Mehrere /screen-Geräte gleichzeitig sind erlaubt (WS-Broadcast).
const DEFAULT_STATE = {
  mode: 'welcome', // 'slideshow' | 'youtube' | 'welcome'
  slideshow: {
    durationSec: 6,
    // Verhalten bei Video-Slides: 'end' = bis Videoende, 'duration' = feste Dauer.
    videoMode: 'end',
    // Mehrere benannte Sequenzen; die aktive wird auf /screen angezeigt.
    activeSequenceId: 'default',
    sequences: [
      { id: 'default', name: 'Sequenz 1', media: [] } // media: [{ id, type, filename, name }]
    ]
  },
  youtube: {
    muted: true, // Browser erlauben Autoplay meist nur stummgeschaltet.
    videos: [] // [{ id, videoId, title }]
  },
  welcome: {
    text: 'Herzlich Willkommen Gast',
    template: 'elegant', // 'elegant' | 'modern' | 'festive'
    fontSize: 8, // in vw
    visible: true
  }
};

function loadState() {
  if (!existsSync(STATE_FILE)) {
    saveState(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const loaded = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    // Mit Defaults zusammenführen, damit neue Felder nach Updates vorhanden sind.
    const merged = {
      ...structuredClone(DEFAULT_STATE),
      ...loaded,
      slideshow: { ...DEFAULT_STATE.slideshow, ...(loaded.slideshow || {}) },
      youtube: { ...DEFAULT_STATE.youtube, ...(loaded.youtube || {}) },
      welcome: { ...DEFAULT_STATE.welcome, ...(loaded.welcome || {}) }
    };
    merged.slideshow = normalizeSlideshow(merged.slideshow);
    return merged;
  } catch (err) {
    console.error('state.json konnte nicht gelesen werden, nutze Defaults:', err.message);
    return structuredClone(DEFAULT_STATE);
  }
}

// Stellt sicher, dass slideshow das Sequenz-Modell hat. Migriert auch alte
// state.json-Dateien, die noch eine einzelne `media`-Liste hatten.
function normalizeSlideshow(ss) {
  ss = ss || {};
  if (!Array.isArray(ss.sequences)) {
    const media = Array.isArray(ss.media) ? ss.media : [];
    ss.sequences = [{ id: 'default', name: 'Sequenz 1', media }];
  }
  if (ss.sequences.length === 0) {
    ss.sequences.push({ id: randomUUID(), name: 'Sequenz 1', media: [] });
  }
  for (const seq of ss.sequences) if (!Array.isArray(seq.media)) seq.media = [];
  if (!ss.activeSequenceId || !ss.sequences.some((s) => s.id === ss.activeSequenceId)) {
    ss.activeSequenceId = ss.sequences[0].id;
  }
  delete ss.media; // altes Single-Listen-Feld entfernen
  return ss;
}

let state = loadState();

function saveState(s = state) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function findSequence(id) {
  return state.slideshow.sequences.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// HTTP / Express
// ---------------------------------------------------------------------------
const app = express();
const server = createServer(app);

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
app.get('/screen', (req, res) => res.sendFile(join(PUBLIC_DIR, 'screen.html')));

// Aktuellen Zustand holen (beim Laden von / und /screen).
app.get('/api/state', (req, res) => res.json(state));

// Zustand (teilweise) aktualisieren. Body = { mode } und/oder
// { slideshow: {...} } / { youtube: {...} } / { welcome: {...} }.
// Felder werden flach in den jeweiligen Teil-Zustand gemischt.
app.post('/api/state', (req, res) => {
  const patch = req.body || {};
  if (typeof patch.mode === 'string') state.mode = patch.mode;
  for (const key of ['slideshow', 'youtube', 'welcome']) {
    if (patch[key] && typeof patch[key] === 'object') {
      state[key] = { ...state[key], ...patch[key] };
    }
  }
  saveState();
  broadcast();
  res.json(state);
});

// --- Upload (Modus 1) -------------------------------------------------------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB pro Datei (Videos)
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('Nur Bilder und Videos erlaubt'), ok);
  }
});

// Upload in eine bestimmte Sequenz (Form-Feld `sequenceId`, sonst die aktive).
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen' });
  const seq = findSequence(req.body.sequenceId) || findSequence(state.slideshow.activeSequenceId);
  if (!seq) return res.status(400).json({ error: 'Sequenz nicht gefunden' });
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const item = {
    id: randomUUID(),
    type,
    filename: req.file.filename,
    name: req.file.originalname
  };
  seq.media.push(item);
  saveState();
  broadcast();
  res.json(item);
});

// Einzelnes Medium löschen (Suche über alle Sequenzen; IDs sind eindeutig).
app.delete('/api/media/:id', (req, res) => {
  for (const seq of state.slideshow.sequences) {
    const idx = seq.media.findIndex((m) => m.id === req.params.id);
    if (idx !== -1) {
      const [removed] = seq.media.splice(idx, 1);
      try {
        unlinkSync(join(UPLOAD_DIR, removed.filename));
      } catch (err) {
        console.warn('Datei konnte nicht gelöscht werden:', err.message);
      }
      saveState();
      broadcast();
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'Nicht gefunden' });
});

// Reihenfolge innerhalb einer Sequenz setzen. Body: { sequenceId, order: [id,...] }.
app.post('/api/media/order', (req, res) => {
  const { sequenceId, order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order fehlt' });
  const seq = findSequence(sequenceId);
  if (!seq) return res.status(404).json({ error: 'Sequenz nicht gefunden' });
  const byId = new Map(seq.media.map((m) => [m.id, m]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  // Eventuell nicht gelistete Medien hinten anhängen (Sicherheit).
  for (const m of seq.media) if (!order.includes(m.id)) reordered.push(m);
  seq.media = reordered;
  saveState();
  broadcast();
  res.json(seq);
});

// --- Sequenz-Verwaltung -----------------------------------------------------
// Neue Sequenz anlegen (wird direkt aktiv gesetzt, damit man sie befüllen kann).
app.post('/api/slideshow/sequence', (req, res) => {
  const name = (req.body?.name || '').trim() || `Sequenz ${state.slideshow.sequences.length + 1}`;
  const seq = { id: randomUUID(), name, media: [] };
  state.slideshow.sequences.push(seq);
  state.slideshow.activeSequenceId = seq.id;
  saveState();
  broadcast();
  res.json(seq);
});

// Sequenz umbenennen.
app.post('/api/slideshow/sequence/:id/rename', (req, res) => {
  const seq = findSequence(req.params.id);
  if (!seq) return res.status(404).json({ error: 'Sequenz nicht gefunden' });
  const name = (req.body?.name || '').trim();
  if (name) seq.name = name;
  saveState();
  broadcast();
  res.json(seq);
});

// Sequenz löschen (inkl. ihrer Mediendateien). Mindestens eine muss bleiben.
app.delete('/api/slideshow/sequence/:id', (req, res) => {
  const seqs = state.slideshow.sequences;
  if (seqs.length <= 1) return res.status(400).json({ error: 'Mindestens eine Sequenz erforderlich' });
  const idx = seqs.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sequenz nicht gefunden' });
  const [removed] = seqs.splice(idx, 1);
  for (const m of removed.media) {
    try { unlinkSync(join(UPLOAD_DIR, m.filename)); } catch (_) { /* egal */ }
  }
  if (state.slideshow.activeSequenceId === removed.id) {
    state.slideshow.activeSequenceId = seqs[0].id;
  }
  saveState();
  broadcast();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket – Live-Broadcast des Zustands
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  // Beim Verbinden sofort den aktuellen Zustand senden.
  ws.send(JSON.stringify({ type: 'state', state }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('\n  Screenwall läuft.');
  console.log(`  Lokal:      http://localhost:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  Im Netz:    http://${ip}:${PORT}/        (Steuerung)`);
    console.log(`              http://${ip}:${PORT}/screen  (Anzeige)`);
  }
  console.log('');
});
