// Steuerseite /. Sendet Änderungen per HTTP an den Server; der Server
// persistiert und broadcastet. Per WebSocket bleiben mehrere Steuerseiten
// und alle /screen-Geräte synchron.

(() => {
  let state = null;
  let liveNowPlaying = null; // Was läuft gerade auf der Wand (live)?

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
    // Rolle 'control' -> Server liefert den Entwurf (nicht den Live-Zustand).
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
          // Was läuft gerade auf der echten Wand (live)? -> Playing-Indikator.
          liveNowPlaying = msg;
          applyYtNowPlaying();
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

  // ---- Modus-Umschaltung --------------------------------------------------
  // Änderungen landen nur im Entwurf; die Wand ändert sich erst bei "Go Live".
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => postState({ mode: btn.dataset.mode }));
  });

  // ---- Go Live: Entwurf veröffentlichen -----------------------------------
  // Solange unveröffentlichte Änderungen bestehen (dirty), leuchtet der Button.
  function setDirty(dirty) {
    const btn = $('go-live');
    if (!btn) return;
    btn.classList.toggle('pending', dirty);
    btn.disabled = !dirty;
    btn.textContent = dirty ? '● Go Live' : 'Live';
  }
  // Go Live öffnet eine Bestätigung mit Entwurf-Vorschau + Slide-to-go-live.
  $('go-live').addEventListener('click', () => {
    if ($('go-live').disabled) return;
    openGoLive();
  });

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
  $('golive-modal').addEventListener('click', (e) => {
    if (e.target === $('golive-modal')) closeGoLive();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('golive-modal').classList.contains('hidden')) closeGoLive();
  });

  // ---- Slide-to-go-live ---------------------------------------------------
  let slideX = 0, sliding = false, slideDone = false;
  function slideTravel() {
    return $('golive-slider').clientWidth - $('slide-handle').offsetWidth - 8;
  }
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
    try { await fetch('/api/golive', { method: 'POST' }); }
    catch (_) {}
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
    handle.addEventListener('pointermove', (e) => {
      if (!sliding) return;
      setSlide(startSlide + (e.clientX - startX));
    });
    const end = () => {
      if (!sliding) return;
      sliding = false;
      handle.style.transition = 'transform 0.2s ease';
      if (slideX >= slideTravel() * 0.95) fireGoLive();
      else setSlide(0); // zu früh losgelassen -> zurückspringen
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
  window.addEventListener('resize', () => {
    if (!$('golive-modal').classList.contains('hidden')) { scaleGoliveStage(); if (!sliding) setSlide(slideDone ? slideTravel() : 0); }
  });

  // ---- Willkommens-Overlay: Modal öffnen/schließen ------------------------
  function openWelcome() { $('welcome-modal').classList.remove('hidden'); }
  function closeWelcome() { $('welcome-modal').classList.add('hidden'); }
  $('welcome-open').addEventListener('click', openWelcome);
  $('welcome-close').addEventListener('click', closeWelcome);
  $('welcome-modal').addEventListener('click', (e) => {
    if (e.target === $('welcome-modal')) closeWelcome(); // Klick auf Backdrop
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('welcome-modal').classList.contains('hidden')) closeWelcome();
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

  // ---- Live-Vorschau ------------------------------------------------------
  // Bettet /screen in der echten Display-Auflösung (2× 4K hochkant = 4320×3840,
  // 18:16) als Iframe ein und verkleinert es maßstabsgetreu auf die Modalgröße.
  // /screen verbindet sich selbst per WebSocket → Vorschau ist automatisch live.
  const PREVIEW_W = 4320, PREVIEW_H = 3840; // echte Wandfläche (18:16)
  function scalePreview() {
    const stage = $('preview-stage');
    const wrap = $('preview-frame-wrap');
    if (!stage || stage.offsetParent === null) return;
    // In den verfügbaren Platz einpassen (Rand für Kopf/Leiste lassen).
    const availW = window.innerWidth * 0.92;
    const availH = window.innerHeight * 0.74;
    const scale = Math.max(0.01, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    // Stage exakt auf die skalierte 18:16-Größe -> keine schwarzen Ränder.
    stage.style.width = Math.round(PREVIEW_W * scale) + 'px';
    stage.style.height = Math.round(PREVIEW_H * scale) + 'px';
    wrap.style.transform = `scale(${scale})`;
  }
  function openPreview() {
    $('preview-frame').src = '/screen';
    $('preview-modal').classList.remove('hidden');
    scalePreview();
    // Erneut nach dem Layout-Pass, falls die Stage-Höhe (aspect-ratio) erst
    // jetzt feststeht.
    requestAnimationFrame(scalePreview);
  }
  function closePreview() {
    $('preview-modal').classList.add('hidden');
    $('preview-frame').src = ''; // Verbindung/Playback der Vorschau beenden
    resetSeekBar();
  }
  $('preview-open').addEventListener('click', openPreview);
  $('preview-close').addEventListener('click', closePreview);
  $('preview-modal').addEventListener('click', (e) => {
    if (e.target === $('preview-modal')) closePreview(); // Klick auf Backdrop
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('preview-modal').classList.contains('hidden')) closePreview();
  });
  window.addEventListener('resize', scalePreview);

  // ---- Positionsleiste der Vorschau ---------------------------------------
  // Die eingebettete /screen-Instanz meldet ihre Wiedergabeposition per
  // postMessage. Beim Ziehen wird ein Seek-Befehl gesendet, der über den
  // Server an Wand UND Vorschau geht -> beide springen synchron.
  let seeking = false;
  let lastSeekSent = 0;

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function sendSeek(time) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmd', cmd: 'seek', time }));
    }
  }
  function updateSeekBar(pos) {
    const bar = $('preview-seek'), label = $('preview-time');
    if (!pos || !pos.duration) {
      bar.disabled = true; bar.value = 0; label.textContent = '–';
      return;
    }
    bar.disabled = false;
    if (!seeking) {
      bar.max = Math.floor(pos.duration);
      bar.value = Math.floor(pos.time);
      label.textContent = `${fmtTime(pos.time)} / ${fmtTime(pos.duration)}`;
    }
  }
  function resetSeekBar() {
    seeking = false;
    const bar = $('preview-seek');
    bar.disabled = true; bar.value = 0;
    $('preview-time').textContent = '–';
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'screen-pos') return;
    if (e.source !== $('preview-frame').contentWindow) return;
    updateSeekBar(d.pos);
  });

  const seekBar = $('preview-seek');
  seekBar.addEventListener('pointerdown', () => { seeking = true; });
  seekBar.addEventListener('input', () => {
    const t = Number(seekBar.value);
    $('preview-time').textContent = `${fmtTime(t)} / ${fmtTime(Number(seekBar.max))}`;
    const now = Date.now();
    if (now - lastSeekSent > 150) { sendSeek(t); lastSeekSent = now; } // live mitziehen
  });
  seekBar.addEventListener('change', () => { sendSeek(Number(seekBar.value)); seeking = false; });

  // ---- Systemlautstärke (wpctl auf dem Wand-Rechner) ----------------------
  const volRange = $('vol-range'), volVal = $('vol-val'), volMute = $('vol-mute');
  let lastVolSent = 0;

  function renderVol(d) {
    if (d && typeof d.level === 'number') {
      const pct = Math.round(d.level * 100);
      if (document.activeElement !== volRange) volRange.value = pct;
      volVal.textContent = pct + '%';
    } else {
      volVal.textContent = '–';
    }
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
      const r = await fetch('/api/volume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
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
  $('yt-crop').addEventListener('change', (e) =>
    postState({ youtube: { crop: e.target.checked } }));

  // Aktuell ausgewählte (= auf /screen aktive) YouTube-Sequenz.
  function activeYtSeq() {
    return state.youtube.sequences.find((s) => s.id === state.youtube.activeSequenceId)
      || state.youtube.sequences[0];
  }
  // YouTube-Sequenzen werden – anders als die Diashow (Dateien) – komplett über
  // den State-Patch verwaltet; es gibt keine Dateien aufzuräumen.
  function patchYtSequences(sequences, activeSequenceId) {
    const patch = { sequences };
    if (activeSequenceId) patch.activeSequenceId = activeSequenceId;
    postState({ youtube: patch });
  }

  $('yt-seq-select').addEventListener('change', (e) =>
    postState({ youtube: { activeSequenceId: e.target.value } }));

  $('yt-seq-new').addEventListener('click', () => {
    const name = prompt('Name der neuen Sequenz:', `Sequenz ${state.youtube.sequences.length + 1}`);
    if (name === null) return;
    const seq = { id: cryptoId(), name: name.trim() || `Sequenz ${state.youtube.sequences.length + 1}`, videos: [] };
    patchYtSequences([...state.youtube.sequences, seq], seq.id);
  });

  $('yt-seq-rename').addEventListener('click', () => {
    const seq = activeYtSeq();
    if (!seq) return;
    const name = prompt('Neuer Name:', seq.name);
    if (name === null || !name.trim()) return;
    patchYtSequences(state.youtube.sequences.map((s) =>
      s.id === seq.id ? { ...s, name: name.trim() } : s));
  });

  $('yt-seq-delete').addEventListener('click', () => {
    const seq = activeYtSeq();
    if (!seq) return;
    if (state.youtube.sequences.length <= 1) {
      alert('Mindestens eine Sequenz muss bestehen bleiben.');
      return;
    }
    if (!confirm(`Sequenz „${seq.name}" mit allen Videos löschen?`)) return;
    const rest = state.youtube.sequences.filter((s) => s.id !== seq.id);
    patchYtSequences(rest, rest[0].id);
  });

  $('yt-add').addEventListener('click', addYoutube);
  $('yt-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addYoutube(); });

  function addYoutube() {
    const raw = $('yt-input').value.trim();
    if (!raw) return;
    const id = parseYoutubeId(raw);
    if (!id) { alert('Konnte keine YouTube-ID erkennen.'); return; }
    const seq = activeYtSeq();
    const video = { id: cryptoId(), videoId: id, title: raw };
    $('yt-input').value = '';
    patchYtSequences(state.youtube.sequences.map((s) =>
      s.id === seq.id ? { ...s, videos: [...s.videos, video] } : s));
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
    const seq = activeYtSeq();
    for (const v of (seq ? seq.videos : [])) {
      const url = `https://www.youtube.com/watch?v=${v.videoId}`;
      const li = document.createElement('li');
      li.className = 'media-item';
      li.draggable = true;
      li.dataset.id = v.id;
      li.dataset.videoId = v.videoId;
      // Name verlinkt auf das Original-Video; darunter die anklickbare URL.
      li.innerHTML = `
        <span class="drag">⠿</span>
        <a class="thumb-link" href="${url}" target="_blank" rel="noopener" title="Auf YouTube öffnen">
          <img class="thumb" src="https://i.ytimg.com/vi/${v.videoId}/default.jpg" alt="" />
        </a>
        <span class="meta">
          <div class="name">${escapeHtml(v.title || v.videoId)}</div>
          <a class="yt-url" href="${url}" target="_blank" rel="noopener">${url}</a>
          <div class="yt-now hidden">
            <span class="yt-badge">▶ läuft</span>
            <div class="yt-progress"><div class="yt-progress-bar"></div></div>
            <span class="yt-time">–</span>
          </div>
        </span>
        <button class="del" title="Entfernen">🗑</button>`;
      li.querySelector('.del').addEventListener('click', () => {
        patchYtSequences(state.youtube.sequences.map((s) =>
          s.id === seq.id ? { ...s, videos: s.videos.filter((x) => x.id !== v.id) } : s));
      });
      ul.appendChild(li);
    }
    enableDragReorder(ul, () => {
      const order = Array.from(ul.children).map((c) => c.dataset.id);
      const byId = new Map(seq.videos.map((x) => [x.id, x]));
      patchYtSequences(state.youtube.sequences.map((s) =>
        s.id === seq.id ? { ...s, videos: order.map((id) => byId.get(id)).filter(Boolean) } : s));
    });
    applyYtNowPlaying();
  }

  // Markiert das gerade auf der Wand laufende Video und zeigt die Playtime.
  // Spiegelt den Live-Zustand (nicht den Entwurf) wider.
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  function applyYtNowPlaying() {
    const ul = $('yt-list');
    if (!ul) return;
    const np = liveNowPlaying;
    const live = np && np.mode === 'youtube' ? np : null;
    for (const li of ul.children) {
      const match = live && (li.dataset.id === live.id || li.dataset.videoId === live.videoId);
      li.classList.toggle('playing', !!match);
      const now = li.querySelector('.yt-now');
      if (!now) continue;
      now.classList.toggle('hidden', !match);
      if (match) {
        const dur = live.duration || 0;
        const t = live.time || 0;
        const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
        now.querySelector('.yt-progress-bar').style.width = `${pct}%`;
        now.querySelector('.yt-time').textContent =
          dur > 0 ? `${fmtClock(t)} / ${fmtClock(dur)}` : fmtClock(t);
      }
    }
  }

  // ===== Modus 3: Link ====================================================
  $('link-duration').addEventListener('change', (e) =>
    postState({ link: { durationSec: Math.max(3, Number(e.target.value) || 15) } }));

  $('link-add').addEventListener('click', addLink);
  $('link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addLink(); });

  async function addLink() {
    const url = normalizeUrl($('link-input').value.trim());
    if (!url) { alert('Bitte eine gültige URL eingeben.'); return; }
    $('link-input').value = '';
    // Über eigenen Endpoint: der Server prüft die Einbettbarkeit der Seite.
    await fetch('/api/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
  }

  // Ergänzt fehlendes Protokoll und prüft grob auf eine gültige URL.
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

  function renderLinkList() {
    const ul = $('link-list');
    ul.innerHTML = '';
    for (const it of state.link.items) {
      const li = document.createElement('li');
      li.className = 'media-item';
      li.draggable = true;
      li.dataset.id = it.id;
      let status = '<span class="link-ok">✓ einbettbar</span>';
      if (it.embeddable === false) status = `<span class="link-bad" title="${escapeHtml(it.reason || '')}">⚠ Einbettung blockiert</span>`;
      else if (it.embeddable !== true) status = '<span class="link-unknown">? nicht geprüft</span>';
      li.innerHTML = `
        <span class="drag">⠿</span>
        <span class="meta">
          <div class="name">${escapeHtml(it.url)}</div>
          <div class="type">${status}</div>
        </span>
        <button class="del" title="Entfernen">🗑</button>`;
      li.querySelector('.del').addEventListener('click', () => {
        postState({ link: { items: state.link.items.filter((x) => x.id !== it.id) } });
      });
      ul.appendChild(li);
    }
    enableDragReorder(ul, () => {
      const order = Array.from(ul.children).map((c) => c.dataset.id);
      const byId = new Map(state.link.items.map((x) => [x.id, x]));
      postState({ link: { items: order.map((id) => byId.get(id)).filter(Boolean) } });
    });
  }

  // ===== Willkommens-Overlay (eigenständig, über jedem Modus) ============
  $('wc-visible').addEventListener('change', (e) =>
    postState({ welcome: { visible: e.target.checked } }));
  // Vorlage-Dropdown enthält Stile (style:…) und eigene Vorlagen (preset:…).
  let curTplSel = null;
  $('wc-template').addEventListener('change', (e) => {
    const v = e.target.value;
    curTplSel = v;
    if (v.startsWith('preset:')) {
      fetch(`/api/welcome/preset/${v.slice(7)}/apply`, { method: 'POST' });
    } else if (v.startsWith('style:')) {
      postState({ welcome: { template: v.slice(6) } });
    }
  });
  $('wc-fontsize').addEventListener('input', (e) => {
    $('wc-fontsize-val').textContent = `${e.target.value} vw`;
    postState({ welcome: { fontSize: Number(e.target.value) } });
  });
  $('wc-blur').addEventListener('input', (e) => {
    $('wc-blur-val').textContent = `${e.target.value} px`;
    postState({ welcome: { blur: Number(e.target.value) } });
  });
  $('wc-headline').addEventListener('input', (e) =>
    postState({ welcome: { headline: e.target.value } }));

  // Pro Seite: Text, Textgröße, Logogröße.
  for (const side of ['left', 'right']) {
    $(`wc-${side}-text`).addEventListener('input', (e) =>
      postState({ welcome: { [side]: { text: e.target.value } } }));
    $(`wc-${side}-textsize`).addEventListener('input', (e) => {
      $(`wc-${side}-textsize-val`).textContent = `${e.target.value} vw`;
      postState({ welcome: { [side]: { textSize: Number(e.target.value) } } });
    });
    $(`wc-${side}-logosize`).addEventListener('input', (e) => {
      $(`wc-${side}-logosize-val`).textContent = `${e.target.value} vw`;
      postState({ welcome: { [side]: { logoSize: Number(e.target.value) } } });
    });
    // Logo-Position (oben/unten) per Drag & Drop der zwei Einträge.
    enableWcOrder($(`wc-${side}-order`), (parts) =>
      postState({ welcome: { [side]: { logoPos: parts[0] === 'logo' ? 'top' : 'bottom' } } }));
  }

  // Logo-Upload je Seite (eigener Endpoint, speichert Dateiname am welcome-State).
  function bindLogo(side) {
    $(`wc-${side}-logo`).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const fd = new FormData();
      fd.append('side', side);
      fd.append('file', file, file.name || 'logo');
      await fetch('/api/welcome/logo', { method: 'POST', body: fd });
    });
    $(`wc-${side}-logo-del`).addEventListener('click', async () => {
      await fetch('/api/welcome/logo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side })
      });
    });
  }
  bindLogo('left');
  bindLogo('right');

  // Speichern: aktuelle Gestaltung als eigene Vorlage (Preset) anlegen.
  $('wc-preset-save').addEventListener('click', async () => {
    const n = (state.welcome.presets || []).length + 1;
    const name = prompt('Name der Vorlage:', `Vorlage ${n}`);
    if (name === null) return;
    const r = await fetch('/api/welcome/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const created = await r.json();
    if (created && created.id) curTplSel = `preset:${created.id}`; // gleich auswählen
  });

  // Löschen: die aktuell gewählte eigene Vorlage entfernen.
  $('wc-preset-delete').addEventListener('click', () => {
    const v = $('wc-template').value;
    if (!v.startsWith('preset:')) return;
    const id = v.slice(7);
    const p = (state.welcome.presets || []).find((x) => x.id === id);
    if (p && confirm(`Eigene Vorlage „${p.name}" löschen?`)) {
      fetch(`/api/welcome/preset/${id}`, { method: 'DELETE' });
      curTplSel = null;
    }
  });

  // Vorlage-Dropdown füllen (Stile + eigene Vorlagen) und Auswahl/Buttons setzen.
  function renderTemplateSelect() {
    const sel = $('wc-template');
    if (document.activeElement === sel) return; // nicht stören, während offen
    const grp = $('wc-template-presets');
    grp.innerHTML = '';
    const presets = state.welcome.presets || [];
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = `preset:${p.id}`;
      o.textContent = p.name;
      grp.appendChild(o);
    }
    grp.hidden = presets.length === 0;
    // Gewünschte Auswahl: gemerkte Auswahl, sonst der aktive Stil.
    let want = curTplSel;
    if (!want || ![...sel.options].some((o) => o.value === want)) {
      want = `style:${state.welcome.template || 'elegant'}`;
    }
    sel.value = want;
    curTplSel = sel.value;
    $('wc-preset-delete').disabled = !sel.value.startsWith('preset:');
  }

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

  // Mini-Drag&Drop für die zwei Logo/Text-Einträge einer Seite (horizontal).
  function enableWcOrder(container, onChange) {
    let dragging = null;
    container.querySelectorAll('.wc-order-item').forEach((item) => {
      item.addEventListener('dragstart', () => { dragging = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        dragging = null;
        onChange(Array.from(container.children).map((c) => c.dataset.part));
      });
    });
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const others = [...container.querySelectorAll('.wc-order-item:not(.dragging)')];
      const after = others.find((c) => {
        const box = c.getBoundingClientRect();
        return e.clientX <= box.left + box.width / 2;
      });
      if (after == null) container.appendChild(dragging);
      else container.insertBefore(dragging, after);
    });
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
    const ytSel = $('yt-seq-select');
    if (document.activeElement !== ytSel) {
      ytSel.innerHTML = '';
      for (const s of state.youtube.sequences) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.videos.length})`;
        ytSel.appendChild(opt);
      }
      ytSel.value = state.youtube.activeSequenceId;
    }
    setIfNotFocused($('yt-muted'), state.youtube.muted);
    setIfNotFocused($('yt-crop'), state.youtube.crop);
    renderYoutubeList();

    // Link
    setIfNotFocused($('link-duration'), state.link.durationSec);
    renderLinkList();

    // Willkommens-Overlay
    const w = state.welcome;
    setIfNotFocused($('wc-visible'), w.visible);
    renderTemplateSelect();
    setIfNotFocused($('wc-fontsize'), w.fontSize);
    $('wc-fontsize-val').textContent = `${w.fontSize} vw`;
    setIfNotFocused($('wc-blur'), w.blur);
    $('wc-blur-val').textContent = `${w.blur} px`;
    setIfNotFocused($('wc-headline'), w.headline);
    for (const side of ['left', 'right']) {
      const s = w[side];
      setIfNotFocused($(`wc-${side}-text`), s.text);
      setIfNotFocused($(`wc-${side}-textsize`), s.textSize);
      $(`wc-${side}-textsize-val`).textContent = `${s.textSize} vw`;
      setIfNotFocused($(`wc-${side}-logosize`), s.logoSize);
      $(`wc-${side}-logosize-val`).textContent = `${s.logoSize} vw`;
      renderLogoPreview(side, s.logo);
      renderWcOrder(side, s.logoPos);
    }
  }

  function renderLogoPreview(side, logo) {
    const img = $(`wc-${side}-preview`);
    if (logo) { img.src = `/uploads/${logo}`; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
    $(`wc-${side}-logo-del`).disabled = !logo;
  }

  // Die zwei Drag-Einträge so sortieren, dass sie zum logoPos passen.
  function renderWcOrder(side, logoPos) {
    const c = $(`wc-${side}-order`);
    const logo = c.querySelector('[data-part="logo"]');
    const text = c.querySelector('[data-part="text"]');
    const first = logoPos === 'bottom' ? text : logo;
    const second = logoPos === 'bottom' ? logo : text;
    c.appendChild(first);
    c.appendChild(second);
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
