# LLM.md – Leitfaden für KI-Agenten

Dieses Dokument richtet sich an **KI-Agenten**, die Screenwall (eine Video-Wand)
über die HTTP-API steuern. Es fasst die Regeln zusammen, die ein Agent kennen
muss. Die vollständige Endpunkt-Referenz steht in **API.md**.

## Was du steuerst

Eine Video-Wand zeigt **Playlists** aus **Inhalten** (Farbe, Bild, Video,
YouTube, Webseite, Bildschirmfreigabe), überlagert von **Overlays**
(Text/Bild/QR/Flächen). **Kapitel** und **Highlights** erlauben schnelles
Anspringen von Positionen.

Basis-URL: `http://<host>:3000`. Antworten sind JSON.

## Goldene Regeln

1. **IDs niemals erfinden.** Immer zuerst auflisten:
   `GET /api/status`, `GET /api/playlists`, `GET /api/playlists/:id`,
   `GET /api/overlays`, `GET /api/highlights`.
2. **Live vs. Entwurf:** Struktur-Änderungen (Playlists, Items, Overlays,
   Overlay-Clips, Kapitel, Highlights) wirken nur im **Entwurf**. Danach **immer**
   `POST /api/golive`, sonst bleibt die Wand unverändert.
3. **Sofort wirksam ohne golive:** `POST /api/play` (auch Sprung zu
   Kapitel/Highlight – veröffentlicht implizit), `POST /api/element/:eid` (Inhalt
   eines Elements live setzen), `POST /api/flash`, `POST /api/offair`,
   `POST /api/volume`.
4. **Positionen sind Bruchteile 0..1** (x, y, w, h) auf dem Ausgabe-Canvas.
5. **Bei `play` nicht** `time` und `percent` gleichzeitig senden.
6. Antworte knapp und bestätige, was getan wurde (oder was fehlschlug).

## Häufige Abläufe

- **Etwas abspielen:** `GET /api/playlists` → passende `id` →
  `POST /api/play {playlistId}` (optional `time`/`percent`).
- **Playlist bauen:** `POST /api/playlists {name, items:[…]}` →
  Inhalte siehe unten → `POST /api/play` oder `POST /api/golive`.
- **Text/Logo/QR einblenden:** `create_overlay` → `add_element` →
  `add_overlay_window` (Zeitfenster) → `go_live`. Für Live-Textänderung:
  `POST /api/element/:eid`.
- **Schnell springen:** `POST /api/play {playlistId, chapterId}` oder
  `POST /api/play {highlightId}`.
- **Kurz einblenden (selbstlöschend):** `POST /api/flash {text|qr|image, seconds}`.

## Inhalts-Typen (content-Objekt)

```jsonc
{ "type":"color",  "color":"#0a0a0d", "durationSec":6 }
{ "type":"image",  "filename":"<upload>", "durationSec":8 }
{ "type":"video",  "filename":"<upload>", "videoMode":"end", "muted":true }
{ "type":"youtube","videoId":"…", "videoMode":"end", "muted":false }
{ "type":"webpage","url":"https://…", "durationSec":15 }
{ "type":"screenshare", "withAudio":false }   // Wand zeigt Link+QR zum Teilen
{ "type":"external", "url":"https://…", "name":"Netflix", "durationSec":15 } // nativer Vollbild-Browser auf dem Anzeige-PC (DRM-Streaming)
```
YouTube: Es gibt **keinen** Such-Endpunkt – wähle selbst eine `videoId`.
Bildschirmfreigabe: keine Quelle angeben; die Wand zeigt automatisch Link + QR.
Externer Inhalt: für DRM-Streaming (Netflix/Disney+) oder freie Streams (ZDF-Live),
die sich nicht einbetten lassen. Öffnet nativ auf dem Anzeige-PC; Bezahldienste
brauchen eine einmalige Anmeldung am PC (nicht per Handy castbar).

## Kapitel & Highlights

- **Kapitel** (Bereich je Playlist): `POST /api/playlist/:id/chapters
  {name, start, duration?}`. `start`/`duration` in Sekunden.
- **Highlight** (global, kuratiert): `POST /api/highlights
  {name, playlistId, start}`.
- **Springen (sofort live):** Kapitel `POST /api/play {playlistId, chapterId}`;
  Highlight `POST /api/play {highlightId}`.

## Tool-Bridge (Anthropic-Tools)

`tools/llm-bridge.mjs` stellt die API als Tools bereit (u. a. `get_status`,
`list_playlists`, `get_playlist`, `play`, `create_playlist`, `create_overlay`,
`add_element`, `update_element`, `delete_element`, `add_overlay_window`,
`remove_overlay_window`, `set_element`, `flash`, `flash_clear`, `go_live`,
`set_offair`, `set_volume`, `add_chapter`, `jump_to_chapter`, `list_highlights`,
`add_highlight`, `jump_to_highlight`). Das Mapping Tool→HTTP steht am Ende von
**API.md**.

## Stolperfallen

- Nach Struktur-Bearbeitung **golive** vergessen → nichts ändert sich auf der Wand.
- Erfundene/veraltete IDs → 404. Erst auflisten.
- `screenshare` braucht **keine** URL; der Link wird automatisch erzeugt
  (HTTPS-Pflicht für die Teilen-Seite, nicht für die Wand).
- `time` **und** `percent` zusammen bei `play` vermeiden.

Vollständige Referenz: **API.md**. Benutzer-/Betriebssicht: Benutzerhandbuch &
Entwickler-Doku (im Footer der App verlinkt).
