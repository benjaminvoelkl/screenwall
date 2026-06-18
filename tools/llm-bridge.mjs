#!/usr/bin/env node
// Minimaler LLM-Bridge: chatte in der Konsole, das Modell steuert die Wand über die
// lokale HTTP-API (siehe API.md). Manuelle Tool-Use-Schleife mit dem Anthropic-SDK.
//
//   npm install @anthropic-ai/sdk          # einmalig (im Projekt)
//   export ANTHROPIC_API_KEY=sk-ant-...    # dein API-Key
//   export WALL_BASE=http://localhost:3000 # optional, Standard wie hier
//   node tools/llm-bridge.mjs              # dann Befehle eintippen
//
// Beispiel-Befehle: "was läuft gerade?", "spiel Sequenz 1 ab 50%", "zeig oben 'Pause bis 20:30'".

import Anthropic from '@anthropic-ai/sdk';
import readline from 'node:readline';

const WALL_BASE = process.env.WALL_BASE || 'http://localhost:3000';
const MODEL = process.env.LLM_MODEL || 'claude-opus-4-8';
const client = new Anthropic(); // liest ANTHROPIC_API_KEY aus der Umgebung

// ---- Tools (entsprechen den Endpunkten in API.md) -------------------------
const tools = [
  { name: 'get_status', description: 'Aktuellen Wiedergabestatus abfragen (aktive Playlist, was läuft, Restzeit, aktive Overlays).', input_schema: { type: 'object', properties: {} } },
  { name: 'list_playlists', description: 'Alle Playlists mit Namen, Gesamtdauer, Aktiv-Flag und Overlay-Fenstern auflisten.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_playlist', description: 'Eine Playlist inkl. ausgeflachter Inhalte holen.', input_schema: { type: 'object', properties: { playlistId: { type: 'string' } }, required: ['playlistId'] } },
  { name: 'play', description: 'Eine Playlist sofort übertragen, optional ab Sekunde (time) ODER Prozent (percent, 0-100, hat Vorrang).', input_schema: { type: 'object', properties: { playlistId: { type: 'string' }, time: { type: 'number' }, percent: { type: 'number' } }, required: ['playlistId'] } },
  { name: 'create_playlist', description: 'Playlist anlegen und optional mit Inhalten befüllen. items[] = content-Objekte (type: color|image|video|youtube|webpage).', input_schema: { type: 'object', properties: { name: { type: 'string' }, items: { type: 'array', items: { type: 'object' } } }, required: ['name'] } },
  { name: 'set_element', description: 'Inhalt eines Overlay-Elements live setzen. eid via list_overlays. value passt sich dem Typ an (text/url/data).', input_schema: { type: 'object', properties: { eid: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, data: { type: 'string' }, fill: { type: 'string' } }, required: ['eid'] } },
  { name: 'list_overlays', description: 'Overlays mit Element-IDs auflisten (für set_element).', input_schema: { type: 'object', properties: {} } },
  { name: 'add_overlay_window', description: 'Ein Overlay in einer Playlist als Zeitfenster einblenden. duration weglassen = bis Programmende.', input_schema: { type: 'object', properties: { playlistId: { type: 'string' }, overlayId: { type: 'string' }, start: { type: 'number' }, duration: { type: 'number' } }, required: ['playlistId', 'overlayId'] } },
  { name: 'set_offair', description: 'Wand schwarz schalten (off=true) oder wieder senden (off=false).', input_schema: { type: 'object', properties: { off: { type: 'boolean' } }, required: ['off'] } },
  { name: 'set_volume', description: 'Lautstärke der Wand setzen. level 0..1 oder mute="toggle".', input_schema: { type: 'object', properties: { level: { type: 'number' }, mute: { type: 'string' } } } }
];

const enc = encodeURIComponent;
const pick = (o, keys) => { const out = {}; for (const k of keys) if (o[k] !== undefined) out[k] = o[k]; return out; };
const ROUTES = {
  get_status: () => ['GET', '/api/status'],
  list_playlists: () => ['GET', '/api/playlists'],
  get_playlist: (i) => ['GET', `/api/playlists/${enc(i.playlistId)}`],
  play: (i) => ['POST', '/api/play', pick(i, ['playlistId', 'time', 'percent'])],
  create_playlist: (i) => ['POST', '/api/playlists', pick(i, ['name', 'items'])],
  set_element: (i) => ['POST', `/api/element/${enc(i.eid)}`, pick(i, ['value', 'text', 'url', 'data', 'fill'])],
  list_overlays: () => ['GET', '/api/overlays'],
  add_overlay_window: (i) => ['POST', `/api/playlist/${enc(i.playlistId)}/overlay-clips`, pick(i, ['overlayId', 'start', 'duration'])],
  set_offair: (i) => ['POST', '/api/offair', pick(i, ['off'])],
  set_volume: (i) => ['POST', '/api/volume', pick(i, ['level', 'mute'])]
};

async function callWall(name, input) {
  const route = ROUTES[name];
  if (!route) return `Unbekanntes Tool: ${name}`;
  const [method, path, body] = route(input || {});
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  try {
    const res = await fetch(WALL_BASE + path, opt);
    return `HTTP ${res.status} ${await res.text()}`;
  } catch (e) {
    return `Fehler: ${e.message} (läuft der Server unter ${WALL_BASE}?)`;
  }
}

const SYSTEM = `Du steuerst eine Video-Wand über eine lokale HTTP-API (die Tools unten).
Ermittle IDs immer zuerst über list_playlists bzw. list_overlays – erfinde niemals IDs.
Sende bei play nicht time und percent gleichzeitig. Antworte knapp auf Deutsch und bestätige,
was du getan hast (oder was schiefging).`;

// ---- Manuelle Tool-Use-Schleife -------------------------------------------
const messages = []; // bleibt über die Sitzung erhalten (Kontext, IDs)

async function turn(userText) {
  messages.push({ role: 'user', content: userText });
  while (true) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools,
      messages
    });
    messages.push({ role: 'assistant', content: res.content }); // volle content (inkl. thinking) zurücklegen
    if (res.stop_reason !== 'tool_use') {
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) console.log('\n🤖 ' + text + '\n');
      return;
    }
    const results = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`   ↳ ${block.name}(${JSON.stringify(block.input)})`);
      const out = await callWall(block.name, block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
}

// ---- REPL ------------------------------------------------------------------
console.log(`LLM-Bridge → ${WALL_BASE} (Modell ${MODEL}). Befehl eintippen, "exit" zum Beenden.`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === 'exit' || text === 'quit') return rl.close();
  try { await turn(text); } catch (e) { console.error('Fehler:', e.message); }
  rl.prompt();
});
rl.on('close', () => process.exit(0));
