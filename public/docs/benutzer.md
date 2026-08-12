# Screenwall – Benutzerhandbuch

Screenwall steuert eine **Video-Wand / einen Bildschirm** im Netzwerk: Inhalte
(Bilder, Videos, YouTube, Webseiten, Farben, geteilte Bildschirme) werden in
**Playlists** zusammengestellt, mit **Overlays** (Text/Logo/QR) überlagert und per
Klick **live** auf die Wand geschaltet. Bedient wird alles im Browser – kein
Login, alle im selben Netzwerk können steuern.

---

## Die Seiten im Überblick

| Seite | Adresse | Zweck |
|-------|---------|-------|
| **Live-Monitor** | `/` | Was läuft gerade? Kleine Live-Vorschau + TV-Lautstärke + On Air/Off Air. |
| **Programm** | `/programm` | Zeitstrahl (Scrubboard) der aktiven Playlist: Vorschau, scrubben, Kapitel & Highlights, Go Live. |
| **Playlists** | `/playlists` | Inhalte anlegen, hochladen, sortieren; Playlists verwalten. |
| **Overlay-Editor** | `/overlay` | Text-, Bild-, QR- und Flächen-Elemente platzieren. |
| **Anzeige (Wand)** | `/screen` | Die eigentliche Vollbild-Ausgabe (Beamer/Monitor). |
| **Bildschirm teilen** | `/share` (HTTPS) | Entfernter Browser überträgt seinen Bildschirm auf die Wand. |

---

## Grundbegriffe

- **Content (Inhalt):** Ein Hintergrund-Element. Typen: **Bild**, **Video**,
  **YouTube**, **Webseite**, **Externer Inhalt** (Vollbild-Browser am Anzeige-PC,
  für DRM-Dienste wie Netflix oder freie Livestreams), **Bildschirm teilen
  (Screenshare)** und **Farbe**. Jeder Typ wird im Dialog „Inhalt hinzufügen"
  mit einem Satz erklärt.
- **Playlist:** Geordnete Liste von Inhalten. Eine Playlist kann andere Playlists
  enthalten (Verschachtelung). Am Ende: **Loop** (von vorn), **Stopp** (Standbild)
  oder **Nächste Playlist**.
- **Aktive Playlist (Start):** Die Playlist, die die Übertragung bestimmt
  (Stern „★ Als Start setzen").
- **Overlay:** Wiederverwendbare Grafik-Ebene über dem Inhalt (Text, Logo, QR,
  Flächen). Wird über **Fenster (Clips)** zeitlich in einer Playlist eingeblendet.
- **Kapitel:** Benannte **Abschnitte** innerhalb einer Playlist zum schnellen
  Anspringen (Zeitstrahl-Marker + Chips).
- **Highlights:** Kuratierte, **playlist-übergreifende** Schnellzugriffe – ein
  Klick springt sofort live an die gespeicherte Stelle.
- **Live vs. Entwurf:** Du bearbeitest immer den **Entwurf**. Erst **Go Live**
  (bzw. „Abspielen") überträgt ihn auf die Wand. So sieht das Publikum keine
  halbfertigen Änderungen.
- **On Air / Off Air:** Off Air schaltet die Wand komplett schwarz; On Air sendet
  wieder.

---

## Erste Schritte

1. **Playlist anlegen** (`/playlists`): „+ Neue Playlist" legt sofort an und öffnet
   sie – der Name steht markiert bereit, tippen genügt. KI-Kontext und das
   Verhalten am Ende stehen unter **„Weitere Optionen"**.
2. **Playlist füllen:** „+ Inhalt hinzufügen" öffnet die Typ-Auswahl; danach
   erscheinen nur die Felder, die der gewählte Typ braucht. Reihenfolge per
   Drag & Drop, Dauer und Optionen je Eintrag direkt in der Liste.
3. **(Optional) Overlay** (`/overlay`): Begrüßungstext, Logo oder QR-Code
   platzieren und als Fenster in der Playlist einblenden.
4. **Vorschau & Go Live** (`/programm`): Am Zeitstrahl scrubben, dann
   **„Preview & Go Live"** – jetzt läuft es auf der Wand (`/screen`).
5. **Wand öffnen** (`/screen`) auf dem Beamer/Monitor (Vollbild).

> Gespeichert wird sofort bei jeder Änderung – eine kurze Meldung „Gespeichert"
> bestätigt das. Solange oben „Entwurf – nicht veröffentlicht" steht, ist die
> Änderung noch **nicht** auf der Wand; das erledigt erst **Preview & Go Live**.

---

## Typische Anwendungsfälle (Use-Cases)

- **Begrüßung / Infoscreen:** Farbverlauf oder Bild als Hintergrund + Text-Overlay
  „Herzlich willkommen", optional Logo. Loop.
- **YouTube/Video zeigen:** YouTube-Link einfügen, „bis Ende" oder feste Dauer,
  Ton an/aus.
- **Webseite einblenden:** URL als Webseiten-Inhalt (z. B. Dashboard, Wetter).
- **WLAN-Zugang teilen:** QR-Overlay im Modus „WLAN" (SSID + Passwort) – Gäste
  scannen und sind verbunden.
- **Kontakt/Visitenkarte:** QR-Overlay „Kontakt" (vCard).
- **Spontane Einblendung (Flash):** Kurz etwas für N Sekunden zeigen, verschwindet
  von selbst (z. B. „Pause – gleich geht's weiter").
- **Langes Programm navigieren:** Mit **Kapiteln** den Zeitstrahl unterteilen und
  per Chip an Stellen springen; wichtige Momente als **Highlights** für
  Ein-Klick-Zugriff sichern.
- **Entfernten Bildschirm zeigen:** Per `/share` überträgt ein Laptop/Handy seinen
  Bildschirm live auf die Wand (Präsentation, Demo).

---

## Wofür Screenwall NICHT gedacht ist (Non-Use-Cases)

- **Kein öffentliches Internet-CMS:** Es gibt **keine Benutzer/Logins/Rechte** –
  jeder im Netzwerk kann steuern. Nicht ungeschützt ins offene Internet stellen.
- **Kein Video-Editor/Schnittprogramm:** Inhalte werden arrangiert, nicht
  geschnitten/gerendert.
- **Kein Mehrkanal-/Multiscreen-Mischer mit individuellem Inhalt pro Wand:** Alle
  `/screen`-Anzeigen zeigen denselben Live-Zustand.
- **Keine Rechteverwaltung / kein DRM:** Geschützte Streams (Netflix etc.) lassen
  sich nicht einbetten.
- **Kein verlässlicher Audio-Mixer:** Lautstärke steuert die System-Ausgabe der
  Wand, kein mehrspuriges Audio.

---

## FAQ

**Warum ändert sich die Wand nicht, obwohl ich etwas bearbeitet habe?**
Struktur-Änderungen (Playlists, Inhalte, Overlays, Kapitel) landen erst im
**Entwurf**. Mit **„Go Live"** (oder „Abspielen") veröffentlichen.

**Was bedeutet der rote Rahmen / „LIVE" in der Vorschau?**
Die Vorschau spiegelt gerade die echte Wand. Beim Scrubben wechselt sie in den
**Entwurf-Modus** (Badge „ENTWURF").

**Wie springe ich schnell an eine Stelle?**
`/programm`: am Zeitstrahl ziehen (scrubben), oder **Kapitel-Chips** /
**Highlights** anklicken (springen sofort live).

**Wie zoome ich den Zeitstrahl?**
Mit dem **Zoom-Regler**, mit dem **Mausrad** über dem Scrubboard oder per
**Zwei-Finger-Pinch** (Touch).

**Bildschirm teilen geht nicht / „nicht verfügbar"?**
Die Teilen-Seite muss über **HTTPS** geöffnet werden
(`https://<IP>:<HTTPS-Port>/share`). Die einmalige Zertifikatswarnung bestätigen.
Am einfachsten den auf der Wand angezeigten **QR-Code** scannen.

**Muss ich nach dem Teilen erneut bestätigen, wenn ich den Wand-Inhalt wechsle?**
Nein. Einmal „Bildschirm teilen", Tab offen lassen – der Inhalt kann beliebig
gewechselt werden, das Bild kommt ohne erneute Abfrage zurück.

**Wie schalte ich die Wand schwarz?**
Live-Monitor (`/`): **On Air → stoppen** (Off Air). Wieder senden über Go Live
oder erneut den Streifen.

**Wie ändere ich die Lautstärke?**
Über den Lautstärkeregler im Live-Monitor/Footer (steuert die System-Lautstärke
der Wand).

**Kann ich eine Playlist in eine andere einbetten?**
Ja – „+ Playlist einbetten". Zyklen werden automatisch verhindert.

---

Mehr für Technik/Betrieb: siehe **Entwickler-Doku** und **API-Doku** (im Footer).
