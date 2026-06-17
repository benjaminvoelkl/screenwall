// Steuerseite /settings. Verwaltet PLAYLISTS + CONTENTS über die /api/playlist-
// Routen; der Server persistiert und broadcastet. Per WebSocket bleiben mehrere
// Steuerseiten und alle /screen-Geräte synchron. Änderungen landen im Entwurf;
// die Wand ändert sich erst per "Preview & Go Live".

(() => {
  const $ = (id) => document.getElementById(id);

  let state = null;
  let selectedId = null;        // aktuell bearbeitete Playlist (nur UI-Auswahl)
  let liveNowPlaying = null;    // Was läuft gerade live auf der Wand?

  // ---- API-Helfer ---------------------------------------------------------
  async function api(method, url, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(url, opt);
    return r.json().catch(() => ({}));
  }
  const playlists = () => state.playlists;
  function selPl() { return playlists().byId[selectedId] || playlists().byId[playlists().rootId]; }

  function setIfNotFocused(el, value) {
    if (!el || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
  }

  // ---- WebSocket (Status + Live-Sync) ------------------------------------
  let ws = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/?role=control`);
    ws.addEventListener('open', () => setConn(true));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') {
          state = msg.state;
          if (typeof msg.dirty === 'boolean') setDirty(msg.dirty);
          render();
        } else if (msg.type === 'cmd' && msg.cmd === 'nowplaying') {
          liveNowPlaying = msg;
          applyLiveNow();
        }
      } catch (_) {}
    });
    ws.addEventListener('close', () => { setConn(false); setTimeout(connect, 1500); });
    ws.addEventListener('error', () => ws.close());
  }
  function setConn(on) {
    $('conn-dot').classList.toggle('on', on);
    $('conn-text').textContent = on ? 'verbunden' : 'getrennt – verbinde neu…';
  }
  connect();
  fetch('/api/state').then((r) => r.json()).then((s) => { state = s; render(); });

  // ---- Go Live ------------------------------------------------------------
  function setDirty(dirty) {
    const live = $('go-live');
    if (live) {
      live.classList.toggle('hidden', !dirty);
      live.classList.toggle('pending', dirty);
      live.textContent = '● Preview & Go Live';
    }
  }
  $('go-live').addEventListener('click', openGoLive);

  const PREVIEW_W = 4320, PREVIEW_H = 3840; // echte Wandfläche (18:16)
  function scaleGoliveStage() {
    const stage = $('golive-stage');
    const wrap = $('golive-frame-wrap');
    if (!stage || stage.offsetParent === null) return;
    const availW = window.innerWidth * 0.9;
    const availH = window.innerHeight * 0.62;
    const scale = Math.max(0.01, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    stage.style.width = Math.round(PREVIEW_W * scale) + 'px';
    stage.style.height = Math.round(PREVIEW_H * scale) + 'px';
    wrap.style.transform = `scale(${scale})`;
  }
  function openGoLive() {
    $('golive-frame').src = '/screen'; // Entwurf
    $('golive-modal').classList.remove('hidden');
    resetSlide();
    scaleGoliveStage();
    requestAnimationFrame(scaleGoliveStage);
  }
  function closeGoLive() {
    $('golive-modal').classList.add('hidden');
    $('golive-frame').src = '';
    resetSlide();
  }
  $('golive-cancel').addEventListener('click', closeGoLive);
  $('golive-modal').addEventListener('click', (e) => { if (e.target === $('golive-modal')) closeGoLive(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('golive-modal').classList.contains('hidden')) closeGoLive();
  });

  // ---- Slide-to-go-live ---------------------------------------------------
  let slideX = 0, sliding = false, slideDone = false;
  function slideTravel() { return $('golive-slider').clientWidth - $('slide-handle').offsetWidth - 8; }
  function setSlide(x) {
    const max = slideTravel();
    slideX = Math.max(0, Math.min(max, x));
    $('slide-handle').style.transform = `translateX(${slideX}px)`;
    $('slide-fill').style.width = `${slideX + $('slide-handle').offsetWidth}px`;
  }
  function resetSlide() {
    slideDone = false; sliding = false;
    $('slide-handle').style.transition = '';
    setSlide(0);
  }
  async function fireGoLive() {
    if (slideDone) return;
    slideDone = true;
    setSlide(slideTravel());
    try { await fetch('/api/golive', { method: 'POST' }); } catch (_) {}
    location.href = '/'; // zurück zum Live-Monitor
  }
  (function bindSlide() {
    const handle = $('slide-handle');
    let startX = 0, startSlide = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (slideDone) return;
      sliding = true; startX = e.clientX; startSlide = slideX;
      handle.style.transition = 'none';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => { if (sliding) setSlide(startSlide + (e.clientX - startX)); });
    const end = () => {
      if (!sliding) return;
      sliding = false;
      handle.style.transition = 'transform 0.2s ease';
      if (slideX >= slideTravel() * 0.95) fireGoLive();
      else setSlide(0);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  window.addEventListener('resize', () => {
    if (!$('golive-modal').classList.contains('hidden')) { scaleGoliveStage(); if (!sliding) setSlide(slideDone ? slideTravel() : 0); }
  });

  // ===== Playlist-Verwaltung ==============================================
  $('pl-select').addEventListener('change', (e) => { selectedId = e.target.value; render(); });

  $('pl-new').addEventListener('click', async () => {
    const n = Object.keys(playlists().byId).length + 1;
    const name = prompt('Name der neuen Playlist:', `Playlist ${n}`);
    if (name === null) return;
    const pl = await api('POST', '/api/playlist', { name });
    if (pl && pl.id) selectedId = pl.id;
  });

  $('pl-rename').addEventListener('click', async () => {
    const pl = selPl();
    if (!pl) return;
    const name = prompt('Neuer Name:', pl.name);
    if (name === null) return;
    await api('POST', `/api/playlist/${pl.id}/rename`, { name });
  });

  $('pl-delete').addEventListener('click', async () => {
    const pl = selPl();
    if (!pl) return;
    if (Object.keys(playlists().byId).length <= 1) { alert('Mindestens eine Playlist muss bestehen bleiben.'); return; }
    if (!confirm(`Playlist „${pl.name}" mit allen Inhalten löschen?`)) return;
    await api('DELETE', `/api/playlist/${pl.id}`);
    selectedId = null;
  });

  $('pl-setroot').addEventListener('click', async () => {
    const pl = selPl();
    if (pl) await api('POST', '/api/playlist/root', { id: pl.id });
  });

  // Nachfolge-Aktion
  $('pl-after').addEventListener('change', () => sendAfter());
  $('pl-next').addEventListener('change', () => sendAfter());
  function sendAfter() {
    const pl = selPl();
    if (!pl) return;
    const after = $('pl-after').value;
    const nextId = after === 'next' ? $('pl-next').value : null;
    api('POST', `/api/playlist/${pl.id}/after`, { after, nextId });
  }

  // ===== Inhalte hinzufügen ===============================================
  document.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => addContentByType(btn.dataset.add));
  });
  $('pl-yt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addContentByType('youtube'); });
  $('pl-web-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addContentByType('webpage'); });

  async function addItem(item) {
    const pl = selPl();
    if (!pl) return;
    return api('POST', `/api/playlist/${pl.id}/items`, item);
  }

  async function addContentByType(type) {
    if (type === 'color') {
      await addItem({ kind: 'content', content: { type: 'color', color: '#1e293b', name: 'Farbe', durationSec: 6 } });
    } else if (type === 'youtube') {
      const raw = $('pl-yt-input').value.trim();
      if (!raw) return;
      const id = parseYoutubeId(raw);
      if (!id) { alert('Konnte keine YouTube-ID erkennen.'); return; }
      $('pl-yt-input').value = '';
      await addItem({ kind: 'content', content: { type: 'youtube', videoId: id, name: raw, muted: true, crop: false, videoMode: 'end' } });
    } else if (type === 'webpage') {
      const url = normalizeUrl($('pl-web-input').value.trim());
      if (!url) { alert('Bitte eine gültige URL eingeben.'); return; }
      $('pl-web-input').value = '';
      const pl = selPl();
      await api('POST', '/api/link', { url, playlistId: pl.id });
    } else if (type === 'screenshare') {
      const url = prompt('Quelle der Bildschirmübertragung (für später, optional):', '');
      if (url === null) return;
      await addItem({ kind: 'content', content: { type: 'screenshare', url: url.trim(), name: 'Bildschirm', durationSec: 15 } });
    } else if (type === 'playlist') {
      const refId = $('pl-sub-select').value;
      if (!refId) { alert('Keine Playlist zum Einbetten ausgewählt.'); return; }
      const res = await addItem({ kind: 'playlist', refId });
      if (res && res.error) alert(res.error);
    }
  }

  // Upload (Bild/Video) mit optionalem 18:16-Crop für Bilder.
  $('pl-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const wantCrop = $('pl-crop-toggle').checked;
    for (const file of files) {
      if (wantCrop && file.type.startsWith('image/')) await cropThenUpload(file);
      else await uploadFile(file);
    }
  });
  async function uploadFile(fileOrBlob, filename) {
    const pl = selPl();
    if (!pl) return;
    const fd = new FormData();
    fd.append('playlistId', pl.id);
    fd.append('file', fileOrBlob, filename || fileOrBlob.name || 'upload');
    await fetch('/api/upload', { method: 'POST', body: fd });
  }

  // --- Crop-Dialog (Cropper.js, 18:16 = 9:8) ---
  let cropper = null, cropResolve = null;
  function cropThenUpload(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = $('crop-img');
      img.src = url;
      $('crop-modal').classList.remove('hidden');
      img.onload = () => {
        if (cropper) cropper.destroy();
        cropper = new Cropper(img, { aspectRatio: 18 / 16, viewMode: 1, autoCropArea: 1 });
      };
      cropResolve = async (useCrop) => {
        $('crop-modal').classList.add('hidden');
        if (useCrop && cropper) {
          const canvas = cropper.getCroppedCanvas();
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
          await uploadFile(blob, (file.name.replace(/\.[^.]+$/, '') || 'bild') + '-18x16.jpg');
        } else {
          await uploadFile(file);
        }
        if (cropper) { cropper.destroy(); cropper = null; }
        URL.revokeObjectURL(url);
        resolve();
      };
    });
  }
  $('crop-confirm').addEventListener('click', () => cropResolve && cropResolve(true));
  $('crop-cancel').addEventListener('click', () => cropResolve && cropResolve(false));

  // ===== Item-Operationen =================================================
  function patchContent(itemId, content) {
    const pl = selPl();
    if (pl) api('PATCH', `/api/playlist/${pl.id}/items/${itemId}`, { content });
  }
  function deleteItem(itemId) {
    const pl = selPl();
    if (pl) api('DELETE', `/api/playlist/${pl.id}/items/${itemId}`);
  }
  function saveItemOrder(order) {
    const pl = selPl();
    if (pl) api('POST', `/api/playlist/${pl.id}/items/order`, { order });
  }

  // ===== Rendering ========================================================
  const TYPE_LABEL = {
    color: 'Farbe', image: 'Bild', video: 'Video',
    youtube: 'YouTube', webpage: 'Webseite', screenshare: 'Bildschirm'
  };

  function render() {
    if (!state) return;
    const pls = playlists();
    if (!selectedId || !pls.byId[selectedId]) selectedId = pls.rootId;

    // Playlist-Auswahl
    const sel = $('pl-select');
    if (document.activeElement !== sel) {
      sel.innerHTML = '';
      for (const pl of Object.values(pls.byId)) {
        const opt = document.createElement('option');
        opt.value = pl.id;
        opt.textContent = `${pl.id === pls.rootId ? '★ ' : ''}${pl.name} (${pl.items.length})`;
        sel.appendChild(opt);
      }
      sel.value = selectedId;
    }
    $('pl-root-badge').classList.toggle('hidden', selectedId !== pls.rootId);

    const pl = selPl();

    // Nachfolge-Auswahl
    const next = $('pl-next');
    if (document.activeElement !== next) {
      next.innerHTML = '';
      for (const p of Object.values(pls.byId)) {
        if (p.id === pl.id) continue;
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        next.appendChild(o);
      }
    }
    setIfNotFocused($('pl-after'), pl.after);
    $('pl-next-wrap').classList.toggle('hidden', pl.after !== 'next');
    if (pl.nextId && document.activeElement !== next) next.value = pl.nextId;

    // Einbettbare Sub-Playlists (alle außer der aktuellen)
    const subSel = $('pl-sub-select');
    if (document.activeElement !== subSel) {
      subSel.innerHTML = '';
      for (const p of Object.values(pls.byId)) {
        if (p.id === pl.id) continue;
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        subSel.appendChild(o);
      }
    }

    renderItems(pl);
  }

  function renderItems(pl) {
    const ul = $('pl-items');
    ul.innerHTML = '';
    for (const item of pl.items) ul.appendChild(buildItemEl(item));
    enableDragReorder(ul, () => saveItemOrder(Array.from(ul.children).map((c) => c.dataset.id)));
    applyLiveNow();
  }

  function buildItemEl(item) {
    const li = document.createElement('li');
    li.className = 'media-item';
    li.draggable = true;
    li.dataset.id = item.id;

    const drag = document.createElement('span');
    drag.className = 'drag'; drag.textContent = '⠿';
    li.appendChild(drag);

    if (item.kind === 'playlist') {
      const ref = playlists().byId[item.refId];
      li.classList.add('item-playlist');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.innerHTML = `<div class="name">▶ Playlist: ${escapeHtml(ref ? ref.name : '—')}</div>
        <div class="type">eingebettete Playlist${ref ? ` (${ref.items.length})` : ''}</div>`;
      li.appendChild(meta);
    } else {
      const c = item.content;
      if (c.type === 'youtube') li.dataset.videoId = c.videoId || '';
      li.appendChild(buildThumb(c));
      li.appendChild(buildContentControls(item));
    }

    const del = document.createElement('button');
    del.className = 'del'; del.title = 'Entfernen'; del.textContent = '🗑';
    del.addEventListener('click', () => deleteItem(item.id));
    li.appendChild(del);
    return li;
  }

  function buildThumb(c) {
    if (c.type === 'color') {
      const sw = document.createElement('span');
      sw.className = 'thumb color-swatch';
      sw.style.background = c.color || '#000';
      return sw;
    }
    if (c.type === 'image') {
      const img = document.createElement('img');
      img.className = 'thumb'; img.src = `/uploads/${c.filename}`; img.alt = '';
      return img;
    }
    if (c.type === 'video') {
      const v = document.createElement('video');
      v.className = 'thumb'; v.src = `/uploads/${c.filename}`; v.muted = true;
      return v;
    }
    if (c.type === 'youtube') {
      const img = document.createElement('img');
      img.className = 'thumb'; img.src = `https://i.ytimg.com/vi/${c.videoId}/default.jpg`; img.alt = '';
      return img;
    }
    const badge = document.createElement('span');
    badge.className = 'thumb type-badge';
    badge.textContent = c.type === 'webpage' ? '🌐' : '🖥';
    return badge;
  }

  // Typ-spezifische Bearbeitungs-Steuerung pro Content.
  function buildContentControls(item) {
    const c = item.content;
    const meta = document.createElement('span');
    meta.className = 'meta';

    const name = document.createElement('div');
    name.className = 'name';
    if (c.type === 'webpage') {
      const a = document.createElement('a');
      a.href = c.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = c.url || '(URL)';
      name.appendChild(a);
    } else if (c.type === 'youtube') {
      const a = document.createElement('a');
      a.href = `https://www.youtube.com/watch?v=${c.videoId}`; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = c.name || c.videoId;
      name.appendChild(a);
    } else {
      name.textContent = c.name || TYPE_LABEL[c.type] || c.type;
    }
    meta.appendChild(name);

    const type = document.createElement('div');
    type.className = 'type'; type.textContent = TYPE_LABEL[c.type] || c.type;
    meta.appendChild(type);

    const ctrls = document.createElement('div');
    ctrls.className = 'content-ctrls';

    if (c.type === 'color') {
      ctrls.appendChild(field('Farbe', inputColor(c.color || '#000000', (v) => patchContent(item.id, { color: v }))));
      ctrls.appendChild(field('Dauer (s)', inputNum(c.durationSec, 1, 600, (v) => patchContent(item.id, { durationSec: v }))));
    } else if (c.type === 'image') {
      ctrls.appendChild(field('Dauer (s)', inputNum(c.durationSec, 1, 600, (v) => patchContent(item.id, { durationSec: v }))));
      ctrls.appendChild(checkbox('Zuschneiden (Cover)', c.crop, (v) => patchContent(item.id, { crop: v })));
    } else if (c.type === 'video' || c.type === 'youtube') {
      ctrls.appendChild(field('Ende', selectEl(
        [['end', 'bis Videoende'], ['duration', 'nach Dauer']], c.videoMode || 'end',
        (v) => patchContent(item.id, { videoMode: v }))));
      if (c.videoMode === 'duration') {
        ctrls.appendChild(field('Dauer (s)', inputNum(c.durationSec, 1, 6000, (v) => patchContent(item.id, { durationSec: v }))));
      }
      ctrls.appendChild(checkbox('Stumm', c.muted !== false, (v) => patchContent(item.id, { muted: v })));
      ctrls.appendChild(checkbox('Zuschneiden', c.crop, (v) => patchContent(item.id, { crop: v })));
      if (c.type === 'youtube') {
        const now = document.createElement('div');
        now.className = 'yt-now hidden';
        now.innerHTML = `<span class="yt-badge">▶ läuft</span>
          <div class="yt-progress"><div class="yt-progress-bar"></div></div>
          <span class="yt-time">–</span>`;
        meta.appendChild(now);
      }
    } else if (c.type === 'webpage') {
      ctrls.appendChild(field('Dauer (s)', inputNum(c.durationSec, 3, 6000, (v) => patchContent(item.id, { durationSec: v }))));
      const status = document.createElement('span');
      status.className = 'embed-status';
      if (c.embeddable === false) { status.classList.add('link-bad'); status.title = c.reason || ''; status.textContent = '⚠ blockiert'; }
      else if (c.embeddable === true) { status.classList.add('link-ok'); status.textContent = '✓ einbettbar'; }
      else { status.classList.add('link-unknown'); status.textContent = '? ungeprüft'; }
      ctrls.appendChild(status);
      const recheck = document.createElement('button');
      recheck.className = 'btn ghost tiny'; recheck.textContent = 'neu prüfen';
      recheck.addEventListener('click', () => api('POST', '/api/link/recheck', { playlistId: selPl().id, itemId: item.id }));
      ctrls.appendChild(recheck);
    } else if (c.type === 'screenshare') {
      ctrls.appendChild(field('Dauer (s)', inputNum(c.durationSec, 1, 6000, (v) => patchContent(item.id, { durationSec: v }))));
      const hint = document.createElement('span');
      hint.className = 'link-unknown'; hint.textContent = 'vorbereitet (noch ohne Wiedergabe)';
      ctrls.appendChild(hint);
    }

    meta.appendChild(ctrls);
    return meta;
  }

  // --- kleine Form-Bausteine ---
  function field(label, el) {
    const wrap = document.createElement('label');
    wrap.className = 'ctrl';
    wrap.appendChild(document.createTextNode(label + ' '));
    wrap.appendChild(el);
    return wrap;
  }
  function inputNum(value, min, max, onChange) {
    const i = document.createElement('input');
    i.type = 'number'; i.min = min; i.max = max; i.step = 1; i.value = value;
    i.addEventListener('change', () => onChange(Math.max(min, Math.min(max, Number(i.value) || min))));
    return i;
  }
  function inputColor(value, onChange) {
    const i = document.createElement('input');
    i.type = 'color'; i.value = value;
    i.addEventListener('change', () => onChange(i.value));
    return i;
  }
  function selectEl(options, value, onChange) {
    const s = document.createElement('select');
    for (const [v, label] of options) {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function checkbox(label, checked, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'ctrl checkbox';
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = !!checked;
    i.addEventListener('change', () => onChange(i.checked));
    wrap.appendChild(i);
    wrap.appendChild(document.createTextNode(' ' + label));
    return wrap;
  }

  // ===== Live-Hervorhebung (roter Rahmen für den Wand-Content) ============
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

  // ===== Systemlautstärke =================================================
  const volRange = $('vol-range'), volVal = $('vol-val'), volMute = $('vol-mute');
  let lastVolSent = 0;
  function renderVol(d) {
    if (d && typeof d.level === 'number') {
      const pct = Math.round(d.level * 100);
      if (document.activeElement !== volRange) volRange.value = pct;
      volVal.textContent = pct + '%';
    } else { volVal.textContent = '–'; }
    if (d && d.muted !== undefined) volMute.textContent = d.muted ? '🔇' : '🔊';
  }
  async function loadVol() {
    try {
      const r = await fetch('/api/volume');
      if (!r.ok) throw new Error();
      renderVol(await r.json());
    } catch (_) { volVal.textContent = '–'; volRange.disabled = true; }
  }
  async function postVol(payload) {
    try {
      const r = await fetch('/api/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) renderVol(await r.json());
    } catch (_) {}
  }
  volRange.addEventListener('input', () => {
    const pct = Number(volRange.value);
    volVal.textContent = pct + '%';
    const now = Date.now();
    if (now - lastVolSent > 120) { postVol({ level: pct / 100 }); lastVolSent = now; }
  });
  volRange.addEventListener('change', () => postVol({ level: Number(volRange.value) / 100 }));
  volMute.addEventListener('click', () => postVol({ mute: 'toggle' }));
  loadVol();

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

  // ===== Utils ============================================================
  function parseYoutubeId(input) {
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const u = new URL(input);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1, 12) || null;
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|v)\/([\w-]{11})/);
      if (m) return m[2];
    } catch (_) {}
    const m = input.match(/[\w-]{11}/);
    return m ? m[0] : null;
  }
  function normalizeUrl(input) {
    if (!input) return null;
    let s = input;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (!u.hostname.includes('.')) return null;
      return u.href;
    } catch (_) { return null; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
