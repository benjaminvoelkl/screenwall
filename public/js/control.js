// Steuerseite /. Sendet Änderungen per HTTP an den Server; der Server
// persistiert und broadcastet. Per WebSocket bleiben mehrere Steuerseiten
// und alle /screen-Geräte synchron.

(() => {
  let state = null;

  // ---- Helper -------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  async function postState(patch) {
    const r = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    return r.json();
  }

  // Nur aktualisieren, wenn der Nutzer das Feld nicht gerade bearbeitet.
  function setIfNotFocused(el, value) {
    if (document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
  }

  // ---- WebSocket (Status + Sync) -----------------------------------------
  let ws = null;
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.addEventListener('open', () => setConn(true));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') { state = msg.state; render(); }
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

  // ---- Modus-Umschaltung --------------------------------------------------
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => postState({ mode: btn.dataset.mode }));
  });

  // ===== Modus 1: Diashow =================================================
  $('ss-duration').addEventListener('change', (e) =>
    postState({ slideshow: { durationSec: Math.max(1, Number(e.target.value) || 6) } }));
  $('ss-videomode').addEventListener('change', (e) =>
    postState({ slideshow: { videoMode: e.target.value } }));

  // Upload (mit optionalem 18:16-Crop für Bilder)
  $('ss-file').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const wantCrop = $('ss-crop-toggle').checked;
    for (const file of files) {
      if (wantCrop && file.type.startsWith('image/')) {
        await cropThenUpload(file); // wartet auf den Crop-Dialog
      } else {
        await uploadFile(file);
      }
    }
  });

  async function uploadFile(fileOrBlob, filename) {
    const fd = new FormData();
    fd.append('sequenceId', state.slideshow.activeSequenceId);
    fd.append('file', fileOrBlob, filename || fileOrBlob.name || 'upload');
    await fetch('/api/upload', { method: 'POST', body: fd });
  }

  // Aktuell ausgewählte (= auf /screen aktive) Sequenz.
  function activeSeq() {
    return state.slideshow.sequences.find((s) => s.id === state.slideshow.activeSequenceId)
      || state.slideshow.sequences[0];
  }

  // --- Crop-Dialog (Cropper.js, fixiertes Seitenverhältnis 18:16 = 9:8) ---
  let cropper = null;
  let cropResolve = null;
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
          await uploadFile(file); // Original verwenden
        }
        if (cropper) { cropper.destroy(); cropper = null; }
        URL.revokeObjectURL(url);
        resolve();
      };
    });
  }
  $('crop-confirm').addEventListener('click', () => cropResolve && cropResolve(true));
  $('crop-cancel').addEventListener('click', () => cropResolve && cropResolve(false));

  async function deleteMedia(id) {
    await fetch(`/api/media/${id}`, { method: 'DELETE' });
  }
  async function saveMediaOrder(order) {
    await fetch('/api/media/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequenceId: state.slideshow.activeSequenceId, order })
    });
  }

  // --- Sequenz-Verwaltung ---
  $('ss-seq-select').addEventListener('change', (e) =>
    postState({ slideshow: { activeSequenceId: e.target.value } }));

  $('ss-seq-new').addEventListener('click', async () => {
    const name = prompt('Name der neuen Sequenz:', `Sequenz ${state.slideshow.sequences.length + 1}`);
    if (name === null) return;
    await fetch('/api/slideshow/sequence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  });

  $('ss-seq-rename').addEventListener('click', async () => {
    const seq = activeSeq();
    if (!seq) return;
    const name = prompt('Neuer Name:', seq.name);
    if (name === null) return;
    await fetch(`/api/slideshow/sequence/${seq.id}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  });

  $('ss-seq-delete').addEventListener('click', async () => {
    const seq = activeSeq();
    if (!seq) return;
    if (state.slideshow.sequences.length <= 1) {
      alert('Mindestens eine Sequenz muss bestehen bleiben.');
      return;
    }
    if (!confirm(`Sequenz „${seq.name}" mit allen Medien löschen?`)) return;
    await fetch(`/api/slideshow/sequence/${seq.id}`, { method: 'DELETE' });
  });

  function renderSlideshowList() {
    const ul = $('ss-list');
    ul.innerHTML = '';
    const seq = activeSeq();
    for (const m of (seq ? seq.media : [])) {
      const li = document.createElement('li');
      li.className = 'media-item';
      li.draggable = true;
      li.dataset.id = m.id;
      const thumbHtml = m.type === 'video'
        ? `<video class="thumb" src="/uploads/${m.filename}" muted></video>`
        : `<img class="thumb" src="/uploads/${m.filename}" alt="" />`;
      li.innerHTML = `
        <span class="drag">⠿</span>
        ${thumbHtml}
        <span class="meta">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="type">${m.type === 'video' ? 'Video' : 'Bild'}</div>
        </span>
        <button class="del" title="Löschen">🗑</button>`;
      li.querySelector('.del').addEventListener('click', () => deleteMedia(m.id));
      ul.appendChild(li);
    }
    enableDragReorder(ul, () =>
      saveMediaOrder(Array.from(ul.children).map((c) => c.dataset.id)));
  }

  // ===== Modus 2: YouTube =================================================
  $('yt-muted').addEventListener('change', (e) =>
    postState({ youtube: { muted: e.target.checked } }));

  $('yt-add').addEventListener('click', addYoutube);
  $('yt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addYoutube(); });

  function addYoutube() {
    const raw = $('yt-input').value.trim();
    if (!raw) return;
    const id = parseYoutubeId(raw);
    if (!id) { alert('Konnte keine YouTube-ID erkennen.'); return; }
    const videos = [...state.youtube.videos, { id: cryptoId(), videoId: id, title: raw }];
    $('yt-input').value = '';
    postState({ youtube: { videos } });
  }

  function parseYoutubeId(input) {
    if (/^[\w-]{11}$/.test(input)) return input; // reine ID
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

  function renderYoutubeList() {
    const ul = $('yt-list');
    ul.innerHTML = '';
    for (const v of state.youtube.videos) {
      const li = document.createElement('li');
      li.className = 'media-item';
      li.draggable = true;
      li.dataset.id = v.id;
      li.innerHTML = `
        <span class="drag">⠿</span>
        <img class="thumb" src="https://i.ytimg.com/vi/${v.videoId}/default.jpg" alt="" />
        <span class="meta">
          <div class="name">${escapeHtml(v.title || v.videoId)}</div>
          <div class="type">${v.videoId}</div>
        </span>
        <button class="del" title="Entfernen">🗑</button>`;
      li.querySelector('.del').addEventListener('click', () => {
        postState({ youtube: { videos: state.youtube.videos.filter((x) => x.id !== v.id) } });
      });
      ul.appendChild(li);
    }
    enableDragReorder(ul, () => {
      const order = Array.from(ul.children).map((c) => c.dataset.id);
      const byId = new Map(state.youtube.videos.map((x) => [x.id, x]));
      postState({ youtube: { videos: order.map((id) => byId.get(id)).filter(Boolean) } });
    });
  }

  // ===== Modus 3: Willkommen =============================================
  $('wc-text').addEventListener('input', (e) =>
    postState({ welcome: { text: e.target.value } }));
  $('wc-template').addEventListener('change', (e) =>
    postState({ welcome: { template: e.target.value } }));
  $('wc-fontsize').addEventListener('input', (e) => {
    $('wc-fontsize-val').textContent = `${e.target.value} vw`;
    postState({ welcome: { fontSize: Number(e.target.value) } });
  });
  $('wc-visible').addEventListener('change', (e) =>
    postState({ welcome: { visible: e.target.checked } }));

  // ===== Drag & Drop Reorder (gemeinsam) =================================
  function enableDragReorder(container, onDrop) {
    let dragging = null;
    container.querySelectorAll('.media-item').forEach((item) => {
      item.addEventListener('dragstart', () => { dragging = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        dragging = null;
        onDrop();
      });
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

  // ===== Render gesamten Zustand in die UI ===============================
  function render() {
    if (!state) return;
    // Modus
    document.querySelectorAll('.mode-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('.panel').forEach((p) =>
      p.classList.toggle('active', p.id === `panel-${state.mode}`));

    // Slideshow
    const sel = $('ss-seq-select');
    if (document.activeElement !== sel) {
      sel.innerHTML = '';
      for (const s of state.slideshow.sequences) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.media.length})`;
        sel.appendChild(opt);
      }
      sel.value = state.slideshow.activeSequenceId;
    }
    setIfNotFocused($('ss-duration'), state.slideshow.durationSec);
    setIfNotFocused($('ss-videomode'), state.slideshow.videoMode);
    renderSlideshowList();

    // YouTube
    setIfNotFocused($('yt-muted'), state.youtube.muted);
    renderYoutubeList();

    // Welcome
    setIfNotFocused($('wc-text'), state.welcome.text);
    setIfNotFocused($('wc-template'), state.welcome.template);
    setIfNotFocused($('wc-fontsize'), state.welcome.fontSize);
    $('wc-fontsize-val').textContent = `${state.welcome.fontSize} vw`;
    setIfNotFocused($('wc-visible'), state.welcome.visible);
  }

  // ===== Utils ===========================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cryptoId() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
  }
})();
