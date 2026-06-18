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
const THUMB_DIR = join(__dirname, '.thumbs'); // gecachte Video-Keyframes (ffmpeg)
const PUBLIC_DIR = join(__dirname, 'public');

// Audio-Ziel für die Lautstärkesteuerung (PipeWire/WirePlumber via wpctl).
const AUDIO_SINK = process.env.AUDIO_SINK || '@DEFAULT_AUDIO_SINK@';

if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
if (!existsSync(THUMB_DIR)) mkdirSync(THUMB_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Zustands-Modell
// ---------------------------------------------------------------------------
const CONTENT_TYPES = ['color', 'image', 'video', 'youtube', 'webpage', 'screenshare'];
// Overlay-Elementtypen (liegen ÜBER dem Content; frei auf dem Ausgabe-Canvas platziert).
const ELEMENT_TYPES = ['text', 'image', 'qr', 'shape'];

const DEFAULT_STATE = {
  // Playlists als flache Registry (byId) + Wurzel-Playlist (rootId).
  playlists: {
    rootId: 'pl-default',
    byId: {
      'pl-default': { id: 'pl-default', name: 'Playlist 1', after: 'loop', nextId: null, items: [] }
    }
  },
  // Overlays: mehrere Zeit-Clips über dem Content (Array = Z-Ordnung, 0 = unten).
  overlays: [],
  // Wiederverwertbare Element-Vorlagen (Flächen/Texte/Bilder, einzeln oder als Gruppe).
  library: []
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
  // Gemessene Gesamtlänge (Upload: ffprobe, YouTube: Watch-Seite) – für Timeline-
  // Breite/Layout & Keyframes. Auch für YouTube behalten, damit das Scrubboard die
  // echte Länge kennt (sonst Fallback auf 30 s pro Block).
  if ((type === 'video' || type === 'youtube') && typeof c.videoDuration === 'number' && c.videoDuration > 0) out.videoDuration = c.videoDuration;
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
      items,
      overlayClips: Array.isArray(pl.overlayClips) ? pl.overlayClips.map(normalizeOverlayClip).filter((c) => c.overlayId) : []
    };
  }
  if (Object.keys(byId).length === 0) {
    byId['pl-default'] = { id: 'pl-default', name: 'Playlist 1', after: 'loop', nextId: null, items: [], overlayClips: [] };
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

// Gemeinsamer Flächen-Stil (für Shape-Elemente und als Hintergrund von Text):
// Deckkraft der Füllung, Rand (an/aus, Breite, Farbe), Blur (Hintergrund „frosted glass"
// oder Eigen-Weichzeichnung), Eckenradius (px) und Innenabstand (Anteil der Elementhöhe).
function normalizeSurface(e) {
  const b = (e && typeof e.border === 'object') ? e.border : {};
  return {
    fillOpacity: clamp01(e.fillOpacity, 1),
    border: {
      enabled: !!b.enabled,
      width: (typeof b.width === 'number' && b.width >= 0) ? b.width : 4,
      color: typeof b.color === 'string' ? b.color : '#000000'
    },
    blur: (typeof e.blur === 'number' && e.blur >= 0) ? e.blur : 0,
    blurMode: e.blurMode === 'self' ? 'self' : 'backdrop',
    radius: (typeof e.radius === 'number' && e.radius >= 0) ? e.radius : 0,
    pad: (typeof e.pad === 'number' && e.pad >= 0) ? Math.min(0.5, e.pad) : 0
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
    out.bg = typeof e.bg === 'string' ? e.bg : '';            // '' = transparent (Füllfarbe der Fläche)
    out.align = ['left', 'center', 'right'].includes(e.align) ? e.align : 'center';
    out.weight = typeof e.weight === 'number' ? e.weight : 700;
    out.fontFrac = (typeof e.fontFrac === 'number' && e.fontFrac > 0) ? e.fontFrac : 0.5; // Anteil der Elementhöhe
    Object.assign(out, normalizeSurface(e)); // Flächen-Stil hinter dem Text (Rand/Radius/Blur/Deckkraft)
  } else if (type === 'image') {
    out.filename = typeof e.filename === 'string' ? e.filename : null;
    out.url = typeof e.url === 'string' ? e.url : '';
    out.fit = e.fit === 'cover' ? 'cover' : 'contain';
  } else if (type === 'qr') {
    out.data = typeof e.data === 'string' ? e.data : '';
    out.fg = typeof e.fg === 'string' ? e.fg : '#000000';
    out.bg = typeof e.bg === 'string' ? e.bg : '#ffffff';
  } else if (type === 'shape') {
    out.shape = e.shape === 'circle' ? 'circle' : 'rect';
    out.fill = typeof e.fill === 'string' ? e.fill : '#ffffff';
    Object.assign(out, normalizeSurface(e));
  }
  return out;
}

// Bibliothek: wiederverwertbare Vorlagen – ein Einzelelement oder eine Gruppe von
// Elementen (mit ihren relativen Positionen). Bilder referenzieren wie gehabt uploads/.
function normalizeLibEntry(en) {
  en = (en && typeof en === 'object') ? en : {};
  const kind = en.kind === 'group' ? 'group' : 'element';
  const out = {
    id: typeof en.id === 'string' ? en.id : newId(),
    name: (typeof en.name === 'string' && en.name.trim()) ? en.name.trim() : (kind === 'group' ? 'Gruppe' : 'Element'),
    kind
  };
  if (kind === 'group') out.elements = Array.isArray(en.elements) ? en.elements.map(normalizeElement) : [];
  else out.element = normalizeElement(en.element || {});
  return out;
}
function normalizeLibrary(arr) { return Array.isArray(arr) ? arr.map(normalizeLibEntry) : []; }

// Overlay = wiederverwendbarer Inhalt (kein eigenes Scheduling mehr). Die Anzeige-
// Zeitfenster liegen als "overlayClips" pro Playlist (mehrere je Overlay möglich).
function normalizeOverlay(o) {
  o = (o && typeof o === 'object') ? o : {};
  return {
    id: typeof o.id === 'string' ? o.id : newId(),
    name: typeof o.name === 'string' ? o.name : 'Overlay',
    blur: (typeof o.blur === 'number' && o.blur >= 0) ? o.blur : 0,
    elements: Array.isArray(o.elements) ? o.elements.map(normalizeElement) : []
  };
}
function normalizeOverlays(arr) { return Array.isArray(arr) ? arr.map(normalizeOverlay) : []; }

// Ein Overlay-Clip (Anzeigefenster eines Overlays in einer Playlist).
function normalizeOverlayClip(c) {
  c = (c && typeof c === 'object') ? c : {};
  return {
    id: typeof c.id === 'string' ? c.id : newId(),
    overlayId: typeof c.overlayId === 'string' ? c.overlayId : '',
    enabled: c.enabled !== false,
    start: (typeof c.start === 'number' && c.start >= 0) ? c.start : 0,
    duration: (typeof c.duration === 'number' && c.duration > 0) ? c.duration : null // null = bis Programmende
  };
}

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
  const rawOverlays = Array.isArray(loaded.overlays) ? loaded.overlays : [];
  if (rawOverlays.length) overlays = normalizeOverlays(rawOverlays);
  else if (loaded.welcome) { // Migration aus altem welcome
    const wov = overlayFromWelcome(loaded.welcome);
    overlays = [wov];
    const root = playlists.byId[playlists.rootId];
    if (root) root.overlayClips.push(normalizeOverlayClip({ overlayId: wov.id, enabled: loaded.welcome.visible !== false, start: 0, duration: null }));
  } else overlays = [];
  // Migration alt->neu: Overlays mit eigenem Scheduling (start/duration/enabled) bekommen
  // je einen Clip an der Root-Playlist (idempotent: nur wenn noch kein Clip existiert).
  migrateOverlayWindows(playlists, rawOverlays);
  const library = normalizeLibrary(loaded.library);
  return { playlists, overlays, library };
}

// Bestehende (alt-modellierte) Overlay-Zeitfenster in Playlist-Clips überführen.
function migrateOverlayWindows(playlists, rawOverlays) {
  const root = playlists.byId[playlists.rootId];
  if (!root) return;
  const clipped = new Set();
  for (const pl of Object.values(playlists.byId)) for (const c of (pl.overlayClips || [])) clipped.add(c.overlayId);
  for (const ro of rawOverlays) {
    if (!ro || typeof ro !== 'object' || typeof ro.id !== 'string') continue;
    const hasSched = ('start' in ro) || ('duration' in ro) || ('enabled' in ro);
    if (!hasSched || clipped.has(ro.id)) continue;
    root.overlayClips.push(normalizeOverlayClip({ overlayId: ro.id, enabled: ro.enabled, start: ro.start, duration: ro.duration }));
    clipped.add(ro.id);
  }
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

// Image-Dateien, die von Bibliotheks-Vorlagen (einzeln oder Gruppe) referenziert werden.
function filesUsedInLibrary(library) {
  const set = new Set();
  for (const en of library || []) {
    const els = en.kind === 'group' ? (en.elements || []) : (en.element ? [en.element] : []);
    for (const e of els) if (e.type === 'image' && e.filename) set.add(e.filename);
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
  if (filesUsedInLibrary(state.library).has(filename)) return true;
  if (live && filesUsedInLibrary(live.library).has(filename)) return true;
  return false;
}

// Eine Upload-Datei löschen, falls sie nirgends mehr referenziert wird.
function cleanupFile(filename) {
  if (filename && !fileInUse(filename)) {
    try { unlinkSync(join(UPLOAD_DIR, filename)); }
    catch (err) { console.warn('Datei konnte nicht gelöscht werden:', err.message); }
  }
}

// Videolänge per ffprobe ermitteln (Sekunden; 0 bei Fehler).
function probeDuration(filename) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', join(UPLOAD_DIR, filename)],
      { timeout: 15000 }, (err, stdout) => {
        const d = parseFloat((stdout || '').trim());
        resolve(isFinite(d) && d > 0 ? d : 0);
      });
  });
}

// YouTube-Metadaten ohne API-Key: Watch-Seite einmal laden und sowohl Länge
// ("lengthSeconds") als auch das Storyboard (Scrubbing-Vorschaubilder) parsen.
// Ergebnis { duration, storyboard } je videoId cachen (kleines Objekt, nicht das HTML).
const ytMetaCache = new Map();
const MAX_SB_SHEETS = 12; // Obergrenze Sprite-Sheets pro Video (Requests begrenzen)

// Storyboard-Spec (storyboard3) parsen und das beste Level wählen.
// Spec: baseUrl|lvl0|lvl1|… ; lvlN = w#h#frames#cols#rows#interval#name#sigh
function parseStoryboard(spec, duration) {
  const parts = spec.split('|');
  const base = parts[0];
  const levels = parts.slice(1).map((p, i) => {
    const a = p.split('#');
    const [w, h, frames, cols, rows, interval] = a.map(Number);
    const name = a[6], sigh = a[7];
    const tmpl = base.replace('$L', String(i)).replace('$N', name) + '&sigh=' + sigh;
    const perSheet = cols * rows;
    return { w, h, frames, cols, rows, interval, perSheet, sheets: Math.ceil(frames / perSheet), tmpl };
  }).filter((l) => l.frames > 0 && l.cols > 0 && l.rows > 0);
  if (!levels.length) return null;
  // Bevorzugt feste Intervalle mit möglichst vielen Frames, aber begrenzter Sheet-Zahl;
  // sonst das Übersichtslevel (interval 0 = 100 Frames gleichmäßig, 1 Sheet).
  const fixed = levels.filter((l) => l.interval > 0 && l.sheets <= MAX_SB_SHEETS);
  const best = fixed.sort((a, b) => (b.frames - a.frames) || (a.sheets - b.sheets))[0] || levels[0];
  const sheets = [];
  for (let s = 0; s < best.sheets; s++) sheets.push(best.tmpl.replace('$M', String(s)));
  return {
    w: best.w, h: best.h, cols: best.cols, rows: best.rows, frames: best.frames,
    intervalMs: best.interval, duration, sheets
  };
}

async function loadYtMeta(videoId) {
  if (!videoId || !/^[\w-]{6,}$/.test(videoId)) return { duration: 0, storyboard: null };
  if (ytMetaCache.has(videoId)) return ytMetaCache.get(videoId);
  let duration = 0, storyboard = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    clearTimeout(timer);
    const html = await r.text();
    let m = html.match(/"lengthSeconds":"(\d+)"/);
    if (m) duration = parseInt(m[1], 10);
    if (!duration) {
      const m2 = html.match(/itemprop="duration"\s+content="PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/);
      if (m2) duration = (parseInt(m2[1] || 0, 10) * 3600) + (parseInt(m2[2] || 0, 10) * 60) + parseInt(m2[3] || 0, 10);
    }
    duration = isFinite(duration) && duration > 0 ? duration : 0;
    const sb = html.match(/"playerStoryboardSpecRenderer":\{"spec":"([^"]+)"/);
    if (sb) { try { storyboard = parseStoryboard(sb[1].replace(/\\u0026/g, '&'), duration); } catch (_) {} }
  } catch (_) { /* Netzwerk-/Parsefehler: 0/null zurückgeben */ }
  const meta = { duration, storyboard };
  if (duration > 0 || storyboard) ytMetaCache.set(videoId, meta); // nur Treffer cachen
  return meta;
}
async function probeYouTubeDuration(videoId) {
  return (await loadYtMeta(videoId)).duration;
}

// Echte Gesamtlänge eines Content-Objekts ermitteln (nur für "end"-Modus relevant).
async function contentDuration(c) {
  if (!c) return 0;
  if (c.type === 'video' && c.filename) return probeDuration(c.filename);
  if (c.type === 'youtube' && c.videoId) return probeYouTubeDuration(c.videoId);
  return 0;
}

// Fehlende videoDuration für alle Video/YouTube-Items (Modus "end") nachtragen.
// Schreibt nur bei Änderungen (saveState + broadcast). Reentrancy-Guard verhindert
// parallele Doppelläufe. Liefert die Anzahl aktualisierter Items.
let ensuringDurations = false;
async function ensureDurations() {
  if (ensuringDurations) return 0;
  ensuringDurations = true;
  let updated = 0;
  try {
    const byId = state.playlists?.byId || {};
    for (const pl of Object.values(byId)) {
      for (const it of (pl.items || [])) {
        const c = it.kind === 'content' ? it.content : null;
        if (!c || (c.type !== 'video' && c.type !== 'youtube')) continue;
        if (c.videoMode === 'duration') continue;
        if (typeof c.videoDuration === 'number' && c.videoDuration > 0) continue;
        const d = await contentDuration(c);
        if (d > 0) { c.videoDuration = d; updated++; }
      }
    }
    if (updated) { saveState(); broadcast(); }
  } finally {
    ensuringDurations = false;
  }
  return updated;
}

let state = loadState(); // Entwurf
let live = loadLive() || structuredClone(state); // Live (Wand)
// "Off Air": die Wand wird komplett gestoppt (schwarz). Separat gehalten, damit es
// isDirty() nicht beeinflusst; in live.json als Extra-Schlüssel persistiert.
let offAir = false;
try { if (existsSync(LIVE_FILE)) offAir = !!JSON.parse(readFileSync(LIVE_FILE, 'utf8')).offair; } catch (_) {}

function saveState(s = state) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function saveLive() { writeFileSync(LIVE_FILE, JSON.stringify({ ...live, offair: offAir }, null, 2)); }

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

// ---- Programm-Helfer (serverseitig; Spiegel der Client-Logik) --------------
const NOMINAL_END = 30; // angenommene Dauer für "bis Ende"-Videos ohne bekannte Länge

// Playlist rekursiv ausflachen (verschachtelte Playlists inline; Zyklen via visited).
function flattenPlaylist(plId, byId, visited = new Set()) {
  const pl = byId[plId];
  if (!pl || visited.has(plId)) return [];
  const v = new Set(visited); v.add(plId);
  const out = [];
  for (const it of pl.items) {
    if (it.kind === 'content') out.push({ itemId: it.id, content: it.content });
    else if (it.kind === 'playlist') out.push(...flattenPlaylist(it.refId, byId, v));
  }
  return out;
}
function itemDur(c) {
  if ((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration') return c.videoDuration || NOMINAL_END;
  return Math.max(1, c.durationSec || 6);
}
// Block-Layout mit Startzeiten + Gesamtdauer für eine Playlist.
function programEntries(plId, byId = state.playlists.byId) {
  const flat = flattenPlaylist(plId, byId);
  let acc = 0;
  const entries = flat.map((e) => { const dur = itemDur(e.content); const o = { itemId: e.itemId, content: e.content, start: acc, dur }; acc += dur; return o; });
  return { entries, total: acc };
}
// Programmzeit t -> { itemId, offset, progTime } (letzter Block, falls über das Ende hinaus).
function entryAtProgTime(entries, t) {
  t = Math.max(0, t || 0);
  if (!entries.length) return null;
  for (const b of entries) if (t >= b.start && t < b.start + b.dur) return { itemId: b.itemId, offset: t - b.start, progTime: t };
  const last = entries[entries.length - 1];
  return { itemId: last.itemId, offset: Math.max(0, t - last.start), progTime: t };
}
// Element über alle Overlays eines States finden.
function findElement(eid, root = state) {
  for (const o of (root.overlays || [])) {
    const el = (o.elements || []).find((e) => e.id === eid);
    if (el) return { overlay: o, element: el };
  }
  return null;
}
// Overlays einer Playlist (aufgelöst aus ihren Clips), je Overlay mit Zeitfenstern.
function overlaysOfPlaylist(pl, root = state) {
  const byOv = new Map();
  for (const c of (pl.overlayClips || [])) {
    const ov = (root.overlays || []).find((o) => o.id === c.overlayId);
    if (!ov) continue;
    if (!byOv.has(ov.id)) byOv.set(ov.id, { overlayId: ov.id, name: ov.name, windows: [] });
    byOv.get(ov.id).windows.push({ clipId: c.id, start: c.start, end: c.duration == null ? null : c.start + c.duration, enabled: c.enabled });
  }
  return [...byOv.values()];
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

// "Go Live": den Entwurf veröffentlichen. Optional `{ goto: { itemId, time, progTime } }`,
// damit die Wand ab der Cursor-/Playhead-Position der Programm-Timeline weiterläuft.
app.post('/api/golive', (req, res) => {
  live = structuredClone(state);
  offAir = false; // Veröffentlichen heißt: wieder auf Sendung
  saveLive();
  broadcast();
  const g = req.body && req.body.goto;
  if (g && typeof g.itemId === 'string') {
    sendToWall({ type: 'cmd', cmd: 'goto', itemId: g.itemId, time: g.time || 0, progTime: g.progTime || 0 });
    // Cache sofort auf die neue Position setzen, damit neu verbindende Monitore
    // (z. B. der Live-Mirror nach Go Live) direkt richtig einsteigen und nicht die
    // alte Position spiegeln, bis der nächste Wand-Heartbeat eintrifft.
    liveNowPlaying = { cmd: 'nowplaying', contentId: g.itemId, time: g.time || 0, progTime: g.progTime || 0 };
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Control-API (externe Steuerung: Playlists / Play / Status / Elemente)
// ---------------------------------------------------------------------------

// Alle Playlists als JSON-Übersicht (mit Gesamtdauer + Aktiv-Flag).
app.get('/api/playlists', (req, res) => {
  const pls = state.playlists;
  const list = Object.values(pls.byId).map((pl) => {
    const { total } = programEntries(pl.id);
    return { id: pl.id, name: pl.name, active: pl.id === pls.rootId, itemCount: pl.items.length, totalSec: Math.round(total), after: pl.after, nextId: pl.nextId, overlays: overlaysOfPlaylist(pl) };
  });
  res.json({ rootId: pls.rootId, playlists: list });
});

// Eine Playlist inkl. ausgeflachter Inhalte (mit Start/Dauer je Block).
app.get('/api/playlists/:id', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const { entries, total } = programEntries(pl.id);
  res.json({
    id: pl.id, name: pl.name, active: pl.id === state.playlists.rootId, after: pl.after, nextId: pl.nextId, totalSec: Math.round(total),
    items: entries.map((e) => ({ itemId: e.itemId, type: e.content.type, name: e.content.name || e.content.videoId || e.content.url || e.content.type, start: Math.round(e.start), dur: Math.round(e.dur) })),
    overlays: overlaysOfPlaylist(pl)
  });
});

// Playlist anlegen und optional gleich mit Inhalten befüllen.
// Body: { name?, items?: [ <content> ] } – content wie von normalizeContent erwartet.
app.post('/api/playlists', async (req, res) => {
  const b = req.body || {};
  const count = Object.keys(state.playlists.byId).length + 1;
  const name = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim() : `Playlist ${count}`;
  const pl = { id: newId(), name, after: 'loop', nextId: null, items: [] };
  for (const raw of (Array.isArray(b.items) ? b.items : [])) {
    const content = normalizeContent(raw);
    if ((content.type === 'youtube' || content.type === 'video') && content.videoMode !== 'duration' && !(content.videoDuration > 0)) {
      try { const d = await contentDuration(content); if (d > 0) content.videoDuration = d; } catch (_) {}
    }
    pl.items.push({ id: newId(), kind: 'content', content });
  }
  state.playlists.byId[pl.id] = pl;
  saveState();
  broadcast();
  res.json(pl);
});

// Eine Playlist sofort übertragen – optional ab Sekunde (time) oder Prozent (percent).
app.post('/api/play', (req, res) => {
  const b = req.body || {};
  const pl = getPlaylist(b.playlistId);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const { entries, total } = programEntries(pl.id);
  let t = 0;
  if (typeof b.percent === 'number') t = Math.max(0, Math.min(100, b.percent)) / 100 * total;
  else if (typeof b.time === 'number') t = Math.max(0, b.time);
  const e = entryAtProgTime(entries, t);
  // Programm auf diese Playlist stellen und sofort veröffentlichen (Live-Preview folgt).
  state.playlists.rootId = pl.id;
  live = structuredClone(state);
  offAir = false;
  saveState(); saveLive();
  broadcast();
  if (e) {
    sendToWall({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset, progTime: e.progTime });
    liveNowPlaying = { cmd: 'nowplaying', contentId: e.itemId, time: e.offset, progTime: e.progTime };
  }
  res.json({ ok: true, playlistId: pl.id, progTime: Math.round(t), totalSec: Math.round(total), itemId: e ? e.itemId : null, offset: e ? Math.round(e.offset) : 0 });
});

// Status: was läuft gerade, wie lange noch, welche Overlays aktiv.
app.get('/api/status', (req, res) => {
  const pls = live.playlists;
  const root = pls.byId[pls.rootId];
  const { entries, total } = programEntries(pls.rootId, pls.byId);
  const np = liveNowPlaying || {};
  const progTime = typeof np.progTime === 'number' ? np.progTime : 0;
  const cur = entries.find((x) => x.itemId === np.contentId) || null;
  const itemDuration = np.duration || (cur ? cur.dur : 0);
  const itemElapsed = np.time || 0;
  const name = cur ? (cur.content.name || cur.content.videoId || cur.content.url || cur.content.type) : null;
  const overlaysActive = ((root && root.overlayClips) || [])
    .filter((c) => c.enabled !== false && progTime >= (c.start || 0) && (c.duration == null || progTime < (c.start || 0) + c.duration))
    .map((c) => { const ov = (live.overlays || []).find((o) => o.id === c.overlayId); return { clipId: c.id, overlayId: c.overlayId, name: ov ? ov.name : null }; });
  res.json({
    offair: offAir,
    playlist: root ? { id: root.id, name: root.name } : null,
    now: np.contentId ? {
      contentId: np.contentId, type: np.ctype || (cur && cur.content.type) || null, name, videoId: np.videoId || null,
      itemDuration: Math.round(itemDuration), itemElapsed: Math.round(itemElapsed), itemRemaining: Math.max(0, Math.round(itemDuration - itemElapsed))
    } : null,
    program: { time: Math.round(progTime), totalSec: Math.round(total), remainingSec: Math.max(0, Math.round(total - progTime)), percent: total > 0 ? Math.round(progTime / total * 100) : 0 },
    overlaysActive
  });
});

// Overlays als JSON (inkl. Element-IDs für die Live-Befüllung via POST /api/element/:eid).
app.get('/api/overlays', (req, res) => {
  res.json({
    overlays: (state.overlays || []).map((o) => ({
      id: o.id, name: o.name, blur: o.blur,
      elements: (o.elements || []).map((e) => ({ id: e.id, type: e.type, text: e.text, url: e.url, filename: e.filename, data: e.data }))
    }))
  });
});

// Element live mit Inhalt befüllen (dynamische Inhalte). Persistiert in Entwurf+Live und
// pusht leichtgewichtig an Wand/Monitore (nur dieses Element, kein voller Rebuild/Flackern).
app.post('/api/element/:eid', (req, res) => {
  const eid = req.params.eid;
  const found = findElement(eid, state);
  if (!found) return res.status(404).json({ error: 'Element nicht gefunden' });
  const el = found.element, b = req.body || {};
  const patch = {};
  if (typeof b.value === 'string') {
    if (el.type === 'text') patch.text = b.value;
    else if (el.type === 'image') patch.url = b.value;
    else if (el.type === 'qr') patch.data = b.value;
  }
  for (const k of ['text', 'url', 'filename', 'data', 'fill', 'color']) if (typeof b[k] === 'string') patch[k] = b[k];
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Kein Inhalt im Body (text/url/filename/data/fill/value)' });
  const apply = (e2) => {
    Object.assign(e2, patch);
    if (e2.type === 'image') { if ('url' in patch) e2.filename = null; if ('filename' in patch) e2.url = ''; }
  };
  apply(el);
  const lf = findElement(eid, live); if (lf) apply(lf.element);
  saveState(); saveLive();
  sendToScreens({ type: 'cmd', cmd: 'element', eid, patch });
  res.json({ ok: true, element: el });
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

// Playlist klonen: tiefe Kopie mit neuen Item-IDs. Eingebettete Sub-Playlists
// werden geteilt (refId bleibt), hochgeladene Dateien werden referenziert (geteilt).
app.post('/api/playlist/:id/clone', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const items = pl.items.map((it) => it.kind === 'playlist'
    ? { id: newId(), kind: 'playlist', refId: it.refId }
    : { id: newId(), kind: 'content', content: normalizeContent(structuredClone(it.content)) });
  const overlayClips = (pl.overlayClips || []).map((c) => normalizeOverlayClip({ ...c, id: newId() }));
  const copy = { id: newId(), name: `${pl.name} (Kopie)`, after: pl.after, nextId: pl.nextId, items, overlayClips };
  state.playlists.byId[copy.id] = copy;
  saveState();
  broadcast();
  res.json(copy);
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
app.post('/api/playlist/:id/items', async (req, res) => {
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
    // Echte Länge direkt ermitteln (YouTube/Upload, Modus "end"), damit das Scrubboard
    // den Block sofort korrekt darstellt. Best-Effort – Fehler/0 werden ignoriert.
    const c = item.content;
    if ((c.type === 'youtube' || c.type === 'video') && c.videoMode !== 'duration' && !(c.videoDuration > 0)) {
      try { const d = await contentDuration(c); if (d > 0) c.videoDuration = d; } catch (_) {}
    }
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
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei empfangen' });
  const pl = getPlaylist(req.body.playlistId);
  if (!pl) {
    try { unlinkSync(join(UPLOAD_DIR, req.file.filename)); } catch (_) {}
    return res.status(400).json({ error: 'Playlist nicht gefunden' });
  }
  const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
  const raw = { type, filename: req.file.filename, name: req.file.originalname };
  if (type === 'video') raw.videoDuration = await probeDuration(req.file.filename); // für Keyframe-Streifen
  const item = { id: newId(), kind: 'content', content: normalizeContent(raw) };
  pl.items.push(item);
  saveState();
  broadcast();
  res.json(item);
});

// Fehlende Video-/YouTube-Längen nachtragen (vom Scrubboard beim Laden angestoßen).
app.post('/api/probe-durations', async (req, res) => {
  try {
    const updated = await ensureDurations();
    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// YouTube-Storyboard (Scrubbing-Vorschaubilder) für den Filmstreifen im Scrubboard.
app.get('/api/yt-storyboard', async (req, res) => {
  const id = (req.query.id || '').toString();
  if (!/^[\w-]{6,}$/.test(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  try {
    const { storyboard } = await loadYtMeta(id);
    if (!storyboard) return res.json({ ok: false });
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ ok: true, ...storyboard });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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

// "Off Air" setzen/aufheben. Body: { off: true|false }. Stoppt die Wand komplett
// (schwarz). Wieder auf Sendung geht auch per "Go Live".
app.post('/api/offair', (req, res) => {
  offAir = (req.body && typeof req.body.off === 'boolean') ? req.body.off : true;
  saveLive();
  broadcast();
  res.json({ ok: true, offair: offAir });
});

// ---------------------------------------------------------------------------
// Overlay-API (mehrere Zeit-Clips über dem Content)
// ---------------------------------------------------------------------------
app.post('/api/overlay', (req, res) => {
  const name = (req.body?.name || '').trim() || `Overlay ${state.overlays.length + 1}`;
  const o = normalizeOverlay({ name, elements: [] });
  state.overlays.push(o);
  saveState();
  broadcast();
  res.json(o);
});

// Overlay-Inhalt ändern: name/blur (Scheduling liegt an den Playlist-Clips).
app.patch('/api/overlay/:id', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const p = req.body || {};
  if (typeof p.name === 'string' && p.name.trim()) o.name = p.name.trim();
  if (typeof p.blur === 'number' && p.blur >= 0) o.blur = p.blur;
  saveState();
  broadcast();
  res.json(o);
});

app.delete('/api/overlay/:id', (req, res) => {
  const i = state.overlays.findIndex((o) => o.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const [removed] = state.overlays.splice(i, 1);
  // Verwaiste Clips dieses Overlays aus allen Playlists entfernen.
  for (const pl of Object.values(state.playlists.byId)) {
    if (pl.overlayClips) pl.overlayClips = pl.overlayClips.filter((c) => c.overlayId !== removed.id);
  }
  saveState();
  for (const e of removed.elements) if (e.type === 'image' && e.filename) cleanupFile(e.filename);
  broadcast();
  res.json({ ok: true });
});

// --- Overlay-Clips (Anzeigefenster eines Overlays in einer Playlist) --------
app.post('/api/playlist/:id/overlay-clips', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const b = req.body || {};
  if (!getOverlay(b.overlayId)) return res.status(400).json({ error: 'Overlay nicht gefunden' });
  const clip = normalizeOverlayClip({ overlayId: b.overlayId, start: b.start, duration: b.duration, enabled: b.enabled });
  pl.overlayClips = pl.overlayClips || [];
  pl.overlayClips.push(clip);
  saveState();
  broadcast();
  res.json(clip);
});
app.patch('/api/playlist/:id/overlay-clips/:clipId', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const clip = (pl.overlayClips || []).find((c) => c.id === req.params.clipId);
  if (!clip) return res.status(404).json({ error: 'Clip nicht gefunden' });
  const p = req.body || {};
  if (typeof p.start === 'number' && p.start >= 0) clip.start = p.start;
  if ('duration' in p) clip.duration = (typeof p.duration === 'number' && p.duration > 0) ? p.duration : null;
  if (typeof p.enabled === 'boolean') clip.enabled = p.enabled;
  saveState();
  broadcast();
  res.json(clip);
});
app.delete('/api/playlist/:id/overlay-clips/:clipId', (req, res) => {
  const pl = getPlaylist(req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist nicht gefunden' });
  const i = (pl.overlayClips || []).findIndex((c) => c.id === req.params.clipId);
  if (i === -1) return res.status(404).json({ error: 'Clip nicht gefunden' });
  pl.overlayClips.splice(i, 1);
  saveState();
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

// --- Bibliothek: wiederverwertbare Element-/Gruppen-Vorlagen ----------------
// Aktuelle Auswahl als Vorlage speichern. Body: { name, kind, element | elements }.
app.post('/api/library', (req, res) => {
  const b = req.body || {};
  const entry = normalizeLibEntry({ name: b.name, kind: b.kind, element: b.element, elements: b.elements });
  state.library.push(entry);
  saveState();
  broadcast();
  res.json(entry);
});

// Bibliotheks-Vorlage löschen (referenzierte Bilder ggf. aufräumen).
app.delete('/api/library/:id', (req, res) => {
  const i = state.library.findIndex((en) => en.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
  const [removed] = state.library.splice(i, 1);
  saveState();
  const els = removed.kind === 'group' ? (removed.elements || []) : (removed.element ? [removed.element] : []);
  for (const e of els) if (e.type === 'image' && e.filename) cleanupFile(e.filename);
  broadcast();
  res.json({ ok: true });
});

// Vorlage in ein Overlay einfügen (neue ids; Gruppe leicht versetzt). Gibt erzeugte
// Element(e) zurück.
app.post('/api/overlay/:id/element/from-library/:libId', (req, res) => {
  const o = getOverlay(req.params.id);
  if (!o) return res.status(404).json({ error: 'Overlay nicht gefunden' });
  const en = state.library.find((x) => x.id === req.params.libId);
  if (!en) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
  const src = en.kind === 'group' ? (en.elements || []) : (en.element ? [en.element] : []);
  const off = en.kind === 'group' ? 0.03 : 0; // Gruppe leicht versetzt einfügen
  const created = src.map((e) => {
    const el = normalizeElement({ ...e, x: clamp01(e.x + off, e.x), y: clamp01(e.y + off, e.y) });
    el.id = newId();
    o.elements.push(el);
    return el;
  });
  saveState();
  broadcast();
  res.json(en.kind === 'group' ? created : (created[0] || null));
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

// --- Video-Keyframe (ffmpeg, gecacht) für den Filmstreifen in der Timeline ---
app.get('/api/frame', (req, res) => {
  const file = (req.query.file || '').toString();
  const t = Math.max(0, parseFloat(req.query.t) || 0);
  if (!/^[\w.\-]+$/.test(file)) return res.status(400).send('bad file');
  const src = join(UPLOAD_DIR, file);
  if (!existsSync(src)) return res.status(404).send('not found');
  const out = join(THUMB_DIR, `${file}.${Math.round(t)}.jpg`);
  const send = () => { res.set('Cache-Control', 'public, max-age=86400'); res.sendFile(out); };
  if (existsSync(out)) return send();
  execFile('ffmpeg', ['-ss', String(t), '-i', src, '-frames:v', '1', '-vf', 'scale=320:-1', '-q:v', '5', '-y', out],
    { timeout: 20000 }, (err) => {
      if (err || !existsSync(out)) return res.status(500).send('frame error');
      send();
    });
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
  const draftMsg = JSON.stringify({ type: 'state', state, dirty: isDirty(), offair: offAir });
  const liveMsg = JSON.stringify({ type: 'state', state: live, offair: offAir });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(client.isWall ? liveMsg : draftMsg);
  }
}

// Kommando nur an die echte Wand senden (nicht an Monitore/Vorschauen).
function sendToWall(msg) {
  const s = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.isWall && client.role !== 'monitor' && client.readyState === client.OPEN) client.send(s);
  }
}
// An alle anzeigenden Clients (echte Wand UND Live-Monitore) – für Live-Element-Pushes.
function sendToScreens(msg) {
  const s = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.isWall && client.readyState === client.OPEN) client.send(s);
  }
}

let liveNowPlaying = null; // Was läuft gerade auf der echten Wand?

wss.on('connection', (ws, req) => {
  let role = '';
  try { role = new URL(req.url, 'http://x').searchParams.get('role') || ''; } catch (_) {}
  ws.role = role;
  ws.isWall = role !== 'preview' && role !== 'control';

  ws.send(ws.isWall
    ? JSON.stringify({ type: 'state', state: live, offair: offAir })
    : JSON.stringify({ type: 'state', state, dirty: isDirty(), offair: offAir }));
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
  // Fehlende Video-/YouTube-Längen im Hintergrund nachtragen (für korrektes Scrubboard).
  ensureDurations().then((n) => { if (n) console.log(`  ${n} Video-Länge(n) ermittelt.`); }).catch(() => {});
});
