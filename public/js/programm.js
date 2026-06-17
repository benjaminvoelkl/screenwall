// Programm-Timeline (/programm). Zeigt das Programm (ausgeflachte Start-Playlist)
// wie in einem Videoschnitt-Programm: Zeitstrahl + parallele Spuren für Content,
// Musik (Platzhalter) und Overlay. Scrubben am Zeitstrahl steuert per WebSocket
// die eingebettete /screen-Vorschau (cmd:'goto'); "Preview & Go Live" startet die
// Vorschau ab dem Playhead-Punkt und veröffentlicht den Entwurf.

(() => {
  const $ = (id) => document.getElementById(id);

  let state = null;
  let liveNowPlaying = null;          // Was läuft gerade live auf der Wand?
  let seq = [];                       // ausgeflachte Content-Liste [{itemId, content}]
  let blocks = [];                    // Layout [{itemId, content, start, dur, x, w}]
  let total = 0;                      // Gesamtdauer in Sekunden
  let pxPerSec = 12;
  let playheadT = 0;                  // Playhead-Position in Sekunden
  const measured = {};                // itemId -> gemessene Dauer (für "bis Ende"-Videos)

  const NOMINAL_END = 30;            // angenommene Dauer für Videos ohne feste Dauer
  const RULER_H = 26;

  // ---- API/WS -------------------------------------------------------------
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
  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  connect();
  fetch('/api/state').then((r) => r.json()).then((s) => { state = s; render(); });

  // ---- Entwurf-Vorschau laden (Sicht 'preview' in screen.js) --------------
  $('prev-frame').src = '/screen';

  // Vorschau meldet laufend ihre Position (itemId + Zeit, auch für statische
  // Inhalte). Damit folgt der Playhead der Wiedergabe und die echte Dauer von
  // "bis Ende"-Videos wird übernommen (Block nachskalieren).
  let scrubbing = false;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'screen-pos' || !d.itemId) return;
    const t = d.pos ? d.pos.time || 0 : 0;
    const dur = d.pos ? d.pos.duration || 0 : 0;
    const b = blocks.find((x) => x.itemId === d.itemId);
    if (!b) return;
    const c = b.content;
    if (dur > 0 && (c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration'
        && Math.abs((measured[d.itemId] || 0) - dur) > 0.5) {
      measured[d.itemId] = dur; render(); return;
    }
    if (!scrubbing) { playheadT = Math.min(total, b.start + t); positionPlayhead(); }
  });

  // ===== Ausflachen (Quelle: screen.js:flatten – bewusst gespiegelt) ========
  function flatten(plId, byId, visited) {
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

  function blockDur(itemId, c) {
    if ((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration') {
      return measured[itemId] || NOMINAL_END;
    }
    return Math.max(1, c.durationSec || 6);
  }

  // ===== Rendering =========================================================
  const TYPE_BADGE = { color: '🎨', image: '🖼', video: '🎬', youtube: '▶', webpage: '🌐', screenshare: '🖥' };

  // Zoom: Slider 0 = max. Detail, 100 = "Alles" (komplette Timeline passt in die
  // sichtbare Breite). Fit-Wert ergibt sich aus Gesamtdauer und Containerbreite.
  const MAX_DETAIL_PX = 60;
  function fitPxPerSec() {
    const avail = $('tl-scroll').clientWidth - 8;
    return total > 0 ? Math.max(0.5, avail / total) : MAX_DETAIL_PX;
  }
  function zoomPxPerSec() {
    const v = Number($('tl-zoom').value);
    const fit = fitPxPerSec();
    const detail = Math.max(fit, MAX_DETAIL_PX);
    return fit + (detail - fit) * (1 - v / 100);
  }

  function render() {
    if (!state || !state.playlists) return;

    const pls = state.playlists;
    const root = pls.byId[pls.rootId];
    $('tl-title').textContent = root ? `Programm: ${root.name}` : 'Programm';
    seq = root ? flatten(pls.rootId, pls.byId, new Set()) : [];

    // 1) Dauern + Gesamtdauer (unabhängig vom Zoom).
    const durs = seq.map((e) => blockDur(e.itemId, e.content));
    total = durs.reduce((a, b) => a + b, 0);

    const empty = seq.length === 0;
    $('prog-empty').classList.toggle('hidden', !empty);
    $('tl-grid').classList.toggle('hidden', empty);
    $('tl-total').textContent = `Gesamt: ${fmtClock(total)}`;
    if (empty) { return; }

    // 2) Zoom bestimmen (Fit braucht die Gesamtdauer).
    pxPerSec = zoomPxPerSec();

    // 3) Block-Layout.
    blocks = [];
    let acc = 0;
    for (let i = 0; i < seq.length; i++) {
      const e = seq[i], dur = durs[i];
      blocks.push({ itemId: e.itemId, content: e.content, start: acc, dur, x: acc * pxPerSec, w: Math.max(6, dur * pxPerSec) });
      acc += dur;
    }

    const widthPx = Math.max($('tl-scroll').clientWidth, Math.ceil(total * pxPerSec));
    $('tl-tracks').style.width = widthPx + 'px';

    renderRuler(widthPx);
    renderContent();
    renderOverlay(widthPx);
    if (playheadT > total) playheadT = total;
    positionPlayhead();
    applyLiveNow();
  }

  function renderRuler(widthPx) {
    const ruler = $('tl-ruler');
    ruler.innerHTML = '';
    const step = chooseStep(pxPerSec);
    for (let t = 0; t * pxPerSec <= widthPx; t += step) {
      const tick = document.createElement('div');
      tick.className = 'tl-tick';
      tick.style.left = (t * pxPerSec) + 'px';
      tick.textContent = fmtClock(t);
      ruler.appendChild(tick);
    }
  }

  function renderContent() {
    const lane = $('lane-content');
    lane.innerHTML = '';
    for (const b of blocks) {
      const c = b.content;
      const el = document.createElement('div');
      el.className = 'tl-block type-' + c.type;
      el.dataset.id = b.itemId;
      el.style.left = b.x + 'px';
      el.style.width = b.w + 'px';
      if (c.type === 'color') el.style.background = c.color || '#000';
      else if (c.type === 'image') el.style.backgroundImage = `url('/uploads/${c.filename}')`;
      else if (c.type === 'youtube') el.style.backgroundImage = `url('https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg')`;
      if ((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration') el.classList.add('end-video');

      const badge = document.createElement('span');
      badge.className = 'tl-b-type'; badge.textContent = TYPE_BADGE[c.type] || '•';
      el.appendChild(badge);

      const label = document.createElement('div');
      label.className = 'tl-b-label';
      label.textContent = c.name || c.url || c.videoId || c.type;
      el.appendChild(label);

      const dur = document.createElement('div');
      dur.className = 'tl-b-dur';
      const isEnd = (c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration';
      dur.textContent = isEnd
        ? (measured[b.itemId] ? fmtClock(b.dur) : '≈ bis Ende')
        : fmtClock(b.dur);
      el.appendChild(dur);

      lane.appendChild(el);
    }
  }

  function renderOverlay(widthPx) {
    const lane = $('lane-overlay');
    lane.innerHTML = '';
    const on = state.welcome && state.welcome.visible !== false;
    lane.classList.toggle('empty', !on);
    if (!on) { lane.textContent = 'Overlay aus'; return; }
    lane.textContent = '';
    const block = document.createElement('div');
    block.className = 'tl-overlay-block';
    block.style.width = (total * pxPerSec) + 'px';
    block.textContent = `Willkommens-Overlay aktiv (global) · ${state.welcome.template || 'elegant'}`;
    block.title = 'Overlay liegt global über dem gesamten Programm. Pro-Playlist folgt.';
    lane.appendChild(block);
  }

  function positionPlayhead() {
    const px = playheadT * pxPerSec;
    $('tl-playhead').style.left = px + 'px';
    $('prog-clock').textContent = `${fmtClock(playheadT)} / ${fmtClock(total)}`;
    // Playhead bei laufender Wiedergabe im Sichtbereich halten.
    if (playing && !scrubbing) {
      const sc = $('tl-scroll');
      if (px < sc.scrollLeft + 30 || px > sc.scrollLeft + sc.clientWidth - 30) {
        sc.scrollLeft = Math.max(0, px - sc.clientWidth / 2);
      }
    }
  }

  function applyLiveNow() {
    const np = liveNowPlaying;
    for (const el of $('lane-content').children) {
      el.classList.toggle('live-now', !!np && np.contentId && el.dataset.id === np.contentId);
    }
  }

  // ===== Scrubbing =========================================================
  function entryAt(T) {
    if (!blocks.length) return null;
    for (const b of blocks) if (T >= b.start && T < b.start + b.dur) return { itemId: b.itemId, offset: T - b.start };
    const last = blocks[blocks.length - 1];
    return { itemId: last.itemId, offset: Math.max(0, T - last.start) };
  }

  let lastSent = 0;
  function sendGoto(T) {
    const e = entryAt(T);
    if (e) wsSend({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset });
  }
  function scrubTo(T, opts) {
    opts = opts || {};
    playheadT = Math.max(0, Math.min(total, T));
    positionPlayhead();
    positioned = true; updateGoLive();   // Positionswechsel blendet "Preview & Go Live" ein
    const now = Date.now();
    if (!opts.throttle || now - lastSent > 80) { sendGoto(playheadT); lastSent = now; }
  }

  (function bindScrub() {
    const tracks = $('tl-tracks');
    const timeAt = (clientX) => (clientX - tracks.getBoundingClientRect().left) / pxPerSec;
    tracks.addEventListener('pointerdown', (e) => {
      scrubbing = true; tracks.setPointerCapture(e.pointerId);
      scrubTo(timeAt(e.clientX));
    });
    tracks.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(timeAt(e.clientX), { throttle: true }); });
    const end = () => { if (!scrubbing) return; scrubbing = false; sendGoto(playheadT); };
    tracks.addEventListener('pointerup', end);
    tracks.addEventListener('pointercancel', end);
  })();

  $('tl-zoom').addEventListener('input', render);
  $('tl-fit').addEventListener('click', () => { $('tl-zoom').value = 100; render(); });
  window.addEventListener('resize', () => { scaleInlinePreview(); render(); });

  // ===== Vorschau-Skalierung (18:16) =======================================
  const PREVIEW_W = 4320, PREVIEW_H = 3840;
  function scalePreview(stage, wrap, availW, availH) {
    if (!stage || stage.offsetParent === null) return;
    const scale = Math.max(0.01, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    stage.style.width = Math.round(PREVIEW_W * scale) + 'px';
    stage.style.height = Math.round(PREVIEW_H * scale) + 'px';
    wrap.style.transform = `scale(${scale})`;
  }
  function scaleInlinePreview() {
    const stage = $('prev-stage');
    const availW = (stage.parentElement.clientWidth || window.innerWidth) - 28;
    scalePreview(stage, $('prev-frame-wrap'), availW, window.innerHeight * 0.42);
  }
  function scaleGolivePreview() {
    scalePreview($('golive-stage'), $('golive-frame-wrap'), window.innerWidth * 0.9, window.innerHeight * 0.62);
  }
  requestAnimationFrame(scaleInlinePreview);

  // ===== Wiedergabe (Play/Pause) ===========================================
  let playing = true; // Vorschau startet selbstständig
  function setPlaying(p) {
    playing = p;
    $('tl-play').textContent = p ? '⏸' : '▶';
    $('tl-play').title = p ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)';
    wsSend({ type: 'cmd', cmd: p ? 'play' : 'pause' });
  }
  function togglePlay() { setPlaying(!playing); }
  $('tl-play').addEventListener('click', togglePlay);
  $('tl-to-start').addEventListener('click', () => scrubTo(0));
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (!$('golive-modal').classList.contains('hidden')) return;
    e.preventDefault();
    togglePlay();
  });

  // ===== Go Live ===========================================================
  let dirtyState = false, positioned = false;
  function setDirty(dirty) { dirtyState = dirty; updateGoLive(); }
  function updateGoLive() {
    const live = $('go-live');
    const show = dirtyState || positioned;
    live.classList.toggle('hidden', !show);
    live.classList.toggle('pending', dirtyState);
    live.textContent = dirtyState ? '● Preview & Go Live' : 'Preview & Go Live';
  }
  $('go-live').addEventListener('click', openGoLive);

  function openGoLive() {
    $('golive-frame').src = '/screen';
    $('golive-modal').classList.remove('hidden');
    resetSlide();
    scaleGolivePreview();
    requestAnimationFrame(scaleGolivePreview);
    // Vorschau ab Playhead-Punkt starten, sobald das Iframe verbunden ist.
    const e = entryAt(playheadT);
    if (e) setTimeout(() => wsSend({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset }), 1200);
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

  // ---- Slide-to-go-live (übernommen aus dem alten /settings-Flow) ----------
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
    location.href = '/';
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
    if (!$('golive-modal').classList.contains('hidden')) {
      scaleGolivePreview();
      if (!sliding) setSlide(slideDone ? slideTravel() : 0);
    }
  });

  // ===== Systemlautstärke (übernommen aus dem /settings-Flow) ==============
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

  // ===== Utils =============================================================
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  // Tick-Abstand so wählen, dass Beschriftungen ~70px auseinander liegen.
  function chooseStep(pps) {
    const target = 70 / pps; // Sekunden pro ~70px
    const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const n of nice) if (n >= target) return n;
    return 3600;
  }
})();
