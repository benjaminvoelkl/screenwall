// Playlist-Editor /playlists. Verwaltet PLAYLISTS + CONTENTS über die /api/playlist-
// Routen; der Server persistiert und broadcastet. Per WebSocket bleiben mehrere
// Editoren und alle /screen-Geräte synchron. Änderungen landen im Entwurf; das
// Veröffentlichen ("Preview & Go Live") geschieht auf der Programm-Timeline (/programm)
// – die Entwurfs-Leiste oben führt dorthin.
//
// Gemeinsame Bausteine: ui.js (Dialoge, Toasts, Formularfelder, WebSocket) und
// content.js (Content-Typ-Register: Kacheln, Felder, Storyboard-Symbole).

(() => {
  const U = window.UI;
  const CT = window.CT;
  const { $, fmtClock, escapeHtml } = U;

  let state = null;
  // Modus aus der URL: ?edit=<id> = Detail/Bearbeiten einer Playlist, sonst Übersicht.
  const editId = new URLSearchParams(location.search).get('edit');
  const detailMode = !!editId;
  let selectedId = editId;      // im Detail-Modus die bearbeitete Playlist
  let liveNowPlaying = null;    // Was läuft gerade live auf der Wand?
  let lastPlSig = null;         // Signatur des zuletzt gezeichneten Zustands

  const playlists = () => state.playlists;
  const selPl = () => playlists().byId[selectedId] || playlists().byId[playlists().rootId];
  const isRoot = (pl) => pl.id === playlists().rootId;

  // ---- Gemeinsame Kopf-/Fußzeile -----------------------------------------
  U.topbarNav('playlists');
  U.bindVolume();
  // Veröffentlicht wird auf /programm (mit Vorschau + Slide-Bestätigung); die
  // Leiste führt dorthin, damit es genau einen Weg auf die Wand gibt.
  const draft = U.draftBar();

  // ---- WebSocket (Status + Live-Sync) ------------------------------------
  U.connectState({
    onConn: U.bindConnDot(),
    onDirty: (dirty) => draft.update({ dirty, show: dirty }),
    onState: (s) => {
      // Der Server sendet bei JEDER Änderung (auch aus anderen Tabs) den ganzen
      // Zustand. Nur neu zeichnen, wenn sich an den Playlists wirklich etwas
      // geändert hat – sonst reißt es Scrollposition und Fokus weg.
      const sig = playlistSig(s);
      const changed = sig !== lastPlSig;
      lastPlSig = sig;
      state = s;
      if (changed) render();
    },
    onCmd: (msg) => {
      if (msg.cmd !== 'nowplaying') return;
      liveNowPlaying = msg;
      applyLiveNow();
      // Früher wurde hier die ganze Übersicht neu gebaut – einmal pro Sekunde,
      // was jedes Scrollen sofort wieder nach oben riss. Die Abzeichen lassen
      // sich am bestehenden DOM ändern.
      applyLiveOverview();
    }
  });
  U.api('GET', '/api/state', undefined, { quiet: true })
    .then((s) => { state = s; render(); })
    .catch(() => {});

  // Übersicht bei Größenänderung neu zeichnen (Zeitleisten füllen die Breite neu).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (detailMode) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state) renderOverview(); }, 150);
  });
  // Echte Video-/YouTube-Längen nachtragen, damit die Storyboard-Breiten stimmen.
  U.api('POST', '/api/probe-durations', undefined, { quiet: true }).catch(() => {});

  // ===== Playlist-Verwaltung ==============================================
  // Kein Dialog: Anlegen und Bearbeiten waren zwei Etappen, die dieselben drei
  // Felder abgefragt haben. Der Knopf legt jetzt direkt an und öffnet die
  // Detailseite mit markiertem Namen – Name, KI-Kontext und Nachfolge-Aktion
  // stehen dort, an genau einer Stelle.
  $('pl-new').addEventListener('click', async () => {
    const n = Object.keys(playlists().byId).length + 1;
    try {
      const pl = await U.api('POST', '/api/playlist', { name: `Playlist ${n}` });
      if (pl && pl.id) location.href = `/playlists?edit=${pl.id}&neu=1`;
    } catch (_) {}
  });

  // Umbenennen direkt im Titel: Eingabe speichert beim Verlassen/Enter.
  const nameInput = $('pl-name');
  if (nameInput) {
    const commitName = () => {
      const pl = selPl();
      if (!pl) return;
      const v = nameInput.value.trim();
      if (!v || v === pl.name) { nameInput.value = pl.name; return; }
      U.save('POST', `/api/playlist/${pl.id}/rename`, { name: v }).catch(() => { nameInput.value = pl.name; });
    };
    nameInput.addEventListener('change', commitName);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); }
      if (e.key === 'Escape') { nameInput.value = selPl().name; nameInput.blur(); }
    });
  }
  // Frisch angelegt (?neu=1): der Name ist der einzige noch offene Punkt, also
  // gleich hineinspringen und markieren – tippen genügt.
  const isNew = new URLSearchParams(location.search).get('neu') === '1';
  let nameFocused = false;

  // ---- "Weitere Optionen": KI-Kontext + Nachfolge-Aktion ------------------
  // Beides wird selten angefasst und stand vorher doppelt (Anlege-Dialog UND
  // Detailseite). Jetzt einmal, eingeklappt. Die Felder tragen dieselben IDs
  // wie zuvor, damit die Handler unten unverändert bleiben.
  (function buildMoreOptions() {
    const host = $('pl-more');
    if (!host) return;

    const desc = U.textInput('');
    desc.id = 'pl-desc';
    desc.placeholder = 'z. B. „PV-Anlagen Referenzen"';
    const descField = U.field('KI-Kontext', desc);
    descField.appendChild(U.el('span', 'hint-inline',
      'Hilft beim Suchen und wenn eine KI die passende Playlist auswählen soll.'));

    const after = U.selectInput([
      ['loop', 'Wiederholen (Loop)'],
      ['stop', 'Stoppen (Standbild)'],
      ['next', 'Nächste Playlist abspielen']
    ], 'loop');
    after.id = 'pl-after';

    const next = U.el('select');
    next.id = 'pl-next';
    const nextWrap = U.field('Nächste Playlist', next);
    nextWrap.id = 'pl-next-wrap';
    nextWrap.classList.add('hidden');

    const row = U.el('div', 'row after-row');
    row.append(U.field('Wenn die Playlist endet', after), nextWrap);

    const body = U.el('div', 'pl-more-body');
    body.append(descField, row);
    host.appendChild(U.section({ key: 'pl.more', title: 'Weitere Optionen', open: false, body }));
  })();

  $('pl-desc').addEventListener('change', () => {
    const pl = selPl();
    if (pl) U.save('POST', `/api/playlist/${pl.id}/rename`, { description: $('pl-desc').value }).catch(() => {});
  });

  const setRoot = (pl) => U.save('POST', '/api/playlist/root', { id: pl.id }).catch(() => {});

  async function clonePlaylist(pl) {
    try {
      const copy = await U.api('POST', `/api/playlist/${pl.id}/clone`);
      if (copy && copy.id) location.href = '/playlists?edit=' + copy.id;
    } catch (_) {}
  }

  // Eine Löschfunktion für Karte UND Detailkopf (vorher zwei kopierte Blöcke).
  // Der Fall "letzte Playlist" wird nicht mehr hinterher gemeldet, sondern der
  // Menüpunkt ist von vornherein deaktiviert (siehe canDelete).
  const canDelete = () => Object.keys(playlists().byId).length > 1;
  async function deletePlaylist(pl, { backToOverview = false } = {}) {
    if (!canDelete()) return;
    const n = pl.items.length;
    const was = n === 0 ? 'ohne Einträge' : n === 1 ? 'mit ihrem einen Eintrag' : `mit allen ${n} Einträgen`;
    const ok = await U.confirmDialog({
      title: 'Playlist löschen?',
      text: `„${pl.name}" wird ${was} gelöscht. `
        + 'Hochgeladene Dateien, die nirgends sonst verwendet werden, werden mit entfernt.',
      confirmLabel: 'Löschen',
      danger: true
    });
    if (!ok) return;
    try {
      await U.api('DELETE', `/api/playlist/${pl.id}`);
      U.toast('Playlist gelöscht');
      if (backToOverview) location.href = '/playlists';
    } catch (_) {}
  }

  // Nachfolge-Aktion
  $('pl-after').addEventListener('change', sendAfter);
  $('pl-next').addEventListener('change', sendAfter);
  function sendAfter() {
    const pl = selPl();
    if (!pl) return;
    const after = $('pl-after').value;
    const nextId = after === 'next' ? $('pl-next').value : null;
    U.save('POST', `/api/playlist/${pl.id}/after`, { after, nextId }).catch(() => {});
  }

  // ===== Inhalt hinzufügen ================================================
  // Ein Dialog in zwei Schritten: erst Typ-Kachel wählen, dann nur die Felder,
  // die dieser Typ braucht. Ersetzt die alte Leiste aus 7 Schaltflächen,
  // 3 Textfeldern, einer Checkbox und einer Auswahlliste.
  $('pl-add').addEventListener('click', openAddDialog);

  function openAddDialog() {
    const pl = selPl();
    if (!pl) return;
    const body = U.el('div');
    const grid = U.el('div', 'type-grid');
    body.appendChild(grid);

    let dlg = null;
    for (const t of CT.TYPES) {
      const tile = U.el('button', 'type-tile');
      tile.type = 'button';
      tile.setAttribute('aria-pressed', 'false');
      tile.append(
        Object.assign(U.el('span', 'tt-badge', t.badge), { ariaHidden: 'true' }),
        U.el('span', 'tt-label', t.label),
        U.el('span', 'tt-hint', t.hint)
      );
      tile.addEventListener('click', () => { dlg.close(); openAddStep2(t, pl); });
      grid.appendChild(tile);
    }

    dlg = U.dialog({
      title: 'Inhalt hinzufügen',
      body,
      wide: true,
      actions: [{ label: 'Abbrechen', cls: 'ghost', onClick: (h) => h.close() }]
    });
  }

  function openAddStep2(type, pl) {
    const ctx = {
      playlistId: pl.id,
      playlists: Object.values(playlists().byId),
      uploadFiles
    };
    const form = CT.buildAddForm(type.type, ctx);

    const body = U.el('div');
    // Kopf mit gewähltem Typ + Erklärung: der Nutzer weiß, wo er ist und was der Typ tut.
    const chosen = U.el('div', 'type-chosen');
    const txt = U.el('div');
    txt.append(U.el('div', 'tt-label', type.label), U.el('div', 'tt-hint', type.hint));
    chosen.append(Object.assign(U.el('span', 'tt-badge', type.badge), { ariaHidden: 'true' }), txt);
    body.append(chosen, form.node);

    let busy = false;
    U.dialog({
      title: 'Inhalt hinzufügen',
      body,
      actions: [
        { label: '← Zurück', cls: 'ghost', onClick: (h) => { h.close(); openAddDialog(); } },
        { label: 'Abbrechen', cls: 'ghost', onClick: (h) => h.close() },
        {
          label: 'Hinzufügen',
          onClick: async (h) => {
            if (busy) return;
            busy = true;
            try {
              await form.submit();
              h.close();
              U.toast('Hinzugefügt');
            } catch (_) {
              // Fehler stehen am Feld (Validierung) oder kamen schon als Toast.
            }
            busy = false;
          }
        }
      ]
    });
  }

  // Upload (Bild/Video) mit optionalem 18:16-Crop für Bilder.
  async function uploadFiles(files, wantCrop) {
    for (const file of files) {
      if (wantCrop && file.type.startsWith('image/')) await cropThenUpload(file);
      else await uploadFile(file);
    }
  }
  async function uploadFile(fileOrBlob, filename) {
    const pl = selPl();
    if (!pl) return;
    const fd = new FormData();
    fd.append('playlistId', pl.id);
    fd.append('file', fileOrBlob, filename || fileOrBlob.name || 'upload');
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    if (!r.ok) { U.toast('Upload fehlgeschlagen', 'err', 4000); throw new Error('upload'); }
  }

  // --- Crop-Dialog (Cropper.js, 18:16 = 9:8) ---
  // Fehlt die CDN-Bibliothek (offline), wird das Original hochgeladen.
  function cropThenUpload(file) {
    if (typeof window.Cropper !== 'function') {
      U.toast('Zuschneiden nicht verfügbar (Bibliothek fehlt) – Original wird verwendet', 'err', 4500);
      return uploadFile(file);
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = U.el('img');
      img.alt = '';
      const stage = U.el('div', 'crop-stage');
      stage.appendChild(img);
      const body = U.el('div');
      body.append(U.el('p', 'modal-hint', `„${file.name}" auf 18:16 zuschneiden – Ausschnitt ziehen und bestätigen.`), stage);

      let cropper = null;
      const finish = async (useCrop, h) => {
        h.close();
        try {
          if (useCrop && cropper) {
            const canvas = cropper.getCroppedCanvas();
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
            await uploadFile(blob, (file.name.replace(/\.[^.]+$/, '') || 'bild') + '-18x16.jpg');
          } else {
            await uploadFile(file);
          }
        } catch (_) {}
        if (cropper) cropper.destroy();
        URL.revokeObjectURL(url);
        resolve();
      };

      const h = U.dialog({
        title: 'Auf 18:16 zuschneiden',
        body,
        wide: true,
        actions: [
          { label: 'Original verwenden', cls: 'ghost', onClick: (hh) => finish(false, hh) },
          { label: 'Zuschneiden & hochladen', onClick: (hh) => finish(true, hh) }
        ]
      });
      img.onload = () => { cropper = new window.Cropper(img, { aspectRatio: 18 / 16, viewMode: 1, autoCropArea: 1 }); };
      img.src = url;
      void h;
    });
  }

  // ===== Item-Operationen =================================================
  function patchContent(itemId, content) {
    const pl = selPl();
    if (pl) U.save('PATCH', `/api/playlist/${pl.id}/items/${itemId}`, { content }).catch(() => {});
  }
  async function deleteItem(item) {
    const pl = selPl();
    if (!pl) return;
    const what = item.kind === 'playlist'
      ? `die eingebettete Playlist „${(playlists().byId[item.refId] || {}).name || '—'}"`
      : `„${CT.displayName(item.content)}"`;
    const ok = await U.confirmDialog({
      title: 'Eintrag entfernen?',
      text: `${what} wird aus dieser Playlist entfernt.`,
      confirmLabel: 'Entfernen',
      danger: true
    });
    if (ok) U.save('DELETE', `/api/playlist/${pl.id}/items/${item.id}`).catch(() => {});
  }
  function saveItemOrder(order) {
    const pl = selPl();
    if (pl) U.save('POST', `/api/playlist/${pl.id}/items/order`, { order }).catch(() => {});
  }

  // ===== Rendering ========================================================
  function render() {
    if (!state) return;
    const pls = playlists();
    if (detailMode && pls.byId[editId]) { selectedId = editId; renderDetail(); }
    else renderOverview();
  }
  function showMode(detail) { $('pl-overview').hidden = detail; $('pl-detail').hidden = !detail; }

  // ----- Detail/Bearbeiten -------------------------------------------------
  function renderDetail() {
    showMode(true);
    const pls = playlists();
    const pl = selPl();
    document.title = `Screenwall – ${pl.name}`;
    U.setIfNotFocused($('pl-name'), pl.name);
    U.setIfNotFocused($('pl-desc'), pl.description || '');
    $('pl-root-badge').classList.toggle('hidden', !isRoot(pl));
    if (isNew && !nameFocused) { nameFocused = true; $('pl-name').focus(); $('pl-name').select(); }

    renderDetailActions(pl);

    // Nachfolge-Auswahl
    const next = $('pl-next');
    if (document.activeElement !== next) {
      next.innerHTML = '';
      for (const p of Object.values(pls.byId)) {
        if (p.id === pl.id) continue;
        const o = U.el('option', null, p.name); o.value = p.id;
        next.appendChild(o);
      }
    }
    U.setIfNotFocused($('pl-after'), pl.after);
    $('pl-next-wrap').classList.toggle('hidden', pl.after !== 'next');
    if (pl.nextId && document.activeElement !== next) next.value = pl.nextId;

    renderItems(pl);
  }

  // Zwei sichtbare Aktionen + ⋯-Menü – dieselbe Systematik wie auf den Karten.
  function renderDetailActions(pl) {
    const host = $('pl-detail-actions');
    host.innerHTML = '';
    if (!isRoot(pl)) {
      host.appendChild(U.btn('▶ Abspielen', 'play', () => openPlayConfirm(pl)));
      host.appendChild(U.btn('★ Als Start setzen', 'ghost', () => setRoot(pl)));
    }
    host.appendChild(U.overflowMenu([
      { label: '⧉ Klonen', onClick: () => clonePlaylist(pl) },
      {
        label: '🗑 Löschen',
        danger: true,
        disabled: !canDelete(),
        title: canDelete() ? '' : 'Mindestens eine Playlist muss bestehen bleiben.',
        onClick: () => deletePlaylist(pl, { backToOverview: true })
      }
    ], { label: `Weitere Aktionen für „${pl.name}"` }));
  }

  // ----- Übersicht: alle Playlists als Karten mit Storyboard ---------------
  function renderOverview() {
    showMode(false);
    const cards = $('pl-cards');
    // Reihenfolge ist wichtig: erst messen, dann bauen, dann in EINEM Zug
    // tauschen. Wird vorher geleert, fällt die Dokumenthöhe auf 0, der Browser
    // klemmt scrollY auf 0 – und die Seite springt nach oben.
    const avail = storyboardWidth();
    const y = window.scrollY;
    const frag = document.createDocumentFragment();
    for (const pl of Object.values(playlists().byId)) frag.appendChild(buildPlaylistCard(pl, avail));
    cards.replaceChildren(frag);
    if (window.scrollY !== y) window.scrollTo(0, y);
  }

  // Innenbreite, die einer Storyboard-Zeitleiste zur Verfügung steht: Kartenbreite
  // minus Karten-Padding (14*2) und Storyboard-Padding (6*2).
  function storyboardWidth() {
    const w = $('pl-cards').clientWidth || (window.innerWidth - 48);
    return Math.max(160, w - 40);
  }

  // Läuft gerade ein Inhalt DIESER Playlist auf der Wand? (Rot = live, nur dafür.)
  function isLive(pl) {
    const cid = liveNowPlaying && liveNowPlaying.contentId;
    if (!cid) return false;
    return CT.flatten(pl.id, playlists().byId).some((e) => e.itemId === cid);
  }

  function buildPlaylistCard(pl, avail) {
    const start = isRoot(pl), live = isLive(pl);
    const card = U.el('div', 'pl-card' + (start ? ' is-start' : '') + (live ? ' is-live' : ''));
    card.dataset.plId = pl.id;   // damit applyLiveOverview() die Karte wiederfindet

    const head = U.el('div', 'pl-card-head');
    const title = U.el('div', 'pl-card-title');
    title.appendChild(U.el('span', 'pl-card-name', pl.name));
    // Zwei verschiedene Dinge, zwei Abzeichen: "Start" beginnt die Übertragung,
    // "Live" heißt, dass daraus JETZT etwas auf der Wand läuft.
    if (start) title.appendChild(U.el('span', 'badge start', '★ Start'));
    if (live) title.appendChild(U.el('span', 'badge live', '● Live'));

    const seq = CT.flatten(pl.id, playlists().byId);
    const total = seq.reduce((a, e) => a + CT.blockDur(e.itemId, e.content), 0);
    const meta = U.el('div', 'pl-card-meta', `${seq.length} Inhalte · ${fmtClock(total)}`);
    head.append(title, meta);
    card.appendChild(head);

    // Der KI-Kontext ist Kontext für die Suche/LLM, keine Bildunterschrift –
    // auf den Karten stand er nur im Weg.

    // px pro Sekunde, sodass die Playlist genau die Kartenbreite füllt.
    card.appendChild(buildStoryboard(seq, total > 0 ? avail / total : 0));

    // Zwei sichtbare Aktionen, alles Weitere im ⋯-Menü.
    const acts = U.el('div', 'pl-card-acts');
    if (!start) {
      const play = U.btn('▶ Abspielen', 'play', () => openPlayConfirm(pl));
      play.title = 'Diese Playlist sofort live auf die Wand schalten';
      acts.appendChild(play);
    }
    acts.appendChild(U.btn('Bearbeiten', '', () => { location.href = '/playlists?edit=' + pl.id; }));
    acts.appendChild(U.overflowMenu([
      {
        label: '★ Als Start setzen',
        disabled: start,
        title: start ? 'Diese Playlist startet die Übertragung bereits.' : '',
        onClick: () => setRoot(pl)
      },
      { label: '⧉ Klonen', onClick: () => clonePlaylist(pl) },
      'sep',
      {
        label: '🗑 Löschen',
        danger: true,
        disabled: !canDelete(),
        title: canDelete() ? '' : 'Mindestens eine Playlist muss bestehen bleiben.',
        onClick: () => deletePlaylist(pl)
      }
    ], { label: `Weitere Aktionen für „${pl.name}"` }));
    card.appendChild(acts);
    return card;
  }

  // ----- Storyboard (kompakte Mini-Timeline; Filmstreifen je Video) --------
  const SB_OPT = { stripCls: 'pl-fs', frameCls: 'pl-fr', thumbPx: 90, maxFrames: 24 };
  const YT_SB_OPT = { ...SB_OPT, frameCls: 'pl-fr sb' };

  // Volle-Breite-Zeitleiste: Blockbreite proportional zur Dauer (pps = px/Sekunde,
  // vom Aufrufer so gewählt, dass die ganze Playlist die Kartenbreite füllt).
  function buildStoryboard(seq, pps) {
    const strip = U.el('div', 'pl-storyboard');
    if (!seq.length) { strip.classList.add('empty'); strip.textContent = 'Noch keine Inhalte'; return strip; }
    for (const e of seq) {
      const c = e.content;
      const dur = CT.blockDur(e.itemId, c);
      const w = Math.max(2, dur * pps);
      const block = U.el('div', 'pl-sb-block type-' + c.type);
      block.style.width = w + 'px';
      if (c.type === 'color') block.style.background = c.color || '#000';
      else if (c.type === 'image') block.style.backgroundImage = `url('/uploads/${c.filename}')`;
      else if (c.type === 'youtube') {
        block.style.backgroundImage = `url('https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg')`;
        const sb = CT.ytStoryboard(c.videoId, () => { if (!detailMode) renderOverview(); });
        if (sb) block.appendChild(CT.buildYtFilmstrip(sb, dur, pps, YT_SB_OPT));
      } else if (c.type === 'video' && c.filename) {
        block.appendChild(CT.buildFilmstrip(c.filename, dur, pps, SB_OPT));
      }
      const badge = U.el('span', 'pl-sb-badge', CT.badge(c.type));
      badge.title = CT.label(c.type);
      block.appendChild(badge);
      // Name + Dauer – nur zeigen, wenn der Block breit genug ist.
      if (w >= 48) {
        const label = U.el('div', 'pl-sb-label');
        label.innerHTML = `${escapeHtml(CT.displayName(c))} <span class="pl-sb-dur">${fmtClock(dur)}</span>`;
        block.appendChild(label);
      }
      strip.appendChild(block);
    }
    return strip;
  }

  // ----- Einträge der Playlist --------------------------------------------
  function renderItems(pl) {
    const ul = $('pl-items');
    // Die Felder je Eintrag (Name, Dauer, …) werden hier komplett neu gebaut.
    // Passiert das, während jemand darin tippt, ist der Fokus weg und die
    // Eingabe halb verloren. Also verschieben, bis das Feld verlassen wird.
    if (ul.contains(document.activeElement)) {
      if (!pendingItems) {
        pendingItems = true;
        ul.addEventListener('focusout', () => {
          pendingItems = false;
          // Erst nachdem der Fokus wirklich draußen ist (focusout feuert vor
          // dem Setzen des neuen activeElement).
          setTimeout(() => { if (state && detailMode && !ul.contains(document.activeElement)) renderDetail(); }, 0);
        }, { once: true });
      }
      return;
    }
    ul.replaceChildren(...pl.items.map(buildItemEl));
    enableDragReorder(ul, () => saveItemOrder(Array.from(ul.children).map((c) => c.dataset.id)));
    applyLiveNow();
  }
  let pendingItems = false;

  function buildItemEl(item) {
    const li = U.el('li', 'media-item');
    li.draggable = true;
    li.dataset.id = item.id;

    const drag = U.el('span', 'drag', '⠿');
    drag.setAttribute('aria-hidden', 'true');
    li.appendChild(drag);

    if (item.kind === 'playlist') {
      const ref = playlists().byId[item.refId];
      li.classList.add('item-playlist');
      const meta = U.el('span', 'meta');
      meta.innerHTML = `<div class="name">▶ Playlist: ${escapeHtml(ref ? ref.name : '—')}</div>
        <div class="type">eingebettete Playlist${ref ? ` (${ref.items.length} Inhalte)` : ''}</div>`;
      if (ref) {
        const open = U.btn('Öffnen', 'ghost tiny', () => { location.href = '/playlists?edit=' + ref.id; });
        const ctrls = U.el('div', 'content-ctrls');
        ctrls.appendChild(open);
        meta.appendChild(ctrls);
      }
      li.appendChild(meta);
    } else {
      const c = item.content;
      if (c.type === 'youtube') li.dataset.videoId = c.videoId || '';
      li.appendChild(buildThumb(c));
      li.appendChild(buildMeta(item));
    }

    li.appendChild(U.iconBtn('🗑', item.kind === 'playlist'
      ? 'Eingebettete Playlist entfernen'
      : `„${CT.displayName(item.content)}" entfernen`, 'del', () => deleteItem(item)));
    return li;
  }

  function buildThumb(c) {
    if (c.type === 'color') {
      const sw = U.el('span', 'thumb color-swatch');
      sw.style.background = c.color || '#000';
      return sw;
    }
    if (c.type === 'image') {
      const img = U.el('img', 'thumb');
      img.src = `/uploads/${c.filename}`; img.alt = '';
      return img;
    }
    if (c.type === 'video') {
      const v = U.el('video', 'thumb');
      v.src = `/uploads/${c.filename}`; v.muted = true;
      return v;
    }
    if (c.type === 'youtube') {
      const img = U.el('img', 'thumb');
      img.src = `https://i.ytimg.com/vi/${c.videoId}/default.jpg`; img.alt = '';
      return img;
    }
    const badge = U.el('span', 'thumb type-badge', CT.badge(c.type));
    badge.title = CT.label(c.type);
    return badge;
  }

  // Name, Typ und die typspezifischen Felder – die Felder selbst kommen aus dem
  // Content-Typ-Register, damit alle Typen dieselbe Reihenfolge haben.
  function buildMeta(item) {
    const c = item.content;
    const meta = U.el('span', 'meta');

    const name = U.el('div', 'name');
    if (c.type === 'webpage' || c.type === 'external') {
      const a = U.el('a', null, c.name || c.url || '(Adresse)');
      a.href = c.url; a.target = '_blank'; a.rel = 'noopener';
      name.appendChild(a);
    } else if (c.type === 'youtube') {
      const a = U.el('a', null, c.name || c.videoId);
      a.href = `https://www.youtube.com/watch?v=${c.videoId}`; a.target = '_blank'; a.rel = 'noopener';
      name.appendChild(a);
    } else {
      name.textContent = CT.displayName(c);
    }
    meta.appendChild(name);
    meta.appendChild(U.el('div', 'type', CT.label(c.type)));

    // Live-Fortschritt (wird von applyLiveNow gefüllt) – für alle zeitbasierten Typen.
    if (c.type === 'youtube' || c.type === 'video') {
      const now = U.el('div', 'yt-now hidden');
      now.innerHTML = `<span class="yt-badge">▶ läuft</span>
        <div class="yt-progress"><div class="yt-progress-bar"></div></div>
        <span class="yt-time">–</span>`;
      meta.appendChild(now);
    }

    const ctrls = U.el('div', 'content-ctrls');
    for (const node of CT.itemControls(item, {
      patch: (fields) => patchContent(item.id, fields),
      recheck: () => U.save('POST', '/api/link/recheck', { playlistId: selPl().id, itemId: item.id }).catch(() => {})
    })) ctrls.appendChild(node);
    meta.appendChild(ctrls);
    return meta;
  }

  // ===== Live-Hervorhebung (roter Rahmen für den Wand-Content) ============
  // Was die Seite zeichnet, hängt nur hieran. Ändert sich die Signatur nicht,
  // muss auch nichts neu gebaut werden (Lautstärke, Overlays, fremde Felder
  // lösen sonst ein Neuzeichnen aus, das Scrollposition und Fokus kostet).
  // Die Inhalte hängen verschachtelt in den Einträgen (items[].content), es gibt
  // keine flache contents-Liste. Statt einzelne Felder aufzuzählen und dabei
  // eines zu vergessen, wird der ganze playlists-Teilbaum verglichen – alles,
  // was diese Seite zeichnet, steckt darin. Overlays und Bibliothek nicht,
  // deren Änderungen sollen hier auch nichts neu bauen.
  function playlistSig(s) {
    return s && s.playlists ? JSON.stringify(s.playlists) : '';
  }

  // Live-Abzeichen der Übersichtskarten am bestehenden DOM ändern, statt die
  // Karten neu zu bauen. Läuft im Sekundentakt – darf also nichts umbauen.
  function applyLiveOverview() {
    const host = $('pl-cards');
    if (!host || detailMode || !state) return;
    for (const card of host.children) {
      const pl = playlists().byId[card.dataset.plId];
      const live = !!pl && isLive(pl);
      if (card.classList.contains('is-live') === live) continue;
      card.classList.toggle('is-live', live);
      const title = card.querySelector('.pl-card-title');
      if (!title) continue;
      const badge = title.querySelector('.badge.live');
      if (live && !badge) title.appendChild(U.el('span', 'badge live', '● Live'));
      else if (!live && badge) badge.remove();
    }
  }

  function applyLiveNow() {
    const np = liveNowPlaying;
    const ul = $('pl-items');
    if (!ul) return;
    for (const li of ul.children) {
      const match = !!np && np.contentId && li.dataset.id === np.contentId;
      li.classList.toggle('live-now', match);
      const now = li.querySelector('.yt-now');
      if (!now) continue;
      now.classList.toggle('hidden', !match);
      if (match) {
        const dur = np.duration || 0, t = np.time || 0;
        const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
        now.querySelector('.yt-progress-bar').style.width = `${pct}%`;
        now.querySelector('.yt-time').textContent = dur > 0 ? `${fmtClock(t)} / ${fmtClock(dur)}` : fmtClock(t);
      }
    }
  }

  // ===== Drag & Drop Reorder ==============================================
  function enableDragReorder(container, onDrop) {
    let dragging = null;
    container.querySelectorAll('.media-item').forEach((item) => {
      item.addEventListener('dragstart', () => { dragging = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => { item.classList.remove('dragging'); dragging = null; onDrop(); });
    });
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const after = getDragAfter(container, e.clientY);
      if (after == null) container.appendChild(dragging);
      else container.insertBefore(dragging, after);
    });
  }
  function getDragAfter(container, y) {
    const items = [...container.querySelectorAll('.media-item:not(.dragging)')];
    let closest = { offset: -Infinity, el: null };
    for (const child of items) {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
    }
    return closest.el;
  }

  // ===== Slide-to-Play: Playlist sofort live abspielen ====================
  // Bewusst mit Schiebe-Geste bestätigt (wie „Slide to go live"), weil die Wand
  // sofort umschaltet – ohne Entwurf und ohne Go Live.
  function openPlayConfirm(pl) {
    const body = U.el('div');
    body.appendChild(U.el('p', 'modal-hint',
      `Ersetzt sofort den Inhalt auf der Wand und macht „${pl.name}" zur Start-Playlist.`));
    const slider = U.buildSlide({ label: 'Zum Abspielen schieben →', glyph: '▶' });
    body.appendChild(slider);

    const h = U.dialog({
      title: `„${pl.name}" sofort live abspielen?`,
      body,
      actions: [{ label: 'Abbrechen', cls: 'ghost', onClick: (hh) => hh.close() }]
    });
    U.bindSlide(slider, async (reset) => {
      try {
        await U.api('POST', '/api/play', { playlistId: pl.id });
        U.toast(`Live: ${pl.name}`);
        h.close();
      } catch (_) { reset(); }
    });
  }
})();
