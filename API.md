# Screenwall Steuer-API (für LLM-Steuerung)

HTTP/JSON-API zum Steuern der Videowand: Playlists abspielen, Status abfragen,
Overlays/Texte live ändern. Kein Auth (lokales Netz). Basis-URL: `http://<host>:3000`.
Alle Bodies sind JSON (`Content-Type: application/json`). Zeiten in Sekunden.

## Grundbegriffe
- **Playlist**: geordnete Liste von Inhalten (`items`). Eine Playlist ist „aktiv" (root)
  und wird übertragen. Playlists können verschachtelt sein (werden ausgeflacht).
- **Programmzeit**: Sekunden seit Start der aktiven Playlist (über alle Inhalte kumuliert).
- **Overlay**: wiederverwendbarer Grafik-/Text-Layer mit **Elementen** (Text/Bild/QR/Fläche).
  Wo ein Overlay erscheint, bestimmen **Clips** (Zeitfenster) pro Playlist.
- **Element**: Teil eines Overlays, hat eine feste `id`. Inhalt kann live gesetzt werden.

## Inhaltstypen (`content`-Objekt)
| type | Pflicht/wichtige Felder |
|------|--------------------------|
| `color` | `color` (#hex), `durationSec` |
| `image` | `filename` (in /uploads), `durationSec`, `crop` |
| `video` | `filename`, `videoMode` (`end`\|`duration`), `durationSec` (bei duration), `muted` |
| `youtube` | `videoId`, `videoMode` (`end`\|`duration`), `durationSec`, `muted` |
| `webpage` | `url`, `durationSec` |
`name` ist überall optional. Bilder/Videos müssen vorher hochgeladen sein (`/api/upload`).

---

## Wichtigste Endpunkte (Steuerung)

### Status abfragen
`GET /api/status` → was läuft, wie lange noch.
```json
{
  "offair": false,
  "playlist": { "id": "...", "name": "Sequenz 1" },
  "now": { "contentId": "...", "type": "youtube", "name": "...", "videoId": "...",
           "itemDuration": 553, "itemElapsed": 120, "itemRemaining": 433 },
  "program": { "time": 120, "totalSec": 8441, "remainingSec": 8321, "percent": 1 },
  "overlaysActive": [ { "clipId": "...", "overlayId": "...", "name": "Titel" } ]
}
```

### Playlists auflisten
`GET /api/playlists` → `{ rootId, playlists: [ { id, name, active, itemCount, totalSec,
after, nextId, overlays:[{overlayId,name,windows:[{start,end,enabled}]}] } ] }`
`GET /api/playlists/:id` → wie oben + ausgeflachte `items` (mit `itemId,type,name,start,dur`).

### Playlist sofort abspielen (Übertragung starten)
`POST /api/play`
```json
{ "playlistId": "<id>", "time": 20 }     // ab Sekunde 20
{ "playlistId": "<id>", "percent": 50 }  // ab 50 % der Gesamtlänge
{ "playlistId": "<id>" }                 // ab Anfang
```
Stellt die Playlist als aktiv ein, veröffentlicht sie und startet die Wiedergabe sofort.
Antwort: `{ ok, playlistId, progTime, totalSec, itemId, offset }`.

### Playlist anlegen und befüllen
`POST /api/playlists`
```json
{ "name": "Event", "items": [
  { "type": "color", "color": "#ff0000", "durationSec": 5 },
  { "type": "youtube", "videoId": "VEhI9v6cb14", "videoMode": "end" },
  { "type": "webpage", "url": "https://example.com", "durationSec": 15 }
] }
```
Antwort: die neue Playlist (`{ id, name, items, ... }`). Danach mit `/api/play` starten.

### Einzelnen Inhalt zu einer Playlist hinzufügen
`POST /api/playlist/:id/items` → `{ "kind": "content", "content": { ...siehe Inhaltstypen } }`
(optional `"index": <n>` zum Einfügen an Position). Verschachtelte Playlist:
`{ "kind": "playlist", "refId": "<playlistId>" }`.

### Element live mit Inhalt füllen (dynamische Inhalte)
`POST /api/element/:eid` – ändert sofort auf der Wand (kein Neuladen), bleibt erhalten.
```json
{ "value": "Nächster Act: 21:00" }   // value passt sich dem Elementtyp an
{ "text": "Begrüßungstext" }          // Text-Element
{ "url": "https://.../bild.png" }     // Bild-Element (externe URL)
{ "data": "https://ziel.de" }         // QR-Element (neuer QR-Inhalt)
{ "fill": "#0033ff" }                  // Fläche (Füllfarbe)
```
Element-IDs bekommst du über `GET /api/overlays`.

### Overlays auflisten (inkl. Element-IDs)
`GET /api/overlays` → `{ overlays: [ { id, name, blur, elements: [ { id, type, text, url,
filename, data } ] } ] }`

### Overlay-Fenster (Clip) in einer Playlist setzen / verschieben
Ein Overlay wird in einer Playlist über **Clips** (Zeitfenster) sichtbar; mehrere Fenster
je Overlay möglich.
- Hinzufügen: `POST /api/playlist/:playlistId/overlay-clips`
  `{ "overlayId": "<id>", "start": 30, "duration": 10 }` (`duration` weglassen/`null` = bis Ende)
- Ändern: `PATCH /api/playlist/:playlistId/overlay-clips/:clipId`
  `{ "start": 45, "duration": 8, "enabled": true }`
- Entfernen: `DELETE /api/playlist/:playlistId/overlay-clips/:clipId`

### Weitere nützliche Endpunkte
- `POST /api/playlist/root` `{ "id": "<playlistId>" }` – Playlist als aktiv setzen (ohne Seek).
- `POST /api/offair` `{ "off": true|false }` – Wand schwarz schalten / wieder senden.
- `GET /api/volume` , `POST /api/volume` `{ "level": 0.5 }` oder `{ "mute": "toggle" }`.
- `POST /api/playlist/:id/clone` – Playlist duplizieren.
- `POST /api/playlist/:id/rename` `{ "name": "..." }`, `DELETE /api/playlist/:id`.
- `POST /api/playlist/:id/after` `{ "after": "loop"|"stop"|"next", "nextId": "<id>" }` – was
  nach Playlist-Ende passiert.
- `GET /api/state` – kompletter Roh-Zustand (groß; nur bei Bedarf).

---

## Typische Abläufe
1. **„Spiel Playlist X ab 50 %"** → `GET /api/playlists` (id finden) → `POST /api/play {playlistId, percent:50}`.
2. **„Was läuft gerade?"** → `GET /api/status`.
3. **„Zeig oben den Text 'Pause bis 20:30'"** → `GET /api/overlays` (Text-Element-id finden)
   → `POST /api/element/<id> {"text":"Pause bis 20:30"}`. Falls das Overlay gerade nicht
   sichtbar ist: zusätzlich `POST /api/playlist/<aktivePlaylist>/overlay-clips {overlayId, start:0}`.
4. **„Erstelle eine Playlist mit diesen 3 YouTube-Videos und starte sie"** →
   `POST /api/playlists {name, items:[...]}` → `POST /api/play {playlistId}`.
5. **„Blende die Wand aus"** → `POST /api/offair {off:true}`.

## Hinweise für die KI
- Immer zuerst IDs über `GET /api/playlists` bzw. `GET /api/overlays` ermitteln; niemals IDs erfinden.
- `time` und `percent` bei `/api/play` nicht gleichzeitig senden (percent hat Vorrang).
- Antworten auf Erfolg enthalten i. d. R. `{ "ok": true, ... }`; Fehler: HTTP 4xx/5xx mit `{ "error": "..." }`.
- Dauern/Längen für Videos werden serverseitig automatisch ermittelt; `totalSec`/`itemRemaining` sind Schätzwerte.

---

## Function-Calling-Schemas (für LLM-Tools)

Diese Tools auf HTTP abbilden (Basis-URL voranstellen). Anthropic-Format (`input_schema`);
für OpenAI `input_schema` → `parameters` umbenennen und in `{ "type":"function", "function": {...} }` wickeln.

```json
[
  {
    "name": "get_status",
    "description": "Aktuellen Wiedergabestatus abfragen: aktive Playlist, was läuft, Restzeit, aktive Overlays. GET /api/status (kein Body).",
    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
  },
  {
    "name": "list_playlists",
    "description": "Alle Playlists mit Namen, Gesamtdauer, Aktiv-Flag und ihren Overlay-Fenstern auflisten. GET /api/playlists.",
    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
  },
  {
    "name": "get_playlist",
    "description": "Eine Playlist inkl. ausgeflachter Inhalte (items mit Start/Dauer) holen. GET /api/playlists/{playlistId}.",
    "input_schema": { "type": "object", "properties": { "playlistId": { "type": "string" } }, "required": ["playlistId"] }
  },
  {
    "name": "play",
    "description": "Eine Playlist sofort übertragen, optional ab Sekunde (time) ODER Prozent (percent). POST /api/play.",
    "input_schema": { "type": "object", "properties": {
      "playlistId": { "type": "string" },
      "time": { "type": "number", "description": "Startsekunde in der Programmzeit" },
      "percent": { "type": "number", "description": "0-100; Vorrang vor time" }
    }, "required": ["playlistId"] }
  },
  {
    "name": "create_playlist",
    "description": "Playlist anlegen und optional mit Inhalten befüllen. POST /api/playlists. items[] sind content-Objekte (type: color|image|video|youtube|webpage).",
    "input_schema": { "type": "object", "properties": {
      "name": { "type": "string" },
      "items": { "type": "array", "items": { "type": "object",
        "properties": {
          "type": { "type": "string", "enum": ["color","image","video","youtube","webpage"] },
          "color": { "type": "string" }, "filename": { "type": "string" }, "videoId": { "type": "string" },
          "url": { "type": "string" }, "durationSec": { "type": "number" },
          "videoMode": { "type": "string", "enum": ["end","duration"] }, "name": { "type": "string" }
        }, "required": ["type"] } }
    }, "required": ["name"] }
  },
  {
    "name": "set_element",
    "description": "Inhalt eines Overlay-Elements live setzen (Text/Bild-URL/QR/Fläche). Element-IDs via list_overlays. POST /api/element/{eid}.",
    "input_schema": { "type": "object", "properties": {
      "eid": { "type": "string" },
      "value": { "type": "string", "description": "passt sich dem Elementtyp an (text/url/data)" },
      "text": { "type": "string" }, "url": { "type": "string" }, "data": { "type": "string" }, "fill": { "type": "string" }
    }, "required": ["eid"] }
  },
  {
    "name": "list_overlays",
    "description": "Overlays mit Element-IDs auflisten (um Elemente per set_element zu befüllen). GET /api/overlays.",
    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
  },
  {
    "name": "add_overlay_window",
    "description": "Ein Overlay in einer Playlist als Zeitfenster (Clip) anzeigen. POST /api/playlist/{playlistId}/overlay-clips. duration weglassen = bis Programmende.",
    "input_schema": { "type": "object", "properties": {
      "playlistId": { "type": "string" }, "overlayId": { "type": "string" },
      "start": { "type": "number" }, "duration": { "type": "number" }
    }, "required": ["playlistId","overlayId"] }
  },
  {
    "name": "set_offair",
    "description": "Wand schwarz schalten (off=true) oder wieder senden (off=false). POST /api/offair.",
    "input_schema": { "type": "object", "properties": { "off": { "type": "boolean" } }, "required": ["off"] }
  },
  {
    "name": "set_volume",
    "description": "Systemlautstärke der Wand setzen. POST /api/volume. level 0..1 oder mute='toggle'.",
    "input_schema": { "type": "object", "properties": { "level": { "type": "number" }, "mute": { "type": "string" } } }
  }
]
```

Mapping Tool → HTTP (Pfadparameter aus den Argumenten, Rest als JSON-Body):
`get_status`→`GET /api/status` · `list_playlists`→`GET /api/playlists` ·
`get_playlist`→`GET /api/playlists/{playlistId}` · `play`→`POST /api/play` ·
`create_playlist`→`POST /api/playlists` · `set_element`→`POST /api/element/{eid}` ·
`list_overlays`→`GET /api/overlays` · `add_overlay_window`→`POST /api/playlist/{playlistId}/overlay-clips` ·
`set_offair`→`POST /api/offair` · `set_volume`→`POST /api/volume`.
