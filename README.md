# Screenwall

Lokale Web-Anwendung zur Steuerung eines Anzeige-Bildschirms (Beamer/Monitor) von
einem beliebigen Gerät im selben Netzwerk (Tablet, Handy, Laptop).

- **`/`** – Steuerseite: Modus wählen und Inhalte konfigurieren.
- **`/screen`** – Vollbild-Anzeige: zeigt sofort, was auf `/` eingestellt wurde.

Änderungen auf `/` erscheinen **ohne Neuladen** auf `/screen` (Live-Update via WebSocket).

## Drei Modi

1. **Diashow** – Bilder **und** Videos als Endlos-Diashow mit Crossfade.
   Anzeigedauer pro Bild einstellbar. Upload mit sortierbarer Liste (Drag & Drop),
   einzeln löschbar, optionaler 18:16-Zuschnitt (= 9:8) für Bilder.
2. **YouTube-Playlist** – mehrere YouTube-Videos nacheinander im Vollbild
   (YouTube IFrame Player API, automatischer Übergang beim Videoende).
3. **Willkommen** – eine frei schreibbare Botschaft (Standard
   „Herzlich Willkommen Gast") formatfüllend, mit wählbaren Vorlagen.

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

Der gesamte Zustand (Modus + Einstellungen + Medienliste) liegt in `state.json`
und überlebt einen Neustart. Hochgeladene Dateien liegen in `uploads/`.

## Robustheit

- `/screen` verbindet sich bei Abbruch automatisch neu und holt beim Laden den
  aktuellen Zustand.
- Vollbild ohne Scrollbalken, schwarzer Hintergrund, Mauszeiger blendet nach
  Inaktivität aus.

## Getroffene Annahmen (offene Fragen aus dem Konzept)

Diese Standardannahmen sind im Code kommentiert und leicht änderbar:

1. **Erreichbarkeit:** nur LAN (keine Internet-Freigabe, keine Authentifizierung).
2. **Diashow-Videos:** schalten standardmäßig **nach Videoende** weiter;
   alternativ „nach Anzeigedauer" pro Diashow im UI wählbar.
3. **Crop-Seitenverhältnis:** **18:16 (= 9:8)**, exakt wie gefordert. Falls 16:9
   gemeint war, in `public/js/control.js` (`aspectRatio: 18 / 16`) und der Hinweis
   in `server.js` anpassen.
4. **Authentifizierung:** keine (rein lokal). Bei Bedarf nachrüstbar.
5. **Mehrere Anzeigen:** unterstützt (WebSocket-Broadcast an alle Clients).

### Hinweise

- **YouTube/Autoplay & Ton:** Browser erlauben Autoplay meist nur stummgeschaltet.
  Im YouTube-Modus gibt es daher eine Stumm-Option (Standard: stumm). Für Ton
  ggf. einmal manuell auf dem Anzeige-Gerät interagieren.
- **Diashow-Videos** werden zur Autoplay-Kompatibilität immer stummgeschaltet
  abgespielt.
- **Internet nötig** nur für: YouTube-Modus sowie die per CDN geladene Crop-
  Bibliothek (Cropper.js) auf der Steuerseite. Diashow- und Willkommens-Modus
  funktionieren vollständig offline.

## Projektstruktur

```
server.js              Express + WebSocket + Upload, state.json-Persistenz
state.json             persistierter Zustand (wird automatisch erzeugt)
uploads/               hochgeladene Bilder/Videos
public/
  index.html           Steuerseite /
  screen.html          Anzeige /screen
  css/control.css
  css/screen.css
  js/control.js
  js/screen.js
```

## API (intern)

- `GET  /api/state` – aktuellen Zustand abrufen
- `POST /api/state` – Teil-Zustand setzen (`{ mode, slideshow, youtube, welcome }`)
- `POST /api/upload` – Datei hochladen (Feld `file`)
- `DELETE /api/media/:id` – Medium löschen
- `POST /api/media/order` – Reihenfolge setzen (`{ order: [id, ...] }`)
- WebSocket auf demselben Port: Server pusht `{ type: 'state', state }` an alle Clients.
# screenwall
