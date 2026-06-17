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
  mode: 'slideshow', // 'slideshow' | 'youtube' | 'link'
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
    crop: false, // true = Video formatfüllend zuschneiden (Cover) statt Balken.
    videos: [] // [{ id, videoId, title }]
  },
  // Modus „Link": Webseiten werden nacheinander im Vollbild (iframe) gezeigt.
  link: {
    durationSec: 15, // Anzeigedauer pro Link in Sekunden (bei mehreren)
    items: [] // [{ id, url, title }]
  },
  // Willkommens-Overlay, das ÜBER der laufenden Diashow eingeblendet wird
  // (Dual-TV-Begrüßungsscreen: zentrierte Karte mit Blur-Hintergrund).
  welcome: {
    visible: true, // Overlay ein-/ausblenden
    template: 'elegant', // 'elegant' | 'modern' | 'festive' (nur Schrift/Farbe)
    fontSize: 8, // Überschrift-Größe in vw
    blur: 18, // Stärke des Blur-Hintergrunds in px
    headline: 'Herzlich Willkommen', // zentrale Überschrift oben
    // Pro Seite: logo (Dateiname), text, Textgröße (vw), Logogröße (vh),
    // logoPos = 'top' | 'bottom' (Logo über oder unter dem Text, per Drag&Drop).
    left: { logo: null, text: '', textSize: 4.8, logoSize: 22, logoPos: 'top' },
    right: { logo: null, text: '', textSize: 4.8, logoSize: 22, logoPos: 'top' },
    // Gespeicherte Presets: [{ id, name, config: {template,fontSize,blur,headline,left,right} }]
    presets: []
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
      link: { ...DEFAULT_STATE.link, ...(loaded.link || {}) },
      welcome: { ...DEFAULT_STATE.welcome, ...(loaded.welcome || {}) }
    };
    merged.slideshow = normalizeSlideshow(merged.slideshow);
    merged.welcome = normalizeWelcome(merged.welcome);
    if (merged.mode === 'welcome') merged.mode = 'slideshow'; // alter Modus entfällt
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

// Stellt das Willkommens-Overlay-Modell sicher und migriert alte state.json-
// Dateien, die noch ein einzelnes `text`-Feld statt Überschrift + Seiten hatten.
function normalizeWelcome(w) {
  w = w || {};
  // Alte Datei (hatte `text` statt `headline`): Text als Überschrift übernehmen.
  // `text` existiert nur in vor-Migration-Dateien (neue löschen es unten).
  if (typeof w.text === 'string') w.headline = w.text;
  if (typeof w.headline !== 'string') w.headline = DEFAULT_STATE.welcome.headline;
  if (typeof w.blur !== 'number') w.blur = DEFAULT_STATE.welcome.blur;
  const d = DEFAULT_STATE.welcome.left;
  for (const side of ['left', 'right']) {
    const s = w[side] && typeof w[side] === 'object' ? w[side] : {};
    w[side] = {
      logo: s.logo || null,
      text: typeof s.text === 'string' ? s.text : '',
      textSize: typeof s.textSize === 'number' ? s.textSize : d.textSize,
      logoSize: typeof s.logoSize === 'number' ? s.logoSize : d.logoSize,
      logoPos: s.logoPos === 'bottom' ? 'bottom' : 'top'
    };
  }
  if (!Array.isArray(w.presets)) w.presets = [];
  delete w.text; // altes Single-Text-Feld entfernen
  return w;
}

// Momentaufnahme der Overlay-Gestaltung (ohne visible/presets) für ein Preset.
function welcomeConfigSnapshot(w) {
  return {
    template: w.template,
    fontSize: w.fontSize,
    blur: w.blur,
    headline: w.headline,
    left: { ...w.left },
    right: { ...w.right }
  };
}

// Prüft, ob eine Logo-Datei noch irgendwo referenziert wird (aktuell oder in
// einem Preset). Verhindert, dass ein noch genutztes Logo gelöscht wird.
function logoInUse(filename) {
  if (!filename) return false;
  const w = state.welcome;
  if (w.left.logo === filename || w.right.logo === filename) return true;
  for (const p of w.presets || []) {
    if (p.config?.left?.logo === filename || p.config?.right?.logo === filename) return true;
  }
  return false;
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
// Uploads (UUID-Dateinamen, unveränderlich) dürfen gecacht werden.
app.use('/uploads', express.static(UPLOAD_DIR));
// Steuer-/Anzeige-Assets nie hart cachen, damit Code-Updates nach einem Reload
// sofort greifen (verhindert veraltete screen.js auf Kiosk-Displays).
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache')
}));

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});
app.get('/screen', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'screen.html'));
});

// Aktuellen Zustand holen (beim Laden von / und /screen).
app.get('/api/state', (req, res) => res.json(state));

// Zustand (teilweise) aktualisieren. Body = { mode } und/oder
// { slideshow: {...} } / { youtube: {...} } / { welcome: {...} }.
// Felder werden flach in den jeweiligen Teil-Zustand gemischt.
app.post('/api/state', (req, res) => {
  const patch = req.body || {};
  if (typeof patch.mode === 'string') state.mode = patch.mode;
  for (const key of ['slideshow', 'youtube', 'link']) {
    if (patch[key] && typeof patch[key] === 'object') {
      state[key] = { ...state[key], ...patch[key] };
    }
  }
  // welcome verschachtelt mergen, damit ein Patch von left/right.text nicht das
  // gespeicherte left/right.logo überschreibt.
  if (patch.welcome && typeof patch.welcome === 'object') {
    const p = patch.welcome;
    const prev = state.welcome; // vor dem Spread merken, sonst geht logo verloren
    const next = { ...prev, ...p };
    for (const side of ['left', 'right']) {
      next[side] = { ...prev[side], ...(p[side] && typeof p[side] === 'object' ? p[side] : {}) };
    }
    state.welcome = next;
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

// --- Modus „Link": Einbettbarkeit prüfen + Link hinzufügen ------------------
// Liest die Antwort-Header der Ziel-URL (server-seitig, daher kein CORS-Problem)
// und entscheidet, ob die Seite sich in ein iframe einbetten lässt.
// Rückgabe: embeddable = true | false | null (null = Prüfung nicht möglich).
async function checkEmbeddable(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Screenwall)' }
    });
    clearTimeout(timer);
    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (res.headers.get('content-security-policy') || '').toLowerCase();
    if (xfo.includes('deny') || xfo.includes('sameorigin')) {
      return { embeddable: false, reason: `X-Frame-Options: ${xfo.trim()}` };
    }
    const m = csp.match(/frame-ancestors([^;]*)/);
    if (m) {
      const val = m[1].trim();
      // 'none' oder eine Liste ohne Wildcard/fremde Hosts => nicht einbettbar.
      if (/'none'/.test(val) || (!val.includes('*') && !/https?:/.test(val))) {
        return { embeddable: false, reason: `CSP frame-ancestors: ${val}` };
      }
    }
    return { embeddable: true, reason: '' };
  } catch (err) {
    return { embeddable: null, reason: 'Prüfung fehlgeschlagen: ' + err.message };
  }
}

// Link hinzufügen (mit Einbettbarkeits-Prüfung). Body: { url }.
app.post('/api/link', async (req, res) => {
  try {
    const url = (req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Ungültige URL' });
    const { embeddable, reason } = await checkEmbeddable(url);
    const item = { id: randomUUID(), url, title: url, embeddable, reason };
    state.link.items.push(item);
    saveState();
    broadcast();
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Einbettbarkeit eines vorhandenen Links neu prüfen. Body: { id }.
app.post('/api/link/recheck', async (req, res) => {
  try {
    const item = state.link.items.find((x) => x.id === req.body?.id);
    if (!item) return res.status(404).json({ error: 'Link nicht gefunden' });
    const { embeddable, reason } = await checkEmbeddable(item.url);
    item.embeddable = embeddable;
    item.reason = reason;
    saveState();
    broadcast();
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Willkommens-Overlay: Logo-Upload je Seite ------------------------------
// Lädt ein Logo hoch und hängt es an die linke oder rechte Seite (Form-Feld
// `side` = 'left' | 'right'). Ein eventuell vorhandenes altes Logo wird gelöscht.
app.post('/api/welcome/logo', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen' });
  const side = req.body.side === 'right' ? 'right' : 'left';
  const old = state.welcome[side].logo;
  state.welcome[side].logo = req.file.filename;
  // Altes Logo nur löschen, wenn es nicht noch von einem Preset genutzt wird.
  if (old && old !== req.file.filename && !logoInUse(old)) {
    try { unlinkSync(join(UPLOAD_DIR, old)); } catch (_) { /* egal */ }
  }
  saveState();
  broadcast();
  res.json({ side, logo: req.file.filename });
});

// Logo einer Seite entfernen. Body: { side: 'left' | 'right' }.
app.delete('/api/welcome/logo', (req, res) => {
  const side = req.body?.side === 'right' ? 'right' : 'left';
  const old = state.welcome[side].logo;
  state.welcome[side].logo = null;
  if (old && !logoInUse(old)) {
    try { unlinkSync(join(UPLOAD_DIR, old)); } catch (_) { /* egal */ }
  }
  saveState();
  broadcast();
  res.json({ ok: true });
});

// --- Willkommens-Overlay: Presets ------------------------------------------
// Aktuelle Gestaltung als benanntes Preset speichern.
app.post('/api/welcome/preset', (req, res) => {
  const name = (req.body?.name || '').trim() || `Preset ${state.welcome.presets.length + 1}`;
  const preset = { id: randomUUID(), name, config: welcomeConfigSnapshot(state.welcome) };
  state.welcome.presets.push(preset);
  saveState();
  broadcast();
  res.json(preset);
});

// Preset auf das Overlay anwenden (visible bleibt unverändert).
app.post('/api/welcome/preset/:id/apply', (req, res) => {
  const preset = state.welcome.presets.find((p) => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'Preset nicht gefunden' });
  const c = preset.config || {};
  const w = state.welcome;
  if (typeof c.template === 'string') w.template = c.template;
  if (typeof c.fontSize === 'number') w.fontSize = c.fontSize;
  if (typeof c.blur === 'number') w.blur = c.blur;
  if (typeof c.headline === 'string') w.headline = c.headline;
  if (c.left) w.left = { ...c.left };
  if (c.right) w.right = { ...c.right };
  saveState();
  broadcast();
  res.json(w);
});

// Preset überschreiben (mit der aktuellen Gestaltung).
app.post('/api/welcome/preset/:id/save', (req, res) => {
  const preset = state.welcome.presets.find((p) => p.id === req.params.id);
  if (!preset) return res.status(404).json({ error: 'Preset nicht gefunden' });
  const oldLogos = [preset.config?.left?.logo, preset.config?.right?.logo];
  preset.config = welcomeConfigSnapshot(state.welcome);
  // Nicht mehr referenzierte Logos der alten Preset-Version aufräumen.
  for (const fn of oldLogos) {
    if (fn && !logoInUse(fn)) {
      try { unlinkSync(join(UPLOAD_DIR, fn)); } catch (_) { /* egal */ }
    }
  }
  saveState();
  broadcast();
  res.json(preset);
});

// Preset löschen (und dessen Logos, falls nirgends sonst genutzt).
app.delete('/api/welcome/preset/:id', (req, res) => {
  const idx = state.welcome.presets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Preset nicht gefunden' });
  const [removed] = state.welcome.presets.splice(idx, 1);
  for (const fn of [removed.config?.left?.logo, removed.config?.right?.logo]) {
    if (fn && !logoInUse(fn)) {
      try { unlinkSync(join(UPLOAD_DIR, fn)); } catch (_) { /* egal */ }
    }
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

  // Befehle (z. B. Video-Seek aus der Live-Vorschau) an alle Clients
  // weiterreichen, damit Wand und Vorschau gleichzeitig springen. Diese
  // Befehle sind flüchtig und werden nicht im Zustand persistiert.
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg || msg.type !== 'cmd') return;
    const out = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(out);
    }
  });
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
