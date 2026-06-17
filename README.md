# Screenwall

Lokale Web-Anwendung zur Steuerung eines Anzeige-Bildschirms (Beamer/Monitor) von
einem beliebigen Gerät im selben Netzwerk (Tablet, Handy, Laptop).

- **`/`** – Live-Monitor: spiegelt maßstabsgetreu, was gerade auf der Wand läuft.
- **`/programm`** – Programm-Timeline: Übersicht des Programms wie in einem Videoschnitt-
  Programm (Zeitstrahl, Scrubbing, Spuren für Content/Musik/Overlay) + „Preview & Go Live".
- **`/playlists`** – Playlist-Editor: Playlists und Inhalte zusammenstellen/konfigurieren.
- **`/screen`** – Vollbild-Anzeige (Beamer/Wand): zeigt die veröffentlichte Übertragung.
- **`/overlay`** – Willkommens-Overlay konfigurieren (liegt über dem Hintergrund).

Änderungen auf `/playlists` landen zunächst im **Entwurf** und erscheinen erst per
**„Preview & Go Live"** (auf `/programm`) auf der Wand. Updates laufen **ohne Neuladen**
per WebSocket. (`/settings` leitet aus Kompatibilität auf `/programm` um.)

## Playlists & Contents

Das Inhaltsmodell ist hierarchisch:

- **Content** – der Hintergrund einer Übertragung, immer in eine Playlist gekapselt.
  Typen: **Farbe**, **Bild**, **Video**, **YouTube**, **Webseite** (sowie der
  vorbereitete, noch nicht aktive Typ **Bildschirm**/Screenshare). Je Content sind
  Anzeigedauer, Stummschaltung, Zuschnitt (Cover) bzw. Farbe einstellbar; Bilder
  haben optional einen 18:16-Zuschnitt (= 9:8) beim Upload.
- **Playlist** – eine geordnete Liste von Einträgen; ein Eintrag ist entweder ein
  Content **oder** eine Referenz auf eine andere Playlist (Verschachtelung; wird
  inline abgespielt). Jede Playlist hat eine Nachfolge-Aktion: **Loop** (von vorn),
  **Stop** (Standbild) oder **Nächste** (Verweis auf eine andere Playlist).
- **Start (Wurzel)** – eine Playlist ist als Start markiert und beginnt die Übertragung.

Das **Willkommens-Overlay** (frei schreibbare Botschaft mit wählbaren Vorlagen)
liegt unverändert **über** dem laufenden Hintergrund und wird unter `/overlay` bearbeitet.

## Installation & Start

Voraussetzung: Node.js (getestet mit v22).

```bash
npm install
npm start
```

Beim Start gibt der Server die erreichbaren URLs aus, z. B.:

```
  Lokal:      http://localhost:3000/
  Im Netz:    http://192.168.x.y:3000/        (Steuerung)
              http://192.168.x.y:3000/screen  (Anzeige)
```

- **Anzeige-Gerät** (Beamer/Monitor-PC): `http://<IP>:3000/screen` im Browser öffnen
  und in den Vollbildmodus gehen (F11).
- **Steuer-Gerät** (Tablet/Handy): `http://<IP>:3000/` öffnen.

Der Server lauscht auf `0.0.0.0`, ist also im gesamten LAN erreichbar. Mehrere
`/screen`-Geräte gleichzeitig sind möglich (alle erhalten denselben Broadcast).

Port ändern: `PORT=8080 npm start`.

## Persistenz

Der **Entwurf** liegt in `state.json`, der veröffentlichte (Wand-)Zustand in
`live.json`; beide überleben einen Neustart. Hochgeladene Dateien liegen in
`uploads/`. Alte, modus-basierte `state.json`/`live.json` werden beim Start
automatisch ins Playlist-Modell migriert (vorhandene Medien bleiben erhalten).

## Robustheit

- `/screen` verbindet sich bei Abbruch automatisch neu und holt beim Laden den
  aktuellen Zustand.
- Vollbild ohne Scrollbalken, schwarzer Hintergrund, Mauszeiger blendet nach
  Inaktivität aus.

## Getroffene Annahmen (offene Fragen aus dem Konzept)

Diese Standardannahmen sind im Code kommentiert und leicht änderbar:

1. **Erreichbarkeit:** nur LAN (keine Internet-Freigabe, keine Authentifizierung).
2. **Video/YouTube:** schalten standardmäßig **nach Videoende** weiter; alternativ
   „nach Dauer" je Content wählbar.
3. **Verschachtelung:** eine verschachtelt eingebundene Playlist wird einmal inline
   durchlaufen; ihre Nachfolge-Aktion (`after`) greift nur, wenn sie selbst die
   Start-/Top-Playlist ist. Zyklen werden serverseitig verhindert.
4. **Crop-Seitenverhältnis:** **18:16 (= 9:8)**, exakt wie gefordert. Falls 16:9
   gemeint war, in `public/js/control.js` (`aspectRatio: 18 / 16`) anpassen.
5. **Authentifizierung:** keine (rein lokal). Bei Bedarf nachrüstbar.
6. **Mehrere Anzeigen:** unterstützt (WebSocket-Broadcast an alle Clients).

### Hinweise

- **YouTube/Autoplay & Ton:** Browser erlauben Autoplay meist nur stummgeschaltet.
  YouTube-/Video-Contents haben daher eine Stumm-Option (Standard: stumm). Für Ton
  ggf. einmal manuell auf dem Anzeige-Gerät interagieren.
- **Eigene Videos** werden zur Autoplay-Kompatibilität stummgeschaltet abgespielt.
- **Internet nötig** nur für: YouTube/Webseiten-Contents sowie die per CDN geladene
  Crop-Bibliothek (Cropper.js). Farb-, Bild-, Video- und Overlay-Inhalte
  funktionieren vollständig offline.

## Projektstruktur

```
server.js              Express + WebSocket + Upload, Playlist-API, Persistenz
state.json             Entwurf (wird automatisch erzeugt)
live.json              veröffentlichter Wand-Zustand
uploads/               hochgeladene Bilder/Videos
public/
  index.html           Live-Monitor /
  programm.html        Programm-Timeline /programm (Übersicht + Go Live)
  playlists.html       Playlist-Editor /playlists (Inhalte zusammenstellen)
  screen.html          Anzeige /screen
  overlay.html         Willkommens-Overlay /overlay
  css/control.css  css/programm.css  css/monitor.css  css/screen.css
  js/programm.js   js/playlists.js   js/monitor.js    js/screen.js    js/overlay.js
```

## API (intern)

- `GET  /api/state` – Entwurf abrufen (`?view=live` für den Wand-Zustand)
- `POST /api/state` – Willkommens-Overlay setzen (`{ welcome }`)
- `POST /api/golive` – Entwurf auf die Wand veröffentlichen
- `POST /api/playlist` – Playlist anlegen; `/:id/rename`, `DELETE /:id`
- `POST /api/playlist/root` – Start-Playlist (Wurzel) setzen (`{ id }`)
- `POST /api/playlist/:id/after` – Nachfolge setzen (`{ after, nextId }`)
- `POST /api/playlist/:id/items` – Eintrag anhängen (Content oder `{ kind:'playlist', refId }`)
- `PATCH /api/playlist/:id/items/:itemId` – Content-Felder ändern (`{ content }`)
- `DELETE /api/playlist/:id/items/:itemId` – Eintrag entfernen
- `POST /api/playlist/:id/items/order` – Reihenfolge setzen (`{ order: [itemId, ...] }`)
- `POST /api/upload` – Bild/Video hochladen + anhängen (Felder `file`, `playlistId`)
- `POST /api/link` – Webseiten-Content anhängen (`{ url, playlistId }`); `/api/link/recheck`
- `POST /api/volume` / `GET /api/volume` – Wand-Systemlautstärke (wpctl)
- WebSocket auf demselben Port: Server pusht `{ type: 'state', state }` an alle Clients.
