// Screenwall – lokaler Server für Programm-Timeline (/programm), Playlist-Editor
// (/playlists), Live-Monitor (/) und Vollbild-Anzeige (/screen).
//
// Architektur (siehe README):
//   - Express liefert die Seiten + statische Assets + Uploads aus.
//   - Der komplette Anzeige-Zustand liegt in state.json (Entwurf) und live.json
//     (veröffentlicht/Wand) und überlebt einen Neustart.
//   - Jede Änderung wird per WebSocket an ALLE verbundenen Clients gepusht.
//
// Inhaltsmodell: PLAYLISTS + CONTENTS (ersetzt die früheren Modi).
//   - Ein "Content" ist der Hintergrund einer Übertragung: color | image | video
//     | youtube | webpage (+ vorbereitet: screenshare). Er wird IMMER in eine
//     Playlist gekapselt.
//   - Eine "Playlist" ist eine geordnete Liste von Einträgen; ein Eintrag ist
//     entweder ein Content ODER eine Referenz auf eine andere Playlist
//     (Verschachtelung). Jede Playlist hat eine Nachfolge-Aktion `after`:
//     'next' (Verweis auf `nextId`), 'loop' oder 'stop'.
//   - `rootId` bestimmt die Start-Playlist der Übertragung.

import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { randomUUID } from 'crypto';
import { networkInterfaces } from 'os';
import { execFile } from 'child_process';
import QRCode from 'qrcode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// An 0.0.0.0 binden, damit der Server im gesamten LAN erreichbar ist (nicht nur localhost).
const HOST = '0.0.0.0';

const STATE_FILE = join(__dirname, 'state.json'); // Entwurf (von der Steuerung bearbeitet)
const LIVE_FILE = join(__dirname, 'live.json'); // Veröffentlichter Zustand (Wand/​/screen)
const UPLOAD_DIR = join(__dirname, 'uploads');
const PUBLIC_DIR = join(__dirname, 'public');

// Audio-Ziel für die Lautstärkesteuerung (PipeWire/WirePlumber via wpctl).
const AUDIO_SINK = process.env.AUDIO_SINK || '@DEFAULT_AUDIO_SINK@';

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Zustands-Modell
// ---------------------------------------------------------------------------
const CONTENT_TYPES = ['color', 'image', 'video', 'youtube', 'webpage', 'screenshare'];
// Overlay-Elementtypen (liegen ÜBER dem Content; frei auf dem Ausgabe-Canvas platziert).
const ELEMENT_TYPES = ['text', 'image', 'qr'];

const DEFAULT_STATE = {
  // Playlists als flache Registry (byId) + Wurzel-Playlist (rootId).
  playlists: {
    rootId: 'pl-default',
    byId: {
      'pl-default': { id: 'pl-default', name: 'Playlist 1', after: 'loop', nextId: null, items: [] }
    }
  },
  // Overlays: mehrere Zeit-Clips über dem Content (Array = Z-Ordnung, 0 = unten).
  overlays: []
};

const newId = () => randomUUID();

// ---- Content / Item / Playlist normalisieren -------------------------------
function defaultDuration(type) {
  return (type === 'webpage' || type === 'screenshare') ? 15 : 6;
}

// Einen Content säubern/normalisieren. Behält nur die für den Typ relevanten Felder.
function normalizeContent(c) {
  c = (c && typeof c === 'object') ? c : {};
  const type = CONTENT_TYPES.includes(c.type) ? c.type : 'color';
  const out = { type, name: typeof c.name === 'string' ? c.name : '' };

  if (type === 'color') out.color = typeof c.color === 'string' ? c.color : '#000000';
  if (type === 'image' || type === 'video') out.filename = typeof c.filename === 'string' ? c.filename : null;
  if (type === 'youtube') out.videoId = typeof c.videoId === 'string' ? c.videoId : null;
  if (type === 'webpage' || type === 'screenshare') {
    out.url = typeof c.url === 'string' ? c.url : '';
    if (type === 'webpage') {
      out.embeddable = typeof c.embeddable === 'boolean' ? c.embeddable : null;
      out.reason = typeof c.reason === 'string' ? c.reason : '';
    }
  }
  // Anzeigedauer (für color/image/webpage/screenshare sowie video/youtube bei
  // videoMode==='duration').
  out.durationSec = (typeof c.durationSec === 'number' && c.durationSec > 0)
    ? c.durationSec : defaultDuration(type);
  if (type === 'video' || type === 'youtube') {
    out.videoMode = c.videoMode === 'duration' ? 'duration' : 'end';
    out.muted = c.muted !== false;
  }
  if (type === 'image' || type === 'video' || type === 'youtube') out.crop = !!c.crop;
  return out;
}

function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = typeof it.id === 'string' ? it.id : newId();
  if (it.kind === 'playlist') {
    if (typeof it.refId !== 'string') return null;
    return { id, kind: 'playlist', refId: it.refId };
  }
  return { id, kind: 'content', content: normalizeContent(it.content) };
}

// Entfernt Verschachtelungs-Zyklen (Playlist, die sich – direkt oder indirekt –
// selbst enthält). Eine Rückwärtskante im DFS wird gekappt.
function breakContainmentCycles(byId) {
  const mark = {}; // id -> 1 (im Stack) | 2 (fertig)
  function dfs(id) {
    mark[id] = 1;
    const pl = byId[id];
    if (pl) {
      pl.items = pl.items.filter((it) => {
        if (it.kind !== 'playlist') return true;
        const child = it.refId;
        if (!byId[child]) return false;     // kaputte Referenz
        if (mark[child] === 1) return false; // Rückwärtskante -> Zyklus kappen
        if (!mark[child]) dfs(child);
        return true;
      });
    }
    mark[id] = 2;
  }
  for (const id of Object.keys(byId)) if (!mark[id]) dfs(id);
}

function normalizePlaylists(p) {
  const src = (p && p.byId && typeof p.byId === 'object') ? p.byId : {};
  const byId = {};
  for (const [id, pl] of Object.entries(src)) {
    if (!pl || typeof pl !== 'object') continue;
    const items = Array.isArray(pl.items) ? pl.items.map(normalizeItem).filter(Boolean) : [];
    byId[id] = {
      id,
      name: typeof pl.name === 'string' ? pl.name : 'Playlist',
      after: ['next', 'loop', 'stop'].includes(pl.after) ? pl.after : 'loop',
      nextId: typeof pl.nextId === 'string' ? pl.nextId : null,
      items
    };
  }
  if (Object.keys(byId).length === 0) {
    byId['pl-default'] = { id: 'pl-default', name: 'Playlist 1', after: 'loop', nextId: null, items: [] };
  }
  // Kaputte Referenzen säubern.
  for (const pl of Object.values(byId)) {
    pl.items = pl.items.filter((it) => it.kind !== 'playlist' || byId[it.refId]);
    if (pl.nextId && !byId[pl.nextId]) pl.nextId = null;
    if (pl.after === 'next' && !pl.nextId) pl.after = 'loop';
  }
  breakContainmentCycles(byId);
  const rootId = (p && typeof p.rootId === 'string' && byId[p.rootId]) ? p.rootId : Object.keys(byId)[0];
  return { rootId, byId };
}

// ---- Overlays / Elemente normalisieren -------------------------------------
function clamp01(n, d) { n = (typeof n === 'number' && isFinite(n)) ? n : d; return Math.max(0, Math.min(1, n)); }

// Externe Datenquelle eines Elements (Phase-1-Vorbereitung für Wetter/News).
function normalizeSource(s) {
  s = (s && typeof s === 'object') ? s : {};
  const kind = s.kind === 'url' ? 'url' : 'static';
  if (kind !== 'url') return { kind: 'static' };
  return {
    kind: 'url',
    url: typeof s.url === 'string' ? s.url : '',
    refreshSec: (typeof s.refreshSec === 'number' && s.refreshSec >= 2) ? s.refreshSec : 60,
    jsonPath: typeof s.jsonPath === 'string' ? s.jsonPath : ''
  };
}

// Ein Overlay-Element: Position/Größe als Bruchteile (0..1) des Ausgabebilds.
function normalizeElement(e) {
  e = (e && typeof e === 'object') ? e : {};
  const type = ELEMENT_TYPES.includes(e.type) ? e.type : 'text';
  const out = {
    id: typeof e.id === 'string' ? e.id : newId(),
    type,
    x: clamp01(e.x, 0.1), y: clamp01(e.y, 0.1),
    w: clamp01(e.w, 0.3), h: clamp01(e.h, 0.15),
    source: normalizeSource(e.source)
  };
  if (type === 'text') {
    out.text = typeof e.text === 'string' ? e.text : '';
    out.color = typeof e.color === 'string' ? e.color : '#ffffff';
    out.bg = typeof e.bg === 'string' ? e.bg : '';            // '' = transparent
    out.align = ['left', 'center', 'right'].includes(e.align) ? e.align : 'center';
    out.weight = typeof e.weight === 'number' ? e.weight : 700;
    out.fontFrac = (typeof e.fontFrac === 'number' && e.fontFrac > 0) ? e.fontFrac : 0.5; // Anteil der Elementhöhe
  } else if (type === 'image') {
    out.filename = typeof e.filename === 'string' ? e.filename : null;
    out.url = typeof e.url === 'string' ? e.url : '';
    out.fit = e.fit === 'cover' ? 'cover' : 'contain';
  } else if (type === 'qr') {
    out.data = typeof e.data === 'string' ? e.data : '';
    out.fg = typeof e.fg === 'string' ? e.fg : '#000000';
    out.bg = typeof e.bg === 'string' ? e.bg : '#ffffff';
  }
  return out;
}

function normalizeOverlay(o) {
  o = (o && typeof o === 'object') ? o : {};
  return {
    id: typeof o.id === 'string' ? o.id : newId(),
    name: typeof o.name === 'string' ? o.name : 'Overlay',
    enabled: o.enabled !== false,
    start: (typeof o.start === 'number' && o.start >= 0) ? o.start : 0,
    duration: (typeof o.duration === 'number' && o.duration > 0) ? o.duration : null, // null = ganzes Programm
    blur: (typeof o.blur === 'number' && o.blur >= 0) ? o.blur : 0,
    elements: Array.isArray(o.elements) ? o.elements.map(normalizeElement) : []
  };
}
function normalizeOverlays(arr) { return Array.isArray(arr) ? arr.map(normalizeOverlay) : []; }

// Altes Willkommens-Overlay (welcome.*) in ein Overlay mit Elementen überführen.
function overlayFromWelcome(w) {
  w = w || {};
  const els = [];
  if (w.headline) {
    els.push(normalizeElement({ type: 'text', text: w.headline, x: 0.1, y: 0.06, w: 0.8, h: 0.14, align: 'center', color: '#ffffff', fontFrac: 0.7 }));
  }
  const baseX = { left: 0.08, right: 0.56 };
  for (const side of ['left', 'right']) {
    const s = w[side] || {};
    const x = baseX[side];
    const logoTop = s.logoPos !== 'bottom';
    if (s.logo) els.push(normalizeElement({ type: 'image', filename: s.logo, x, y: logoTop ? 0.32 : 0.62, w: 0.36, h: 0.26, fit: 'contain' }));
    if (s.text) els.push(normalizeElement({ type: 'text', text: s.text, x, y: logoTop ? 0.62 : 0.32, w: 0.36, h: 0.1, align: 'center', color: '#ffffff', fontFrac: 0.6 }));
  }
  return normalizeOverlay({
    name: 'Willkommen', enabled: w.visible !== false, start: 0, duration: null,
    blur: typeof w.blur === 'number' ? w.blur : 18, elements: els
  });
}

// Alte (modus-basierte) state.json/live.json in das Playlist-Modell überführen.
// Gibt ein {rootId, byId} zurück oder null, wenn nichts zu migrieren ist.
function migrateLegacy(loaded) {
  const byId = {};
  const order = [];
  let activeId = null;

  const ss = loaded.slideshow;
  if (ss && Array.isArray(ss.sequences)) {
    for (const seq of ss.sequences) {
      const id = (typeof seq.id === 'string' && seq.id) ? seq.id : newId();
      const items = (Array.isArray(seq.media) ? seq.media : []).map((m) => ({
        id: newId(), kind: 'content',
        content: normalizeContent({
          type: m.type === 'video' ? 'video' : 'image',
          name: m.name, filename: m.filename,
          durationSec: ss.durationSec, videoMode: ss.videoMode
        })
      }));
      byId[id] = { id, name: seq.name || 'Diashow', after: 'loop', nextId: null, items };
      order.push(id);
      if (loaded.mode === 'slideshow' && ss.activeSequenceId === seq.id) activeId = id;
    }
  }

  const yt = loaded.youtube;
  if (yt && Array.isArray(yt.sequences)) {
    for (const seq of yt.sequences) {
      const id = (typeof seq.id === 'string' && seq.id) ? seq.id : newId();
      const items = (Array.isArray(seq.videos) ? seq.videos : []).map((v) => ({
        id: newId(), kind: 'content',
        content: normalizeContent({
          type: 'youtube', videoId: v.videoId, name: v.title,
          muted: yt.muted, crop: yt.crop, videoMode: 'end'
        })
      }));
      byId[id] = { id, name: seq.name || 'YouTube', after: 'loop', nextId: null, items };
      order.push(id);
      if (loaded.mode === 'youtube' && yt.activeSequenceId === seq.id) activeId = id;
    }
  }

  const link = loaded.link;
  if (link && Array.isArray(link.items) && link.items.length) {
    const id = newId();
    const items = link.items.map((it) => ({
      id: newId(), kind: 'content',
      content: normalizeContent({
        type: 'webpage', url: it.url, name: it.title || it.url,
        embeddable: it.embeddable, reason: it.reason, durationSec: link.durationSec
      })
    }));
    byId[id] = { id, name: 'Links', after: 'loop', nextId: null, items };
    order.push(id);
    if (loaded.mode === 'link') activeId = id;
  }

  if (order.length === 0) return null;
  return { rootId: activeId || order[0], byId };
}

// Rohzustand mit Defaults zusammenführen + normalisieren (für Entwurf und Live).
function prepareState(loaded) {
  loaded = loaded || {};
  let playlists;
  if (loaded.playlists && loaded.playlists.byId) {
    playlists = normalizePlaylists(loaded.playlists);
  } else {
    const migrated = migrateLegacy(loaded);
    playlists = migrated ? normalizePlaylists(migrated) : structuredClone(DEFAULT_STATE.playlists);
  }
  let overlays;
  if (Array.isArray(loaded.overlays)) overlays = normalizeOverlays(loaded.overlays);
  else if (loaded.welcome) overlays = [overlayFromWelcome(loaded.welcome)]; // Migration aus altem welcome
  else overlays = [];
  return { playlists, overlays };
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    const s = prepareState(DEFAULT_STATE);
    saveState(s);
    return s;
  }
  try {
    return prepareState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
  } catch (err) {
    console.error('state.json konnte nicht gelesen werden, nutze Defaults:', err.message);
    return prepareState(DEFAULT_STATE);
  }
}

function loadLive() {
  if (!existsSync(LIVE_FILE)) return null;
  try {
    return prepareState(JSON.parse(readFileSync(LIVE_FILE, 'utf8')));
  } catch (err) {
    console.error('live.json konnte nicht gelesen werden:', err.message);
    return null;
  }
}

// Alle von Contents referenzierten Upload-Dateinamen einer Playlist-Registry.
function filesUsedInPlaylists(playlists) {
  const set = new Set();
  if (!playlists || !playlists.byId) return set;
  for (const pl of Object.values(playlists.byId)) {
    for (const it of pl.items) {
      const c = it.kind === 'content' ? it.content : null;
      if (c && (c.type === 'image' || c.type === 'video') && c.filename) set.add(c.filename);
    }
  }
  return set;
}

// Alle von Image-Elementen referenzierten Upload-Dateinamen.
function filesUsedInOverlays(overlays) {
  const set = new Set();
  for (const o of overlays || []) {
    for (const e of o.elements || []) if (e.type === 'image' && e.filename) set.add(e.filename);
  }
  return set;
}

// Wird eine Upload-Datei noch irgendwo (Entwurf ODER Live; Contents ODER
// Overlay-Bilder) referenziert? Verhindert das Löschen noch genutzter Dateien.
function fileInUse(filename) {
  if (!filename) return false;
  if (filesUsedInPlaylists(state.playlists).has(filename)) return true;
  if (live && filesUsedInPlaylists(live.playlists).has(filename)) return true;
  if (filesUsedInOverlays(state.overlays).has(filename)) return true;
  if (live && filesUsedInOverlays(live.overlays).has(filename)) return true;
  return false;
}

// Eine Upload-Datei löschen, falls sie nirgends mehr referenziert wird.
function cleanupFile(filename) {
  if (filename && !fileInUse(filename)) {
    try { unlinkSync(join(UPLOAD_DIR, filename)); }
    catch (err) { console.warn('Datei konnte nicht gelöscht werden:', err.message); }
  }
}

let state = loadState(); // Entwurf
let live = loadLive() || structuredClone(state); // Live (Wand)

function saveState(s = state) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function saveLive() { writeFileSync(LIVE_FILE, JSON.stringify(live, null, 2)); }

// Gibt es unveröffentlichte Änderungen?
function isDirty() { return JSON.stringify(state) !== JSON.stringify(live); }

if (!existsSync(LIVE_FILE)) saveLive();

// ---- Playlist-Helfer -------------------------------------------------------
function getPlaylist(id) { return state.playlists.byId[id]; }
function getOverlay(id) { return state.overlays.find((o) => o.id === id); }

// Erreicht `fromId` über Verschachtelung `targetId`? (für Zyklusprüfung)
function playlistReaches(fromId, targetId, seen = new Set()) {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const pl = state.playlists.byId[fromId];
  if (!pl) return false;
  for (const it of pl.items) {
    if (it.kind === 'playlist' && playlistReaches(it.refId, targetId, seen)) return true;
  }
  return false;
}

// Datei eines Contents aufräumen, falls nicht mehr referenziert.
function cleanupContentFile(content) {
  if (content && (content.type === 'image' || content.type === 'video') && content.filename) cleanupFile(content.filename);
}

// ---------------------------------------------------------------------------
// HTTP / Express
// ---------------------------------------------------------------------------
const app = express();
const server = createServer(app);

app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
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
app.get('/programm', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'programm.html'));
});
app.get('/playlists', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'playlists.html'));
});
// Abwärtskompatibel: alte Steuerseite leitet auf die Programm-Timeline.
app.get('/settings', (req, res) => res.redirect('/programm'));
app.get('/overlay', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'overlay.html'));
});

// Aktuellen Zustand holen. `?view=live` liefert den veröffentlichten Zustand.
app.get('/api/state', (req, res) => res.json(req.query.view === 'live' ? live : state));

// "Go Live": den Entwurf veröffentlichen.
app.post('/api/golive', (req, res) => {
  live = structuredClone(state);
  saveLive();
  broadcast();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Playlist-API
// ---------------------------------------------------------------------------
// Neue Playlist anlegen.
app.post('/api/playlist', (req, res) => {
  const count = Object.keys(state.playlists.byId).length + 1;
  const name = (req.body?.name || '').trim() || `Playlist ${count}`;
  const pl = { id: newId(), name, after: 'loop', nextId: null, items: [] };
  state.playlists.byId[pl.id] = pl;
  saveState();
  broadcast();
  res.json(pl);
});

// Playlist umbenennen.
app.post('/api/playlist/:id/rename', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const name = (req.body?.name || '').trim();
  if (name) pl.name = name;
  saveState();
  broadcast();
  res.json(pl);
});

// Nachfolge-Aktion setzen: { after: 'next'|'loop'|'stop', nextId? }.
app.post('/api/playlist/:id/after', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const after = req.body?.after;
  if (!['next', 'loop', 'stop'].includes(after)) return res.status(400).json({ error: 'Ungültige Aktion' });
  pl.after = after;
  if (after === 'next') {
    const nextId = req.body?.nextId;
    pl.nextId = (typeof nextId === 'string' && state.playlists.byId[nextId]) ? nextId : null;
    if (!pl.nextId) pl.after = 'loop'; // ohne Ziel kein 'next'
  } else {
    pl.nextId = null;
  }
  saveState();
  broadcast();
  res.json(pl);
});

// Start-Playlist (Wurzel) setzen.
app.post('/api/playlist/root', (req, res) => {
  const id = req.body?.id;
  if (!id || !state.playlists.byId[id]) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  state.playlists.rootId = id;
  saveState();
  broadcast();
  res.json({ ok: true, rootId: id });
});

// Playlist löschen (Dateien ihrer Contents aufräumen; Referenzen säubern).
app.delete('/api/playlist/:id', (req, res) => {
  const id = req.params.id;
  const pl = getPlaylist(id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  if (Object.keys(state.playlists.byId).length <= 1) {
    return res.status(400).json({ error: 'Mindestens eine Playlist erforderlich' });
  }
  delete state.playlists.byId[id];
  // Referenzen aus anderen Playlists entfernen (Items + nextId).
  for (const other of Object.values(state.playlists.byId)) {
    other.items = other.items.filter((it) => it.kind !== 'playlist' || it.refId !== id);
    if (other.nextId === id) { other.nextId = null; if (other.after === 'next') other.after = 'loop'; }
  }
  if (state.playlists.rootId === id) {
    state.playlists.rootId = Object.keys(state.playlists.byId)[0];
  }
  // Dateien der gelöschten Playlist aufräumen.
  for (const it of pl.items) if (it.kind === 'content') cleanupContentFile(it.content);
  saveState();
  broadcast();
  res.json({ ok: true });
});

// Item (Content oder Sub-Playlist) zu einer Playlist hinzufügen.
// Body: { kind:'content', content:{...} } oder { kind:'playlist', refId, index? }.
app.post('/api/playlist/:id/items', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const body = req.body || {};
  let item;
  if (body.kind === 'playlist') {
    const refId = body.refId;
    if (!refId || !state.playlists.byId[refId]) return res.status(400).json({ error: 'Ziel-Playlist fehlt' });
    if (refId === pl.id || playlistReaches(refId, pl.id)) {
      return res.status(400).json({ error: 'Verschachtelung würde einen Zyklus erzeugen' });
    }
    item = { id: newId(), kind: 'playlist', refId };
  } else {
    item = { id: newId(), kind: 'content', content: normalizeContent(body.content) };
  }
  const index = Number.isInteger(body.index) ? Math.max(0, Math.min(pl.items.length, body.index)) : pl.items.length;
  pl.items.splice(index, 0, item);
  saveState();
  broadcast();
  res.json(item);
});

// Content-Felder eines Items ändern (z. B. Farbe, Dauer, mute, crop, name).
app.patch('/api/playlist/:id/items/:itemId', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const item = pl.items.find((i) => i.id === req.params.itemId);
  if (!item || item.kind !== 'content') return res.status(404).json({ error: 'Content nicht gefunden' });
  const patch = (req.body?.content && typeof req.body.content === 'object') ? req.body.content : {};
  // Typ bleibt erhalten, falls nicht ausdrücklich (und gültig) geändert.
  item.content = normalizeContent({ ...item.content, ...patch, type: item.content.type });
  saveState();
  broadcast();
  res.json(item);
});

// Item entfernen (Datei aufräumen, falls Content-Bild/Video & ungenutzt).
app.delete('/api/playlist/:id/items/:itemId', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const idx = pl.items.findIndex((i) => i.id === req.params.itemId);
  if (idx === -1) return res.status(404).json({ error: 'Item nicht gefunden' });
  const [removed] = pl.items.splice(idx, 1);
  saveState(); // erst speichern, damit fileInUse den neuen Zustand sieht
  if (removed.kind === 'content') cleanupContentFile(removed.content);
  broadcast();
  res.json({ ok: true });
});

// Reihenfolge der Items setzen. Body: { order: [itemId, ...] }.
app.post('/api/playlist/:id/items/order', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order fehlt' });
  const byId = new Map(pl.items.map((it) => [it.id, it]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  for (const it of pl.items) if (!order.includes(it.id)) reordered.push(it);
  pl.items = reordered;
  saveState();
  broadcast();
  res.json(pl);
});

// --- Systemlautstärke (wpctl) ----------------------------------------------
function wpctl(args) {
  return new Promise((resolve, reject) => {
    execFile('wpctl', args, { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout);
    });
  });
}
async function readVolume() {
  const out = await wpctl(['get-volume', AUDIO_SINK]);
  const m = out.match(/Volume:\s*([\d.]+)/);
  return { level: m ? parseFloat(m[1]) : null, muted: /\[MUTED\]/i.test(out) };
}
app.get('/api/volume', async (req, res) => {
  try { res.json(await readVolume()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/volume', async (req, res) => {
  const body = req.body || {};
  try {
    if (typeof body.level === 'number') {
      const level = Math.min(1, Math.max(0, body.level));
      await wpctl(['set-volume', AUDIO_SINK, level.toFixed(2)]);
    }
    if (body.mute !== undefined) {
      const arg = body.mute === 'toggle' ? 'toggle' : (body.mute ? '1' : '0');
      await wpctl(['set-mute', AUDIO_SINK, arg]);
    }
    res.json(await readVolume());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Upload (Bild/Video-Content) -------------------------------------------
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, `${newId()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('Nur Bilder und Videos erlaubt'), ok);
  }
});

// Datei hochladen und als Content-Item an eine Playlist anhängen.
// Form-Feld `playlistId` bestimmt das Ziel.
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen' });
  const pl = getPlaylist(req.body.playlistId);
  if (!pl) {
    try { unlinkSync(join(UPLOAD_DIR, req.file.filename)); } catch (_) {}
    return res.status(400).json({ error: 'Playlist nicht gefunden' });
  }
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const item = {
    id: newId(), kind: 'content',
    content: normalizeContent({ type, filename: req.file.filename, name: req.file.originalname })
  };
  pl.items.push(item);
  saveState();
  broadcast();
  res.json(item);
});

// --- Webseiten-Content: Einbettbarkeit prüfen + an Playlist anhängen --------
async function checkEmbeddable(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: ctrl.signal,
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
      if (/'none'/.test(val) || (!val.includes('*') && !/https?:/.test(val))) {
        return { embeddable: false, reason: `CSP frame-ancestors: ${val}` };
      }
    }
    return { embeddable: true, reason: '' };
  } catch (err) {
    return { embeddable: null, reason: 'Prüfung fehlgeschlagen: ' + err.message };
  }
}

// Webseiten-Content hinzufügen. Body: { url, playlistId }.
app.post('/api/link', async (req, res) => {
  try {
    const url = (req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Ungültige URL' });
    const pl = getPlaylist(req.body?.playlistId);
    if (!pl) return res.status(400).json({ error: 'Playlist nicht gefunden' });
    const { embeddable, reason } = await checkEmbeddable(url);
    const item = {
      id: newId(), kind: 'content',
      content: normalizeContent({ type: 'webpage', url, name: url, embeddable, reason })
    };
    pl.items.push(item);
    saveState();
    broadcast();
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Einbettbarkeit eines vorhandenen Webseiten-Contents neu prüfen.
// Body: { playlistId, itemId }.
app.post('/api/link/recheck', async (req, res) => {
  try {
    const pl = getPlaylist(req.body?.playlistId);
    const item = pl && pl.items.find((i) => i.id === req.body?.itemId);
    if (!item || item.kind !== 'content' || item.content.type !== 'webpage') {
      return res.status(404).json({ error: 'Webseiten-Content nicht gefunden' });
    }
    const { embeddable, reason } = await checkEmbeddable(item.content.url);
    item.content.embeddable = embeddable;
    item.content.reason = reason;
    saveState();
    broadcast();
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Overlay-API (mehrere Zeit-Clips über dem Content)
// ---------------------------------------------------------------------------
app.post('/api/overlay', (req, res) => {
  const name = (req.body?.name || '').trim() || `Overlay ${state.overlays.length + 1}`;
  const o = normalizeOverlay({ name, enabled: true, start: 0, duration: null, elements: [] });
  state.overlays.push(o);
  saveState();
  broadcast();
  res.json(o);
});

// Overlay-Felder ändern: name/enabled/start/duration/blur.
app.patch('/api/overlay/:id', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const p = req.body || {};
  if (typeof p.name === 'string' && p.name.trim()) o.name = p.name.trim();
  if (typeof p.enabled === 'boolean') o.enabled = p.enabled;
  if (typeof p.start === 'number' && p.start >= 0) o.start = p.start;
  if ('duration' in p) o.duration = (typeof p.duration === 'number' && p.duration > 0) ? p.duration : null;
  if (typeof p.blur === 'number' && p.blur >= 0) o.blur = p.blur;
  saveState();
  broadcast();
  res.json(o);
});

app.delete('/api/overlay/:id', (req, res) => {
  const i = state.overlays.findIndex((o) => o.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const [removed] = state.overlays.splice(i, 1);
  saveState();
  for (const e of removed.elements) if (e.type === 'image' && e.filename) cleanupFile(e.filename);
  broadcast();
  res.json({ ok: true });
});

// Z-Ordnung der Overlays. Body: { order: [overlayId, ...] }.
app.post('/api/overlays/order', (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order fehlt' });
  const byId = new Map(state.overlays.map((o) => [o.id, o]));
  const re = order.map((id) => byId.get(id)).filter(Boolean);
  for (const o of state.overlays) if (!order.includes(o.id)) re.push(o);
  state.overlays = re;
  saveState();
  broadcast();
  res.json({ ok: true });
});

// Element hinzufügen. Body: { element: {...} } oder direkt die Element-Felder.
app.post('/api/overlay/:id/element', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const el = normalizeElement(req.body?.element || req.body || {});
  el.id = newId();
  o.elements.push(el);
  saveState();
  broadcast();
  res.json(el);
});

// Element ändern (inkl. Position x/y/w/h, Typfelder, source). Typ bleibt erhalten.
app.patch('/api/overlay/:id/element/:eid', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const el = o.elements.find((e) => e.id === req.params.eid);
  if (!el) return res.status(404).json({ error: 'Element nicht gefunden' });
  const patch = (req.body?.element && typeof req.body.element === 'object') ? req.body.element : (req.body || {});
  const oldFile = el.type === 'image' ? el.filename : null;
  const merged = normalizeElement({ ...el, ...patch, type: el.type, id: el.id });
  Object.assign(el, merged);
  saveState();
  if (oldFile && oldFile !== el.filename) cleanupFile(oldFile);
  broadcast();
  res.json(el);
});

app.delete('/api/overlay/:id/element/:eid', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const i = o.elements.findIndex((e) => e.id === req.params.eid);
  if (i === -1) return res.status(404).json({ error: 'Element nicht gefunden' });
  const [removed] = o.elements.splice(i, 1);
  saveState();
  if (removed.type === 'image' && removed.filename) cleanupFile(removed.filename);
  broadcast();
  res.json({ ok: true });
});

app.post('/api/overlay/:id/elements/order', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order fehlt' });
  const byId = new Map(o.elements.map((e) => [e.id, e]));
  const re = order.map((id) => byId.get(id)).filter(Boolean);
  for (const e of o.elements) if (!order.includes(e.id)) re.push(e);
  o.elements = re;
  saveState();
  broadcast();
  res.json({ ok: true });
});

// Bild für ein Image-Element hochladen.
app.post('/api/overlay/:id/element/:eid/image', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen' });
  const o = getOverlay(req.params.id);
  const el = o && o.elements.find((e) => e.id === req.params.eid);
  if (!el || el.type !== 'image') {
    try { unlinkSync(join(UPLOAD_DIR, req.file.filename)); } catch (_) {}
    return res.status(404).json({ error: 'Bild-Element nicht gefunden' });
  }
  const old = el.filename;
  el.filename = req.file.filename;
  el.url = '';
  saveState();
  if (old && old !== el.filename) cleanupFile(old);
  broadcast();
  res.json(el);
});

// --- QR-Code als SVG (offline via qrcode-Paket) -----------------------------
app.get('/api/qr', async (req, res) => {
  const data = (req.query.data || '').toString();
  if (!data) return res.status(400).send('data fehlt');
  const dark = (req.query.fg || '#000000').toString();
  const light = (req.query.bg || '#ffffff').toString();
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, color: { dark, light } });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(svg);
  } catch (_) {
    res.status(500).send('QR-Fehler');
  }
});

// --- Externer Abruf-Proxy (für dynamische Elemente; umgeht CORS) ------------
// Phase-1-Grundgerüst für Wetter/Newsfeeds. Vollständige API folgt in Phase 2.
app.get('/api/fetch', async (req, res) => {
  const url = (req.query.url || '').toString();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Ungültige URL' });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Screenwall' } });
    clearTimeout(timer);
    const ct = (r.headers.get('content-type') || 'text/plain').toLowerCase();
    const body = await r.text();
    res.set('Content-Type', ct.includes('json') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  } catch (_) {
    res.status(502).json({ error: 'Abruf fehlgeschlagen' });
  }
});

// ---------------------------------------------------------------------------
// WebSocket – Live-Broadcast des Zustands
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

function broadcast() {
  const draftMsg = JSON.stringify({ type: 'state', state, dirty: isDirty() });
  const liveMsg = JSON.stringify({ type: 'state', state: live });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(client.isWall ? liveMsg : draftMsg);
  }
}

let liveNowPlaying = null; // Was läuft gerade auf der echten Wand?

wss.on('connection', (ws, req) => {
  let role = '';
  try { role = new URL(req.url, 'http://x').searchParams.get('role') || ''; } catch (_) {}
  ws.role = role;
  ws.isWall = role !== 'preview' && role !== 'control';

  ws.send(ws.isWall
    ? JSON.stringify({ type: 'state', state: live })
    : JSON.stringify({ type: 'state', state, dirty: isDirty() }));
  if ((ws.role === 'control' || ws.role === 'monitor') && liveNowPlaying) {
    ws.send(JSON.stringify({ type: 'cmd', cmd: 'nowplaying', ...liveNowPlaying }));
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg || msg.type !== 'cmd') return;

    if (msg.cmd === 'nowplaying') {
      if (ws.isWall && ws.role !== 'monitor') {
        const { type, ...rest } = msg;
        liveNowPlaying = rest;
        const out = JSON.stringify(msg);
        for (const client of wss.clients) {
          if ((client.role === 'control' || client.role === 'monitor')
            && client.readyState === client.OPEN) client.send(out);
        }
      }
      return;
    }

    const out = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.isWall === ws.isWall && client.readyState === client.OPEN) client.send(out);
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
