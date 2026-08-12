// content.js – das Content-Typ-Register: die EINE Wahrheit über Inhaltstypen.
//
// Vorher lagen Typ-Beschriftungen (TYPE_LABEL), Typ-Symbole (TYPE_BADGE, zweimal),
// die Anlege-Logik (addContentByType) und die Bearbeitungsfelder
// (buildContentControls) an vier verschiedenen Stellen in zwei Dateien. Wird hier
// ein Typ ergänzt oder eine Beschriftung geändert, wirkt das überall: Kacheln im
// "Inhalt hinzufügen"-Dialog, Felder je Eintrag, Storyboard, Timeline.
//
// Braucht ui.js (UI.*). Einbinden: <script src="/js/content.js"></script>

(() => {
  const U = window.UI;

  // ===== Register ==========================================================
  // hint = ein Satz, der im Dialog erklärt, wofür der Typ gut ist. Genau deshalb
  // steht "Externer Inhalt" nicht länger nur in einem title-Attribut.
  const TYPES = [
    { type: 'image', badge: '🖼', label: 'Bild',
      hint: 'Foto oder Grafik, für eine feste Dauer eingeblendet.' },
    { type: 'video', badge: '🎬', label: 'Video',
      hint: 'Videodatei von diesem Gerät hochladen.' },
    { type: 'youtube', badge: '▶', label: 'YouTube',
      hint: 'Über YouTube-Link oder Video-ID.' },
    { type: 'webpage', badge: '🌐', label: 'Webseite',
      hint: 'Seite eingebettet anzeigen – manche Seiten verbieten das.' },
    { type: 'external', badge: '📺', label: 'Externer Inhalt',
      hint: 'Vollbild-Browser direkt am Anzeige-PC – für Netflix, ZDF-Livestream & Co.' },
    { type: 'screenshare', badge: '🖥', label: 'Bildschirm teilen',
      hint: 'Die Wand zeigt Link und QR-Code; Bildschirm wird vom Gerät gesendet.' },
    { type: 'color', badge: '🎨', label: 'Farbe',
      hint: 'Einfarbige Fläche als Pause oder Trenner.' },
    { type: 'playlist', badge: '📃', label: 'Playlist einbetten',
      hint: 'Eine andere Playlist an dieser Stelle mitspielen.' }
  ];
  const byType = Object.fromEntries(TYPES.map((t) => [t.type, t]));
  const label = (type) => (byType[type] ? byType[type].label : type);
  const badge = (type) => (byType[type] ? byType[type].badge : '•');
  const hint = (type) => (byType[type] ? byType[type].hint : '');

  // ===== Typ-Symbole als Knoten ============================================
  // Die meisten Typen sind ein Zeichen; YouTube bekommt sein echtes Logo, weil
  // ein generisches ▶ dort nicht wiedererkennbar ist. Größe in em, damit das
  // Logo überall der umgebenden Schriftgröße folgt (Kachel 22px, Storyboard
  // 15px, Timeline klein) – ohne je Einsatzort eigene Regeln.
  const YT_LOGO = '<svg viewBox="0 0 28.57 20" xmlns="http://www.w3.org/2000/svg" '
    + 'role="img" aria-label="YouTube" focusable="false">'
    + '<path fill="#FF0000" d="M27.9727 3.12324C27.6435 1.89323 26.6768 0.926623 25.4468 0.597366C23.2197 '
    + '2.24288e-07 14.285 0 14.285 0C14.285 0 5.35042 2.24288e-07 3.12323 0.597366C1.89323 0.926623 '
    + '0.926623 1.89323 0.597366 3.12324C2.24288e-07 5.35042 0 10 0 10C0 10 2.24288e-07 14.6496 0.597366 '
    + '16.8768C0.926623 18.1068 1.89323 19.0734 3.12323 19.4026C5.35042 20 14.285 20 14.285 20C14.285 20 '
    + '23.2197 20 25.4468 19.4026C26.6768 19.0734 27.6435 18.1068 27.9727 16.8768C28.5701 14.6496 28.5701 '
    + '10 28.5701 10C28.5701 10 28.5677 5.35042 27.9727 3.12324Z"/>'
    + '<path fill="white" d="M11.4253 14.2854L18.8477 10.0004L11.4253 5.71533V14.2854Z"/>'
    + '</svg>';

  // Liefert einen Knoten statt eines Strings, damit auch ein Logo möglich ist.
  // Die Aufrufer hängen ihn an ihr eigenes Element an.
  function badgeEl(type) {
    if (type === 'youtube') {
      const s = document.createElement('span');
      s.className = 'ct-logo ct-logo-yt';
      s.innerHTML = YT_LOGO;         // feste Konstante, keine Fremddaten
      return s;
    }
    return document.createTextNode(badge(type));
  }

  // Anzeigename eines Inhalts (eigener Name, sonst Typbezeichnung).
  const displayName = (c) => (c && c.name) || label(c && c.type);

  // ===== Anlege-Formulare ==================================================
  // Je Typ: baut die Felder, validiert am Feld (nicht per alert) und führt den
  // passenden API-Aufruf aus – Upload, /api/link oder /api/playlist/:id/items.
  //
  // ctx = { playlistId, playlists: [{id,name}], uploadFiles(files, wantCrop) }
  function buildAddForm(type, ctx) {
    const wrap = U.el('div', 'dlg-fields');
    const errors = new Map();

    // Fehlermeldung direkt unter dem betroffenen Feld.
    function setError(input, msg) {
      let node = errors.get(input);
      if (!msg) {
        if (node) { node.remove(); errors.delete(input); }
        input.classList.remove('invalid');
        return;
      }
      if (!node) {
        node = U.el('div', 'field-error');
        errors.set(input, node);
        (input.closest('label') || input).after(node);
      }
      node.textContent = msg;
      input.classList.add('invalid');
      input.focus();
    }

    const addItem = (content) => U.api('POST', `/api/playlist/${ctx.playlistId}/items`, { kind: 'content', content });

    // --- gemeinsame Felder ---
    const nameIn = () => { const i = U.textInput(''); i.placeholder = 'optional'; return i; };
    const durIn = (v, min = 1) => U.numInput(v, min, 6000, 1);

    if (type === 'color') {
      const color = U.colorInput('#1e293b');
      const name = nameIn();
      const dur = durIn(6);
      wrap.append(U.field('Name', name), U.field('Farbe', color), U.field('Dauer (Sekunden)', dur));
      return { node: wrap, submit: () => addItem({ type: 'color', color: color.value, name: name.value.trim(), durationSec: Number(dur.value) }) };
    }

    if (type === 'image' || type === 'video') {
      const file = U.el('input');
      file.type = 'file';
      file.accept = type === 'image' ? 'image/*' : 'video/*';
      file.multiple = true;
      const crop = type === 'image'
        ? U.checkboxRow('Vor dem Hochladen auf 18:16 zuschneiden', false)
        : null;
      wrap.append(U.field(type === 'image' ? 'Bilder auswählen' : 'Videos auswählen', file));
      if (crop) wrap.appendChild(crop);
      wrap.appendChild(U.el('p', 'hint', type === 'image'
        ? 'Mehrere Dateien möglich. Die Anzeigedauer lässt sich danach je Bild einstellen.'
        : 'Mehrere Dateien möglich. Videos laufen standardmäßig bis zum Ende und stumm.'));
      return {
        node: wrap,
        submit: async () => {
          const files = Array.from(file.files || []);
          if (!files.length) { setError(file, 'Bitte mindestens eine Datei auswählen.'); throw new Error('no-file'); }
          const wantCrop = !!(crop && crop.querySelector('input').checked);
          await ctx.uploadFiles(files, wantCrop);
        }
      };
    }

    if (type === 'youtube') {
      const url = U.textInput('');
      url.placeholder = 'https://www.youtube.com/watch?v=… oder Video-ID';
      const name = nameIn();
      wrap.append(U.field('YouTube-Link oder Video-ID', url), U.field('Name', name));
      wrap.appendChild(U.el('p', 'hint', 'Läuft standardmäßig bis zum Videoende und stumm – beides danach je Eintrag änderbar.'));
      return {
        node: wrap,
        submit: async () => {
          const id = U.parseYoutubeId(url.value);
          if (!id) { setError(url, 'Daraus lässt sich keine YouTube-ID lesen.'); throw new Error('bad-id'); }
          setError(url, null);
          await addItem({ type: 'youtube', videoId: id, name: name.value.trim() || url.value.trim(), muted: true, crop: false, videoMode: 'end' });
        }
      };
    }

    if (type === 'webpage') {
      const url = U.textInput('');
      url.placeholder = 'https://… oder example.com';
      const dur = durIn(15, 3);
      wrap.append(U.field('Adresse der Seite', url), U.field('Dauer (Sekunden)', dur));
      wrap.appendChild(U.el('p', 'hint', 'Nach dem Hinzufügen wird geprüft, ob die Seite sich einbetten lässt. Falls nicht: „Externer Inhalt" verwenden.'));
      return {
        node: wrap,
        submit: async () => {
          const u = U.normalizeUrl(url.value);
          if (!u) { setError(url, 'Bitte eine gültige Adresse eingeben.'); throw new Error('bad-url'); }
          setError(url, null);
          const res = await U.api('POST', '/api/link', { url: u, playlistId: ctx.playlistId });
          if (Number(dur.value) !== 15 && res && res.id) {
            await U.api('PATCH', `/api/playlist/${ctx.playlistId}/items/${res.id}`, { content: { durationSec: Number(dur.value) } });
          }
        }
      };
    }

    if (type === 'external') {
      const url = U.textInput('');
      url.placeholder = 'https://www.netflix.com/… oder ZDF-Livestream';
      const name = U.textInput('');
      name.placeholder = 'z. B. Netflix';
      const dur = durIn(15, 3);
      wrap.append(U.field('Adresse', url), U.field('Name', name), U.field('Dauer (Sekunden)', dur));
      wrap.appendChild(U.el('p', 'hint',
        'Öffnet als eigenes Vollbild-Fenster auf dem Anzeige-PC – damit funktionieren auch '
        + 'DRM-Dienste. Voraussetzung: der Server läuft auf demselben PC wie die Anzeige. '
        + 'Bezahldienste einmalig direkt an diesem PC anmelden.'));
      return {
        node: wrap,
        submit: async () => {
          const u = U.normalizeUrl(url.value);
          if (!u) { setError(url, 'Bitte eine gültige Adresse eingeben.'); throw new Error('bad-url'); }
          setError(url, null);
          await addItem({ type: 'external', url: u, name: name.value.trim() || 'Externer Inhalt', durationSec: Number(dur.value) });
        }
      };
    }

    if (type === 'screenshare') {
      // Früher ein confirm() als Zwei-Wege-Auswahl ("OK = mit Ton") – jetzt eine Checkbox.
      const audio = U.checkboxRow('Ton der Freigabe mitübertragen', false);
      const name = nameIn();
      const dur = durIn(15, 3);
      wrap.append(U.field('Name', name), audio, U.field('Dauer (Sekunden)', dur));
      wrap.appendChild(U.el('p', 'hint', 'Sobald der Block live ist, zeigt die Wand einen Link und einen QR-Code. Damit öffnet das teilende Gerät die Freigabeseite.'));
      return {
        node: wrap,
        submit: () => addItem({
          type: 'screenshare', name: name.value.trim() || 'Bildschirm',
          withAudio: audio.querySelector('input').checked, durationSec: Number(dur.value)
        })
      };
    }

    if (type === 'playlist') {
      const opts = (ctx.playlists || []).filter((p) => p.id !== ctx.playlistId).map((p) => [p.id, p.name]);
      const sel = U.selectInput(opts, opts.length ? opts[0][0] : '');
      wrap.append(U.field('Welche Playlist?', sel));
      wrap.appendChild(U.el('p', 'hint', 'Die eingebettete Playlist läuft an dieser Stelle einmal komplett durch. Ringschlüsse verhindert der Server.'));
      return {
        node: wrap,
        submit: async () => {
          if (!sel.value) { setError(sel, 'Es gibt keine andere Playlist zum Einbetten.'); throw new Error('no-pl'); }
          await U.api('POST', `/api/playlist/${ctx.playlistId}/items`, { kind: 'playlist', refId: sel.value });
        }
      };
    }

    return { node: wrap, submit: async () => {} };
  }

  // ===== Bearbeitungsfelder je Eintrag ====================================
  // Einheitliche Reihenfolge für ALLE Typen: Name → typ-spezifisch → Dauer.
  // Vorher hatte nur "Externer Inhalt" ein Namensfeld, obwohl der Name überall
  // angezeigt wird (Storyboard, Timeline).
  //
  // ctx = { patch(fields), recheck() }
  function itemControls(item, ctx) {
    const c = item.content;
    const out = [];
    const add = (lbl, node) => out.push(U.field(lbl, node));

    add('Name', U.textInput(c.name || '', (v) => ctx.patch({ name: v.trim() })));

    if (c.type === 'color') {
      add('Farbe', U.colorInput(c.color || '#000000', (v) => ctx.patch({ color: v })));
    }
    if (c.type === 'image') {
      out.push(U.checkboxRow('Zuschneiden (Cover)', c.crop, (v) => ctx.patch({ crop: v })));
    }
    if (c.type === 'video' || c.type === 'youtube') {
      add('Ende', U.selectInput(
        [['end', 'bis Videoende'], ['duration', 'nach Dauer']],
        c.videoMode || 'end',
        (v) => ctx.patch({ videoMode: v })
      ));
      out.push(U.checkboxRow('Stumm', c.muted !== false, (v) => ctx.patch({ muted: v })));
      out.push(U.checkboxRow('Zuschneiden', c.crop, (v) => ctx.patch({ crop: v })));
    }
    if (c.type === 'webpage' || c.type === 'external') {
      // Adresse ist jetzt änderbar (vorher nur bei "Externer Inhalt").
      add('Adresse', U.textInput(c.url || '', (v) => {
        const u = U.normalizeUrl(v);
        if (!u) { U.toast('Bitte eine gültige Adresse eingeben.', 'err'); return; }
        // Bei neuer Adresse gilt die alte Einbettbarkeits-Prüfung nicht mehr.
        ctx.patch(c.type === 'webpage' ? { url: u, embeddable: null, reason: '' } : { url: u });
      }));
    }
    if (c.type === 'webpage') {
      const status = U.el('span', 'embed-status');
      if (c.embeddable === false) { status.classList.add('link-bad'); status.title = c.reason || ''; status.textContent = '⚠ blockiert'; }
      else if (c.embeddable === true) { status.classList.add('link-ok'); status.textContent = '✓ einbettbar'; }
      else { status.classList.add('link-unknown'); status.textContent = '? ungeprüft'; }
      const box = U.el('span', 'ctrl');
      box.append(status, U.btn('neu prüfen', 'ghost tiny', () => ctx.recheck()));
      out.push(box);
    }
    if (c.type === 'screenshare') {
      out.push(U.checkboxRow('Ton übertragen', c.withAudio, (v) => ctx.patch({ withAudio: v })));
      out.push(U.el('span', 'link-unknown', c.sessionId
        ? 'Link und QR-Code erscheinen auf der Wand, sobald der Block live ist.'
        : 'Erst live schalten, dann erscheint der Teil-Link auf der Wand.'));
    }
    if (c.type === 'external') {
      out.push(U.el('span', 'link-unknown',
        'Öffnet als Vollbild-Fenster am Anzeige-PC. Bezahldienste dort einmalig anmelden.'));
    }

    // Dauer zuletzt – bei Videos nur, wenn sie überhaupt greift.
    const hasDuration = !((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration');
    if (hasDuration) {
      const min = (c.type === 'webpage' || c.type === 'external' || c.type === 'screenshare') ? 3 : 1;
      add('Dauer (s)', U.numInput(c.durationSec, min, 6000, 1, (v) => ctx.patch({ durationSec: v })));
    }
    return out;
  }

  // ===== Dauer & Ausflachen ===============================================
  const NOMINAL_END = 30; // angenommene Länge für Videos ohne bekannte Dauer

  // Playlist rekursiv zu einer flachen Content-Folge ausflachen (Zyklen-sicher).
  function flatten(plId, byId, visited = new Set()) {
    const pl = byId[plId];
    if (!pl || visited.has(plId)) return [];
    const v = new Set(visited); v.add(plId);
    const out = [];
    for (const it of pl.items) {
      if (it.kind === 'content') out.push({ itemId: it.id, content: it.content });
      else if (it.kind === 'playlist') out.push(...flatten(it.refId, byId, v));
    }
    return out;
  }

  // Blockdauer. `measured` (optional) sind live gemessene Längen als Rückfallebene,
  // wenn der Server noch keine videoDuration kennt.
  function blockDur(itemId, c, measured) {
    if ((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration') {
      return c.videoDuration || (measured && measured[itemId]) || NOMINAL_END;
    }
    return Math.max(1, c.durationSec || 6);
  }

  // ===== Filmstreifen =====================================================
  // Eine Implementierung für Timeline und Storyboard; die Seiten unterscheiden
  // sich nur in Klassennamen und Keyframe-Dichte.
  const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  function gridStep(pps, thumbPx, dur, maxFrames, floorStep) {
    const target = thumbPx / Math.max(0.0001, pps);
    let g = NICE.find((n) => n >= target) || 3600;
    if (floorStep) g = Math.max(g, floorStep);
    if (Math.ceil(dur / g) > maxFrames) g = dur / maxFrames;
    return g;
  }

  // Keyframes eines hochgeladenen Videos (/api/frame).
  function buildFilmstrip(filename, dur, pps, o = {}) {
    const { stripCls = 'tl-filmstrip', frameCls = 'tl-frame', thumbPx = 110, maxFrames = 60 } = o;
    dur = dur || 0;
    const strip = U.el('div', stripCls);
    const g = gridStep(pps, thumbPx, dur, maxFrames);
    for (let t = 0; t < dur - 0.01; t += g) {
      const w = Math.min(g, dur - t);
      const img = U.el('img', frameCls);
      img.loading = 'lazy'; img.alt = '';
      img.style.left = (t * pps) + 'px';
      img.style.width = (w * pps) + 'px';
      img.src = `/api/frame?file=${encodeURIComponent(filename)}&t=${Math.round(t + w / 2)}`;
      strip.appendChild(img);
    }
    return strip;
  }

  // YouTube-Storyboard (Sprite-Sheets). Cache je Seite; onLoad löst ein Neuzeichnen aus.
  const ytSb = {};
  function ytStoryboard(videoId, onLoad) {
    if (!videoId) return null;
    if (videoId in ytSb) return ytSb[videoId] === 'pending' ? null : ytSb[videoId];
    ytSb[videoId] = 'pending';
    fetch(`/api/yt-storyboard?id=${encodeURIComponent(videoId)}`)
      .then((r) => r.json())
      .then((d) => { ytSb[videoId] = (d && d.ok) ? d : null; if (d && d.ok && onLoad) onLoad(); })
      .catch(() => { ytSb[videoId] = null; });
    return null;
  }
  function buildYtFilmstrip(sb, dur, pps, o = {}) {
    const { stripCls = 'tl-filmstrip', frameCls = 'tl-frame tl-sb', thumbPx = 110, maxFrames = 60 } = o;
    dur = Math.max(0, dur || sb.duration || 0);
    const strip = U.el('div', stripCls);
    const effInt = sb.intervalMs > 0 ? sb.intervalMs / 1000 : (sb.duration / Math.max(1, sb.frames));
    const g = gridStep(pps, thumbPx, dur, maxFrames, effInt);
    const per = sb.cols * sb.rows;
    for (let t = 0; t < dur - 0.01; t += g) {
      const w = Math.min(g, dur - t);
      const fi = Math.min(sb.frames - 1, Math.max(0, Math.floor((t + w / 2) / effInt)));
      const sheet = Math.floor(fi / per);
      const pos = fi % per;
      const col = pos % sb.cols, row = Math.floor(pos / sb.cols);
      const cell = U.el('div', frameCls);
      cell.style.left = (t * pps) + 'px';
      cell.style.width = (w * pps) + 'px';
      cell.style.backgroundImage = `url('${sb.sheets[sheet]}')`;
      cell.style.backgroundSize = `${sb.cols * 100}% ${sb.rows * 100}%`;
      cell.style.backgroundPosition =
        `${sb.cols > 1 ? (col / (sb.cols - 1)) * 100 : 0}% ${sb.rows > 1 ? (row / (sb.rows - 1)) * 100 : 0}%`;
      strip.appendChild(cell);
    }
    return strip;
  }

  window.CT = {
    TYPES, byType, label, badge, badgeEl, hint, displayName,
    buildAddForm, itemControls,
    NOMINAL_END, flatten, blockDur,
    buildFilmstrip, ytStoryboard, buildYtFilmstrip
  };
})();
