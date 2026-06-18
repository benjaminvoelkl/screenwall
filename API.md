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

## ⚠️ Live vs. Entwurf (WICHTIG – sonst „passiert nichts auf der Wand")
Es gibt zwei Zustände: **Entwurf** (Bearbeitung) und **Live** (was die Wand zeigt).
Die meisten Schreib-Endpunkte ändern nur den **Entwurf**. Sie werden erst auf der Wand
sichtbar, wenn du **veröffentlichst**.

- **Sofort live** (kein Veröffentlichen nötig): `POST /api/play` (startet/wechselt die
  Übertragung), `POST /api/element/:eid` (Element-Inhalt live), `POST /api/offair`,
  `POST /api/volume`.
- **Nur Entwurf → erst nach Veröffentlichen sichtbar**: alles andere, was Struktur/Inhalt
  ändert – Playlists anlegen/füllen/sortieren, Overlay-Clips (Zeitfenster) hinzufügen/ändern,
  **Overlay-Elemente hinzufügen/ändern/löschen**, Overlay anlegen/umbenennen.
- **Veröffentlichen**: `POST /api/golive` (Body `{}`) übernimmt den **kompletten Entwurf**
  auf die Wand. `POST /api/play` veröffentlicht ebenfalls (es klont den Entwurf live).

**Faustregel:** Nach Struktur-/Overlay-Bearbeitungen **immer `POST /api/golive` aufrufen**,
damit es auf der Wand ankommt. Nur `set_element`/`play`/`offair`/`volume` wirken ohne golive.
Reihenfolge zählt: `play`/`golive` veröffentlicht den Entwurf **zum Aufrufzeitpunkt** –
spätere Entwurfsänderungen brauchen ein erneutes `golive`.

## Videos kommen von YouTube
Es gibt **keinen** Such-Endpunkt. Wenn der Nutzer „spiel X / zeig das Spiel / Musik …" sagt,
**suche selbst ein passendes YouTube-Video/-Stream** (offizielle Kanäle/Streams bevorzugen),
ermittle die **`videoId`** (der Teil nach `v=` in `youtube.com/watch?v=…`) und nutze sie als
`content`-Objekt `{ "type":"youtube", "videoId":"…", "videoMode":"end", "muted":false }`.
`videoMode:"end"` spielt bis zum Ende; `muted:false` für Ton (Lautstärke via `/api/volume`).

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

### Inhalt kurz einblenden (Flash, N Sekunden) – „zeig … jetzt für 10 s"
`POST /api/flash` – blendet Inhalt **sofort live** für `seconds` Sekunden ein (zentriert),
entfernt sich selbst wieder. **Kein go_live, keine bleibende Struktur.** Body genau eins von:
- `{ "qr": "www.example.com", "seconds": 10 }` – QR (String = URL; oder Objekt mit
  `qrMode`/Feldern wie bei QR-Elementen, z. B. WLAN/Kontakt)
- `{ "text": "TOR!", "seconds": 5, "color": "#ffffff" }` – großer Text
- `{ "image": "https://…/logo.png", "seconds": 8 }` – Bild (URL)
- `{ "element": { …volles Overlay-Element inkl. x/y/w/h… }, "seconds": 8 }` – volle Kontrolle
Optional `"pos"`: `center` (Standard) | `top` | `bottom`. Antwort `{ ok, id, seconds }`.
Abbrechen: `POST /api/flash/clear` (Body `{}` = alle, oder `{ "id":"…" }`).

### Overlays auflisten (inkl. Element-IDs)
`GET /api/overlays` → `{ overlays: [ { id, name, blur, elements: [ { id, type, text, url,
filename, data, qrMode } ] } ] }`

### Overlay-Fenster (Clip) in einer Playlist setzen / verschieben
Ein Overlay wird in einer Playlist über **Clips** (Zeitfenster) sichtbar; mehrere Fenster
je Overlay möglich.
- Hinzufügen: `POST /api/playlist/:playlistId/overlay-clips`
  `{ "overlayId": "<id>", "start": 30, "duration": 10 }` (`duration` weglassen/`null` = bis Ende)
- Ändern: `PATCH /api/playlist/:playlistId/overlay-clips/:clipId`
  `{ "start": 45, "duration": 8, "enabled": true }`
- Entfernen: `DELETE /api/playlist/:playlistId/overlay-clips/:clipId`
- ⚠️ **nur Entwurf** → danach `POST /api/golive`.

### Veröffentlichen (Entwurf → Wand)
`POST /api/golive` Body `{}` – übernimmt den kompletten Entwurf auf die Wand. **Immer**
nach Struktur-/Overlay-Bearbeitungen aufrufen (siehe „Live vs. Entwurf" oben).

### Overlay-Inhalt bearbeiten (Struktur – Elemente hinzufügen/ändern/löschen)
Für mehr als nur Text-Setzen (z. B. „Banner weg", neues Text-Overlay, Position/Farbe ändern).
**Alle nur Entwurf → danach `POST /api/golive`.**
- Overlay anlegen: `POST /api/overlay` `{ "name": "..." }` → `{ id, ... }`.
- Element hinzufügen: `POST /api/overlay/:overlayId/element`
  `{ "element": { "type":"text", "text":"Tor!", "x":0.1,"y":0.05,"w":0.8,"h":0.12,
  "color":"#ffffff","align":"center","fontFrac":0.6 } }` (auch `image`/`qr`/`shape`).
- Element ändern: `PATCH /api/overlay/:overlayId/element/:eid`
  `{ "element": { "x":0.2,"y":0.1,"color":"#ffd400","fontFrac":0.8,"bg":"" } }`
  (z. B. verschieben/größer/Farbe; `"bg":""` entfernt die Textfläche).
- Element löschen: `DELETE /api/overlay/:overlayId/element/:eid` (entfernt z. B. Flächen/Logos).

> Hinweis Unterschied: `POST /api/element/:eid` (nur `eid`) setzt **Inhalt live**;
> `PATCH /api/overlay/:overlayId/element/:eid` ändert **Struktur/Stil im Entwurf** (braucht
> Overlay-ID **und** `golive`).

#### QR-Code-Elemente (`type: "qr"`) – Typen URL / WLAN / Kontakt
Das Feld `qrMode` bestimmt, was kodiert wird; der eigentliche QR-String (`data`) wird daraus
**automatisch** gebaut – du setzt nur die strukturierten Felder (kein `data` nötig).
- **`qrMode: "url"`** → `url` (Link). Bsp.: `{ "type":"qr","qrMode":"url","url":"https://example.com" }`
- **`qrMode: "wifi"`** → `ssid`, `password`, `encryption` (`WPA`|`WEP`|`nopass`), `hidden` (bool).
  Bsp.: `{ "type":"qr","qrMode":"wifi","ssid":"Gast","password":"geheim","encryption":"WPA" }`
- **`qrMode: "contact"`** → `cname` (Name), `phone`, `email`, `org`, `url` (vCard).
  Bsp.: `{ "type":"qr","qrMode":"contact","cname":"Max Mustermann","phone":"+49…","email":"max@x.de" }`
- Farben: `fg` (Vordergrund), `bg` (Hintergrund). Plus Position `x,y,w,h` (0..1).

Anlegen/ändern wie jedes Element über `add_element` / `update_element` (Entwurf → `go_live`).
Beispiel „WLAN-QR oben rechts ins Overlay":
`add_element {overlayId, element:{type:"qr", qrMode:"wifi", ssid:"Gast", password:"geheim", x:0.78,y:0.05,w:0.18,h:0.18}}` → `go_live`.

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
1. **„Spiel Playlist X ab 50 %"** → `GET /api/playlists` (id finden) → `play {playlistId, percent:50}`.
2. **„Was läuft gerade?"** → `GET /api/status`.
3. **„Zeig oben den Text 'Pause bis 20:30'"** → `GET /api/overlays` (Text-Element-id finden)
   → `set_element <id> {"text":"Pause bis 20:30"}` (sofort live). Falls das Overlay gerade nicht
   sichtbar ist: zusätzlich `add_overlay_window {playlistId:<aktive>, overlayId, start:0}` **→ go_live**.
4. **„Ich will Fußball/Musik/… schauen"** → passende **YouTube-`videoId` selbst suchen** →
   `create_playlist {name, items:[{type:"youtube", videoId, videoMode:"end", muted:false}]}` →
   (optional Overlay einblenden via `add_overlay_window`) → `play {playlistId}` (veröffentlicht).
5. **„Banner weg, nur Text"** → `list_overlays` (Element-IDs) → `delete_element` für Fläche/Logos,
   `update_element {bg:""}` für die Textfläche **→ go_live** (sonst bleibt es auf der Wand!).
6. **„Zeig jetzt einen QR mit www.ip3-energie.de mittig für 10 Sekunden"** →
   `flash {qr:"www.ip3-energie.de", seconds:10}` (sofort, kein go_live, verschwindet selbst).
7. **„Blende die Wand aus"** → `set_offair {off:true}`.

## Hinweise für die KI
- **Live vs. Entwurf beachten** (siehe Abschnitt oben): nach Struktur-/Overlay-Bearbeitungen
  **immer `go_live`**. Nur `set_element`/`play`/`offair`/`volume` wirken sofort ohne go_live.
- **Videos = YouTube:** kein Such-Endpunkt – die KI ermittelt die `videoId` selbst (offizielle
  Streams/Kanäle), `videoMode:"end"`, `muted:false` für Ton.
- Immer zuerst IDs über `list_playlists` / `list_overlays` ermitteln; **niemals IDs erfinden**.
- Für Overlay-Element-Struktur (`add/update/delete_element`) braucht man **Overlay-ID + Element-ID**
  (aus `list_overlays`); `set_element` braucht nur die Element-ID, ändert aber nur den Inhalt live.
- Positions-/Größenangaben von Elementen sind Bruchteile **0..1** (x,y,w,h); `fontFrac` ~0.1–1.
- `time` und `percent` bei `play` nicht gleichzeitig senden (percent hat Vorrang).
- Erfolg: meist `{ "ok": true, ... }`; Fehler: HTTP 4xx/5xx mit `{ "error": "..." }`.
- Dauern für Videos werden serverseitig ermittelt; `totalSec`/`itemRemaining` sind Schätzwerte.

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
  },
  {
    "name": "go_live",
    "description": "Entwurf auf die Wand veröffentlichen. NACH allen Struktur-/Overlay-Bearbeitungen (Playlists/Items/Clips/Elemente) aufrufen, sonst bleibt die Wand unverändert. POST /api/golive (Body {}).",
    "input_schema": { "type": "object", "properties": {}, "additionalProperties": false }
  },
  {
    "name": "add_element",
    "description": "Element zu einem Overlay hinzufügen (text/image/qr/shape). NUR ENTWURF → danach go_live. POST /api/overlay/{overlayId}/element mit { element:{...} }. Positionen 0..1. QR: type='qr' + qrMode (url|wifi|contact) und die passenden Felder (siehe Abschnitt QR-Code-Elemente).",
    "input_schema": { "type": "object", "properties": {
      "overlayId": { "type": "string" },
      "element": { "type": "object", "properties": {
        "type": { "type": "string", "enum": ["text","image","qr","shape"] },
        "text": { "type": "string" }, "color": { "type": "string" }, "align": { "type": "string", "enum": ["left","center","right"] },
        "fontFrac": { "type": "number" }, "url": { "type": "string" },
        "qrMode": { "type": "string", "enum": ["url","wifi","contact"] },
        "ssid": { "type": "string" }, "password": { "type": "string" }, "encryption": { "type": "string", "enum": ["WPA","WEP","nopass"] }, "hidden": { "type": "boolean" },
        "cname": { "type": "string" }, "phone": { "type": "string" }, "email": { "type": "string" }, "org": { "type": "string" },
        "fg": { "type": "string" }, "bg": { "type": "string" },
        "x": { "type": "number" }, "y": { "type": "number" }, "w": { "type": "number" }, "h": { "type": "number" }
      }, "required": ["type"] }
    }, "required": ["overlayId","element"] }
  },
  {
    "name": "update_element",
    "description": "Element-Struktur/Stil ändern: Position/Größe/Farbe/Schrift, Textfläche entfernen (bg=''). NUR ENTWURF → danach go_live. PATCH /api/overlay/{overlayId}/element/{eid} mit { element:{...} }.",
    "input_schema": { "type": "object", "properties": {
      "overlayId": { "type": "string" }, "eid": { "type": "string" },
      "element": { "type": "object" }
    }, "required": ["overlayId","eid","element"] }
  },
  {
    "name": "delete_element",
    "description": "Element aus einem Overlay entfernen (z. B. Banner-Fläche/Logos). NUR ENTWURF → danach go_live. DELETE /api/overlay/{overlayId}/element/{eid}.",
    "input_schema": { "type": "object", "properties": { "overlayId": { "type": "string" }, "eid": { "type": "string" } }, "required": ["overlayId","eid"] }
  },
  {
    "name": "create_overlay",
    "description": "Neues (leeres) Overlay anlegen, danach mit add_element befüllen und per add_overlay_window in eine Playlist einblenden. NUR ENTWURF → danach go_live. POST /api/overlay.",
    "input_schema": { "type": "object", "properties": { "name": { "type": "string" } } }
  },
  {
    "name": "flash",
    "description": "Inhalt SOFORT für N Sekunden zentriert einblenden, entfernt sich selbst (kein go_live). Genau eins von qr/text/image angeben. POST /api/flash. Für 'zeig … jetzt für X Sekunden'.",
    "input_schema": { "type": "object", "properties": {
      "qr": { "type": "string", "description": "URL/Inhalt für einen QR-Code" },
      "text": { "type": "string" }, "image": { "type": "string", "description": "Bild-URL" },
      "seconds": { "type": "number", "description": "Anzeigedauer, Standard 8" },
      "color": { "type": "string", "description": "Textfarbe" },
      "pos": { "type": "string", "enum": ["center","top","bottom"] }
    } }
  },
  {
    "name": "flash_clear",
    "description": "Laufende Flash-Einblendungen entfernen. POST /api/flash/clear (Body {} = alle).",
    "input_schema": { "type": "object", "properties": { "id": { "type": "string" } } }
  },
  {
    "name": "remove_overlay_window",
    "description": "Ein Overlay-Fenster (Clip) aus einer Playlist entfernen → Overlay wird dort nicht mehr gezeigt. clipId aus list_playlists (overlays[].windows[].clipId) oder get_status (overlaysActive[].clipId). NUR ENTWURF → danach go_live. DELETE /api/playlist/{playlistId}/overlay-clips/{clipId}.",
    "input_schema": { "type": "object", "properties": { "playlistId": { "type": "string" }, "clipId": { "type": "string" } }, "required": ["playlistId","clipId"] }
  }
]
```

Mapping Tool → HTTP (Pfadparameter aus den Argumenten, Rest als JSON-Body):
`get_status`→`GET /api/status` · `list_playlists`→`GET /api/playlists` ·
`get_playlist`→`GET /api/playlists/{playlistId}` · `play`→`POST /api/play` ·
`create_playlist`→`POST /api/playlists` · `set_element`→`POST /api/element/{eid}` ·
`list_overlays`→`GET /api/overlays` · `add_overlay_window`→`POST /api/playlist/{playlistId}/overlay-clips` ·
`set_offair`→`POST /api/offair` · `set_volume`→`POST /api/volume` ·
`go_live`→`POST /api/golive` · `create_overlay`→`POST /api/overlay` ·
`add_element`→`POST /api/overlay/{overlayId}/element` (Body `{element}`) ·
`update_element`→`PATCH /api/overlay/{overlayId}/element/{eid}` (Body `{element}`) ·
`delete_element`→`DELETE /api/overlay/{overlayId}/element/{eid}` ·
`remove_overlay_window`→`DELETE /api/playlist/{playlistId}/overlay-clips/{clipId}` ·
`flash`→`POST /api/flash` · `flash_clear`→`POST /api/flash/clear`.
