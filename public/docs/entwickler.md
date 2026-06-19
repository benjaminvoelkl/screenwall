# Screenwall – Entwickler- & Betriebsdokumentation

## Architektur

- **Backend:** Node.js + **Express** (ES Modules), WebSocket über **`ws`**.
  Ein HTTP-Server (Port `3000`) und – für die Bildschirmfreigabe – ein zweiter
  **HTTPS-Server** (Port `3443`, selbst-signiert). Ein einziger WebSocket-Server
  bedient beide Transports.
- **Frontend:** Vanilla JS (kein Framework), je Seite ein `public/js/*.js`.
- **Persistenz:** zwei JSON-Dateien – `state.json` (**Entwurf**) und `live.json`
  (**veröffentlicht / Wand**). Überleben Neustarts.
- **Echtzeit:** Der Server broadcastet bei jeder Änderung den passenden Zustand
  per WebSocket (Steuer-Clients sehen Entwurf, Anzeige-Clients sehen Live).

## Projektstruktur

```
server.js              Express, WebSocket, gesamte API, Persistenz
API.md                 vollständige HTTP-/LLM-API-Referenz
LLM.md                 Leitfaden für KI-Agenten
public/
  index.html  + js/monitor.js     Live-Monitor (/)
  programm.html + js/programm.js   Zeitstrahl/Scrubboard (/programm)
  playlists.html + js/playlists.js Playlist-Editor (/playlists)
  overlay.html + js/overlay.js     Overlay-Editor (/overlay)
  screen.html + js/screen.js       Wand-Anzeige (/screen)
  share.html + js/share.js         Bildschirm teilen (/share, HTTPS)
  docs.html + docs/*.md            diese Doku
  css/*.css
uploads/               hochgeladene Bilder/Videos
.thumbs/               gecachte Video-Keyframes (ffmpeg)
certs/                 selbst-signiertes TLS-Zertifikat (auto-erzeugt)
state.json / live.json Zustand (Entwurf / Live)
```

## Starten & Entwickeln

```bash
npm install
npm start          # node server.js  (Port 3000, HTTPS 3443)
npm run dev        # node --watch server.js
```

Konsolenausgabe zeigt die erreichbaren LAN-Adressen inkl. HTTPS-Share-URL.

## Konfiguration (Environment-Variablen)

| Variable | Default | Zweck |
|----------|---------|-------|
| `PORT` | `3000` | HTTP-Port (Steuerung + Anzeige). |
| `HTTPS_PORT` | `3443` | HTTPS-Port für `/share` (getDisplayMedia braucht „secure context"). |
| `AUDIO_SINK` | `@DEFAULT_AUDIO_SINK@` | PipeWire/WirePlumber-Ziel für die Lautstärke (`wpctl`). |

## Externe Abhängigkeiten (System)

- **ffmpeg/ffprobe** – Video-Längen + Keyframe-Filmstreifen (`.thumbs/`).
- **wpctl** (PipeWire/WirePlumber) – System-Lautstärke (`/api/volume`).
- **openssl** – erzeugt beim ersten Start das selbst-signierte Zertifikat in
  `certs/` (für den HTTPS-Listener). Fehlt openssl, läuft alles weiter, nur die
  Bildschirmfreigabe ist nicht nutzbar.

## Zustand: Entwurf vs. Live

- Alle **Struktur**-Endpunkte (Playlists, Items, Overlays, Overlay-Clips, Kapitel,
  Highlights) ändern nur `state.json` → danach **`POST /api/golive`**.
- **Sofort wirksam** (ohne golive): `POST /api/play` (klont Entwurf→Live und
  spielt/springt), `POST /api/element/:eid`, `POST /api/flash`, `POST /api/offair`,
  `POST /api/volume`.
- `/api/play` veröffentlicht implizit – Springen zu Kapitel/Highlight braucht also
  kein separates golive.

## WebSocket-Protokoll (kurz)

Verbindung: `ws(s)://<host>/?role=control|monitor|preview|share` (Anzeige = ohne
Rolle bzw. wall).

- Server → Client: `{ type:'state', state, dirty?, offair }` (Entwurf an
  Steuer-Clients, Live an Anzeige-Clients).
- Steuerbefehle: `{ type:'cmd', cmd:'goto'|'seek'|'nowplaying'|'element'|'flash'|… }`.
- **WebRTC-Signaling** (Bildschirm teilen): `{ type:'rtc', kind:'join'|'peers'|
  'offer'|'answer'|'ice'|'bye', session, to?, … }` – der Server ist reiner
  Session-Relay zwischen Publisher (`/share`) und Wand (`/screen`).

## Bildschirmfreigabe (WebRTC)

- `/share` (HTTPS) ruft `getDisplayMedia()` **einmal** auf; der Capture-Stream
  bleibt aktiv, solange der Tab offen ist. Pro Wand eine `RTCPeerConnection`
  (Mesh); Wand wechselt Inhalt → PeerConnection wird ab-/wieder aufgebaut, ohne
  erneute Browser-Abfrage.
- LAN: Host-ICE-Kandidaten genügen (kein STUN/TURN nötig).

## Deployment

### Als Dienst (systemd, Beispiel)

```ini
# /etc/systemd/system/screenwall.service
[Unit]
Description=Screenwall
After=network.target

[Service]
WorkingDirectory=/var/www/screenwall
ExecStart=/usr/bin/node server.js
Environment=PORT=3000 HTTPS_PORT=3443
Restart=always
User=screenwall

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now screenwall
journalctl -u screenwall -f
```

### Wand-Rechner (Kiosk)

`/screen` im Vollbild-Browser (Kiosk-Modus) autostarten, z. B.
`chromium --kiosk http://localhost:3000/screen`. Die Lautstärke-Steuerung setzt
PipeWire/`wpctl` auf dem Wand-Rechner voraus.

### HTTPS / Reverse-Proxy

- **Standard:** selbst-signierter HTTPS-Listener auf `HTTPS_PORT` (einmalige
  Browser-Warnung). Für `/share` zwingend (sonst keine Bildschirmfreigabe).
- **Eigene Domain:** Einen Reverse-Proxy (nginx/Caddy) mit echtem Zertifikat
  davorsetzen, der HTTP **und** WebSocket (`Upgrade`-Header) weiterreicht. Dann
  `/share` über die HTTPS-Domain ausliefern.

### Update auf einem laufenden Server

```bash
git pull
# Node-Dienst neu starten (sonst fehlen neue Routen)
sudo systemctl restart screenwall
```

## API-Referenz

Die vollständige HTTP-API (Endpunkte, Bodies, Beispiele) steht in **API.md**
(im Footer verlinkt). Für KI-Agenten siehe **LLM.md**.
