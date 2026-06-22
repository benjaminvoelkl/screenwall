// Anzeige-Logik für /screen.
//
// Inhaltsmodell: PLAYLISTS + CONTENTS.
//   - Der Zustand enthält `playlists` (Registry byId + rootId).
//   - Der Scheduler "flacht" die aktuelle Top-Playlist aus (verschachtelte
//     Playlists werden inline eingefügt) und spielt die Contents der Reihe nach.
//   - Am Listenende greift die Nachfolge-Aktion der Top-Playlist:
//     loop (von vorn) / stop (stehenbleiben) / next (Verweis auf nextId).
//
// Sichten (wie bisher):
//   'wall'    = echte Wand: Quelle, läuft eigenständig mit Timern, sendet einen
//               nowplaying-Heartbeat.
//   'monitor' = eingebetteter Live-Mirror (/?  -> /screen?view=live): KEINE
//               eigenen Timer; folgt strikt dem nowplaying der Wand.
//   'preview' = Entwurf-Vorschau in den Einstellungen: eigenständiger Player
//               (zeigt den Entwurf) + meldet Position an die Positionsleiste.

(() => {
  const $ = (id) => document.getElementById(id);
  const FADE = 800; // ms, Crossfade-Dauer (siehe .layer-Transition in screen.css)

  const els = {
    offline: $('offline'),
    overlays: $('overlays'),
    ytLayer: $('yt-layer')
  };
  const slots = [$('slot-0'), $('slot-1')];

  let state = null;

  const embedded = !!(window.parent && window.parent !== window);
  const forceLive = new URLSearchParams(location.search).get('view') === 'live';
  const viewer = !embedded ? 'wall' : (forceLive ? 'monitor' : 'preview');
  const isPreview = viewer === 'preview';
  const autoAdvance = viewer !== 'monitor'; // Monitor wird vom Heartbeat gesteuert.

  // ---- WebSocket mit Auto-Reconnect --------------------------------------
  let ws = null;
  let reconnectTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const roleParam = viewer === 'preview' ? '?role=preview'
      : viewer === 'monitor' ? '?role=monitor' : '';
    ws = new WebSocket(`${proto}://${location.host}/${roleParam}`);

    ws.addEventListener('open', () => { els.offline.classList.add('hidden'); rejoinShare(); });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'rtc') { onRtcMessage(msg); return; }
        if (msg.type === 'state') { applyOffAir(msg.offair); applyState(msg.state); }
        else if (msg.type === 'cmd' && msg.cmd === 'seek') seekCurrent(msg.time);
        else if (msg.type === 'cmd' && msg.cmd === 'goto') gotoEntry(msg.itemId, msg.time, msg.progTime);
        else if (msg.type === 'cmd' && msg.cmd === 'pause') previewPause();
        else if (msg.type === 'cmd' && msg.cmd === 'play') previewPlay();
        else if (msg.type === 'cmd' && msg.cmd === 'nowplaying') { if (viewer === 'monitor') applyNowPlaying(msg); }
        else if (msg.type === 'cmd' && msg.cmd === 'element') applyElementPatch(msg.eid, msg.patch);
        else if (msg.type === 'cmd' && msg.cmd === 'flash') applyFlash(msg.id, msg.element, msg.ms);
        else if (msg.type === 'cmd' && msg.cmd === 'flash-clear') clearFlash(msg.id);
        else if (msg.type === 'cmd' && msg.cmd === 'sync-request') { if (viewer === 'wall') sendNowPlaying(); }
      } catch (_) { /* ignorieren */ }
    });
    ws.addEventListener('close', () => { els.offline.classList.remove('hidden'); scheduleReconnect(); });
    ws.addEventListener('error', () => ws.close());
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
  }
  connect();

  // Fallback: aktuellen Zustand auch per HTTP holen (Entwurf für Vorschau, sonst Live).
  fetch('/api/state' + (isPreview ? '' : '?view=live'))
    .then((r) => r.json()).then(applyState).catch(() => {});

  // ===== Off Air (Wand komplett gestoppt = schwarz) ======================
  // Gilt nur für die echte Wand + den Live-Monitor; die Entwurf-Vorschau bleibt
  // bedienbar (Off Air betrifft nur die Live-Übertragung).
  let offAirState = false;
  function applyOffAir(off) {
    if (viewer === 'preview') return;
    off = !!off;
    if (off === offAirState) return;
    offAirState = off;
    if (off) { clearTimer(); clearStage(); els.overlays.classList.add('hidden'); }
    else { els.overlays.classList.remove('hidden'); afterStateRebuild(); }
  }

  // ===== Zustand anwenden =================================================
  function applyState(s) {
    if (!s) return;
    state = s;
    if (offAirState) { els.overlays.classList.add('hidden'); clearTimer(); clearStage(); renderOverlays(); return; }
    afterStateRebuild();   // setzt topId (welche Playlist überträgt)
    renderOverlays();      // Overlay-Layer aus den Clips dieser Playlist bauen
  }

  // ===== Overlays (mehrere Zeit-Clips über dem Content) ===================
  // DOM wird bei Statewechsel neu aufgebaut; ein ~250ms-Tick blendet die Layer
  // passend zur Programmzeit (start/duration) ein/aus.
  let overlayLayers = [];      // [{ overlay, layerEl }]
  let dynTimers = [];          // Intervalle dynamischer (url-gebundener) Elemente
  let elById = {};             // Element-ID -> [Applier], für Live-Pushes (POST /api/element/:id)
  const regEl = (id, fn) => { (elById[id] = elById[id] || []).push(fn); };
  function applyElementPatch(eid, patch) {
    const fns = elById[eid];
    if (!fns || !patch) return;
    for (const fn of fns) { try { fn(patch); } catch (_) {} }
  }

  // Overlays werden aus den Clips der aktuell übertragenen Playlist (topId) gebaut.
  // Ein Layer je Clip; mehrere Clips können dasselbe Overlay referenzieren (mehrere Fenster).
  function currentClips() {
    const pl = state && state.playlists && state.playlists.byId[topId];
    return (pl && pl.overlayClips) || [];
  }
  const overlayById = (id) => (state && state.overlays || []).find((o) => o.id === id);
  function renderOverlays() {
    dynTimers.forEach(clearInterval); dynTimers = [];
    els.overlays.innerHTML = '';
    overlayLayers = [];
    elById = {};
    for (const clip of currentClips()) {
      const o = overlayById(clip.overlayId);
      if (!o) continue;
      const layer = document.createElement('div');
      layer.className = 'ov-layer hidden';
      if (o.blur > 0) {
        const bd = document.createElement('div');
        bd.className = 'ov-backdrop';
        bd.style.backdropFilter = bd.style.webkitBackdropFilter = `blur(${o.blur}px)`;
        layer.appendChild(bd);
      }
      for (const e of o.elements) layer.appendChild(buildElement(e));
      els.overlays.appendChild(layer);
      overlayLayers.push({ clip, overlay: o, layerEl: layer });
    }
    updateOverlayVisibility();
  }

  // Hex-Farbe mit Deckkraft als rgba() (lässt den Rand opak, nur die Füllung wird
  // transparent). Bei Nicht-Hex-Farbe oder Deckkraft 1 wird die Farbe unverändert genutzt.
  function withAlpha(color, a) {
    if (a == null || a >= 1) return color;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || '');
    if (!m) return color;
    let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  // Flächen-Stil als eigener Layer HINTER dem Inhalt (Füllung/Rand/Radius/Blur), damit
  // Blur/Hintergrund den Text nicht verwischen. Liefert null, wenn nichts zu zeigen ist.
  // Längenangaben (Rand/Radius/Blur) sind in Design-Pixeln (Canvas 4320×3840) gedacht
  // und werden – wie die Schriftgröße – relativ zur Ausgabehöhe in vh umgerechnet.
  const DESIGN_H = 3840;
  const dvh = (px) => (px / DESIGN_H * 100) + 'vh';
  function surfaceEl(e, fillColor) {
    const border = e.border && e.border.enabled && e.border.width > 0;
    const blur = e.blur > 0;
    const isShape = e.type === 'shape';
    const fill = !!(fillColor && fillColor !== '');
    if (!isShape && !border && !blur && !fill) return null;
    const s = document.createElement('div');
    s.className = 'ov-surface';
    if (isShape && e.shape === 'circle') s.style.borderRadius = '50%';
    else if (e.radius > 0) s.style.borderRadius = dvh(e.radius);
    if (fill) s.style.background = withAlpha(fillColor, e.fillOpacity);
    if (border) { s.style.borderStyle = 'solid'; s.style.borderColor = e.border.color; s.style.borderWidth = dvh(e.border.width); }
    if (blur) {
      const f = `blur(${dvh(e.blur)})`;
      if (e.blurMode === 'self') s.style.filter = f;
      else s.style.backdropFilter = s.style.webkitBackdropFilter = f;
    }
    return s;
  }

  function buildElement(e) {
    const box = document.createElement('div');
    box.className = `ov-el ov-${e.type}`;
    box.dataset.eid = e.id;
    box.style.left = pct(e.x); box.style.top = pct(e.y);
    box.style.width = pct(e.w); box.style.height = pct(e.h);
    if (e.type === 'text') {
      box.classList.add(`align-${e.align || 'center'}`);
      const s = surfaceEl(e, e.bg);
      if (s) box.appendChild(s);
      if (e.pad > 0) box.style.padding = `${e.pad * (e.h || 0.1) * 100}vh`;
      const tx = document.createElement('div');
      tx.className = 'ov-text-content';
      tx.style.color = e.color || '#fff';
      tx.style.fontWeight = e.weight || 700;
      tx.style.fontSize = `${(e.fontFrac || 0.5) * (e.h || 0.1) * 100}vh`;
      tx.textContent = e.text || '';
      box.appendChild(tx);
      bindDynamic(e, (val) => { tx.textContent = val; });
      regEl(e.id, (p) => { if (p.text != null) tx.textContent = p.text; if (p.color) tx.style.color = p.color; });
    } else if (e.type === 'shape') {
      const s = surfaceEl(e, e.fill);
      if (s) box.appendChild(s);
      regEl(e.id, (p) => { if (p.fill && s) s.style.background = withAlpha(p.fill, e.fillOpacity); });
    } else if (e.type === 'image') {
      const img = document.createElement('img');
      img.className = `ov-img ${e.fit || 'contain'}`;
      img.alt = '';
      img.src = e.filename ? `/uploads/${e.filename}` : (e.url || '');
      box.appendChild(img);
      bindDynamic(e, (val) => { if (val) img.src = val; });
      regEl(e.id, (p) => { if (p.filename) img.src = `/uploads/${p.filename}`; else if (p.url != null) img.src = p.url; });
    } else if (e.type === 'qr') {
      const img = document.createElement('img');
      img.className = 'ov-qr'; img.alt = '';
      const set = (data) => { img.src = `/api/qr?data=${encodeURIComponent(data || ' ')}&fg=${encodeURIComponent(e.fg || '#000')}&bg=${encodeURIComponent(e.bg || '#fff')}`; };
      set(e.data);
      box.appendChild(img);
      bindDynamic(e, (val) => set(val));
      regEl(e.id, (p) => { if (p.data != null) set(p.data); });
    }
    return box;
  }
  const pct = (v) => `${(v || 0) * 100}%`;

  // ===== Flash: Inhalt für N Sekunden über allem einblenden (POST /api/flash) =====
  let flashLayer = null;
  const flashTimers = {};
  function flashRoot() {
    if (!flashLayer) {
      flashLayer = document.createElement('div');
      flashLayer.style.cssText = 'position:fixed;inset:0;z-index:600;pointer-events:none;';
      document.body.appendChild(flashLayer);
    }
    return flashLayer;
  }
  function applyFlash(id, element, ms) {
    if (!element) return;
    const key = id || 'flash';
    clearFlash(key);
    const box = buildElement(element); // .ov-el, per % positioniert
    box.dataset.flashId = key;
    flashRoot().appendChild(box);
    flashTimers[key] = setTimeout(() => { box.remove(); delete flashTimers[key]; }, Math.max(500, ms || 8000));
  }
  function clearFlash(id) {
    const root = flashRoot();
    if (id) {
      if (flashTimers[id]) { clearTimeout(flashTimers[id]); delete flashTimers[id]; }
      root.querySelectorAll(`[data-flash-id="${id}"]`).forEach((n) => n.remove());
    } else {
      Object.values(flashTimers).forEach(clearTimeout);
      for (const k in flashTimers) delete flashTimers[k];
      root.innerHTML = '';
    }
  }

  // Dynamische Quelle (Phase 1): periodisch über den Server-Proxy /api/fetch laden.
  function bindDynamic(e, apply) {
    const s = e.source;
    if (!s || s.kind !== 'url' || !s.url) return;
    const load = async () => {
      try {
        const r = await fetch(`/api/fetch?url=${encodeURIComponent(s.url)}`);
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json') && s.jsonPath) {
          const j = await r.json();
          apply(String(s.jsonPath.split('.').reduce((a, k) => (a == null ? a : a[k]), j) ?? ''));
        } else {
          apply((await r.text()).trim());
        }
      } catch (_) {}
    };
    load();
    dynTimers.push(setInterval(load, Math.max(2, s.refreshSec || 60) * 1000));
  }

  // Aktive Overlays nach Programmzeit ein-/ausblenden (Fenster = Clip start/duration).
  function updateOverlayVisibility() {
    const t = programTime();
    for (const { clip, layerEl } of overlayLayers) {
      const end = clip.duration == null ? Infinity : clip.start + clip.duration;
      const active = clip.enabled && t >= clip.start && t < end;
      layerEl.classList.toggle('hidden', !active);
    }
  }
  setInterval(updateOverlayVisibility, 250);

  // ===== YouTube-Player (persistent, IFrame-API) ==========================
  const YT = (() => {
    let player = null, ready = false, pending = null;
    let onEndedCb = null, curVideoId = null;

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = () => create();

    function create() {
      player = new window.YT.Player('yt-player', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            ready = true;
            try { player.getIframe().setAttribute('allow', 'autoplay; encrypted-media; fullscreen; playsinline'); } catch (_) {}
            if (pending) { const p = pending; pending = null; p(); }
          },
          onStateChange: (e) => { if (e.data === window.YT.PlayerState.ENDED && onEndedCb) onEndedCb(); },
          onError: () => { if (onEndedCb) onEndedCb(); }
        }
      });
    }

    // opts: { videoId, muted, startSeconds, force, onEnded }
    function play(opts) {
      onEndedCb = opts.onEnded || null;
      const muted = opts.muted !== false;
      if (!opts.videoId) return;
      if (!ready) { pending = () => play(opts); return; }
      if (opts.videoId === curVideoId && !opts.force) {
        try { muted ? player.mute() : player.unMute(); player.playVideo(); } catch (_) {}
        return;
      }
      curVideoId = opts.videoId;
      try {
        player.loadVideoById({ videoId: opts.videoId, startSeconds: Math.max(0, opts.startSeconds || 0) });
        muted ? player.mute() : player.unMute();
        player.playVideo();
      } catch (_) {}
    }
    function pause() { try { if (player && player.pauseVideo) player.pauseVideo(); } catch (_) {} }
    function resume() { try { if (ready && player && player.playVideo) player.playVideo(); } catch (_) {} }
    function seek(t) { try { if (ready && player && player.seekTo) { player.seekTo(t, true); player.playVideo(); } } catch (_) {} }
    function getPos() {
      try { if (ready && player && player.getDuration) { const d = player.getDuration(); if (d > 0) return { time: player.getCurrentTime(), duration: d }; } } catch (_) {}
      return null;
    }
    return { play, pause, resume, seek, getPos };
  })();

  // ===== Playlist-Scheduler ===============================================
  let topId = null;      // aktuelle Top-Playlist (Übertragung)
  let lastRootId = null; // zuletzt gesehene rootId – erkennt Wechsel der Programm-Playlist
  let seq = [];          // ausgeflachte Content-Liste: [{ itemId, content }]
  let idx = 0;
  let current = null;    // { itemId, type, contentJSON, videoEl }
  let activeSlot = 0;    // welcher der beiden Crossfade-Slots gerade sichtbar ist
  let advanceTimer = null, cleanupTimer = null, monFallback = null;

  // Vorschau-Uhr (nur viewer 'preview'): misst die verstrichene Zeit im aktuellen
  // Content – auch für statische Inhalte (Farbe/Bild) – und ist pausierbar. Damit
  // kann die Programm-Timeline (/programm) den Playhead der Wiedergabe folgen lassen
  // und per cmd play/pause steuern.
  let previewPaused = false;
  let pvBaseMs = 0, pvStartTs = null;
  function pvElapsed() { return (pvBaseMs + (pvStartTs != null ? performance.now() - pvStartTs : 0)) / 1000; }
  function pvReset(off, running) { pvBaseMs = Math.max(0, (off || 0) * 1000); pvStartTs = running ? performance.now() : null; }
  function pvPause() { if (pvStartTs != null) { pvBaseMs += performance.now() - pvStartTs; pvStartTs = null; } }
  function pvResume() { if (pvStartTs == null) pvStartTs = performance.now(); }

  // Programmzeit (Sekunden ab Programmstart) – Grundlage für die Overlay-Zeit-Clips.
  // progBase = Summe bereits gespielter Block-Dauern; + verstrichene Zeit im Content.
  let progBase = 0;
  let wallProgTime = 0; // vom Wand-Heartbeat (für viewer 'monitor')
  function contentElapsed() {
    if (!current) return 0;
    if (current.type === 'youtube') { const p = YT.getPos(); return p ? p.time : pvElapsed(); }
    if (current.videoEl && isFinite(current.videoEl.duration)) return current.videoEl.currentTime || 0;
    return pvElapsed();
  }
  function programTime() {
    if (viewer === 'monitor') return wallProgTime;
    return progBase + contentElapsed();
  }

  // Top-Playlist rekursiv ausflachen; verschachtelte Playlists inline einfügen.
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

  function rebuild() {
    const pls = state && state.playlists;
    if (!pls || !pls.byId) { seq = []; return; }
    if (!topId || !pls.byId[topId]) topId = pls.rootId;
    seq = pls.byId[topId] ? flatten(topId, pls.byId, new Set()) : [];
  }

  // Nach einem Statewechsel: Anzeige möglichst stabil halten (kein Neustart,
  // wenn der gerade gezeigte Content weiter existiert). Wurde aber eine NEUE
  // Programm-Playlist gewählt (rootId geändert), die Übertragung darauf umstellen –
  // topId folgt sonst nur beim Ketten via after:'next', nicht bei der Auswahl.
  function afterStateRebuild() {
    const newRoot = state && state.playlists ? state.playlists.rootId : null;
    const rootChanged = lastRootId !== null && newRoot !== lastRootId;
    lastRootId = newRoot;
    if (rootChanged) { topId = newRoot; progBase = 0; }
    rebuild();
    if (rootChanged && autoAdvance) { idx = 0; seq.length ? showCurrent() : clearStage(); return; }
    const curId = current && current.itemId;
    const found = curId ? seq.findIndex((e) => e.itemId === curId) : -1;
    if (autoAdvance) {
      if (found === -1) { idx = 0; seq.length ? showCurrent() : clearStage(); }
      else {
        idx = found;
        // Inhaltliche Änderung desselben Items -> in-place neu zeigen.
        if (JSON.stringify(seq[idx].content) !== current.contentJSON) showCurrent();
      }
    } else {
      if (!seq.length) clearStage();
      else if (found !== -1) idx = found;
      scheduleMonitorFallback();
    }
  }

  function scheduleMonitorFallback() {
    if (viewer !== 'monitor') return;
    clearTimeout(monFallback);
    // Falls keine Wand antwortet (kein nowplaying), nach kurzer Zeit selbst den
    // ersten Content zeigen (Best Effort), damit der Monitor nicht schwarz bleibt.
    monFallback = setTimeout(() => { if (!current && seq.length) { idx = 0; showContent(seq[0]); } }, 2500);
  }

  function clearTimer() { clearTimeout(advanceTimer); advanceTimer = null; }

  function clearStage() {
    clearTimer();
    stopShareReceiver();
    closeExternalWindow();
    [slots[0], slots[1], els.ytLayer].forEach((L) => L.classList.remove('active'));
    slots.forEach((s) => { s.innerHTML = ''; });
    YT.pause();
    current = null;
  }

  function showCurrent(opts) {
    if (!seq.length) { clearStage(); return; }
    if (idx >= seq.length) idx = 0;
    showContent(seq[idx], opts);
  }

  // Einen Content in die Bühne bringen (Crossfade) und – auf Wand/Vorschau –
  // das Weiterschalten planen.
  function showContent(entry, opts) {
    if (offAirState) return; // Off Air: nichts anzeigen
    opts = opts || {};
    const c = entry.content;
    clearTimer();
    // Beim Verlassen eines Screenshare-Blocks die PeerConnection abbauen (der
    // Capture-Stream beim Publisher bleibt erhalten). buildNode startet bei einem
    // neuen Screenshare-Block den Empfang erneut.
    stopShareReceiver();
    // Beim Wechsel auf Nicht-External-Content das native Fenster schließen. Bei
    // External→External übernimmt der Open-Endpunkt das Ersetzen (vermeidet ein
    // Wettrennen zwischen close und open).
    if (c.type !== 'external') closeExternalWindow();

    if (c.type === 'youtube') {
      els.ytLayer.classList.toggle('crop', !!c.crop);
      YT.play({
        videoId: c.videoId, muted: c.muted !== false,
        startSeconds: opts.startSeconds || 0,
        force: viewer !== 'monitor', // Wand/Vorschau starten neu; Monitor steigt ein
        onEnded: (autoAdvance && !isPreview && c.videoMode !== 'duration') ? advance : null
      });
      activate(els.ytLayer);
      current = { itemId: entry.itemId, type: 'youtube', content: c, contentJSON: JSON.stringify(c), videoEl: null };
    } else {
      const slot = slots[1 - activeSlot];
      slot.innerHTML = '';
      const node = buildNode(c);
      slot.appendChild(node);
      const v = node.querySelector('video');
      if (v) { try { v.currentTime = opts.startSeconds || 0; } catch (_) {} v.play().catch(() => {}); }
      activate(slot);
      activeSlot = 1 - activeSlot;
      current = { itemId: entry.itemId, type: c.type, content: c, contentJSON: JSON.stringify(c), videoEl: v || null };
    }

    // Content-Uhr für alle Sichten starten (Programmzeit/Overlay-Scheduling, und
    // in der Vorschau pausierbar). Wand: zusätzlich klassisches scheduleAdvance.
    pvReset(opts.startSeconds || 0, !(isPreview && previewPaused));
    if (isPreview) {
      if (previewPaused) pauseCurrentMedia();
    } else if (autoAdvance) {
      scheduleAdvance(entry);
    }
  }

  function pauseCurrentMedia() {
    if (!current) return;
    if (current.type === 'youtube') YT.pause();
    else if (current.videoEl) { try { current.videoEl.pause(); } catch (_) {} }
  }
  function playCurrentMedia() {
    if (!current) return;
    if (current.type === 'youtube') YT.resume();
    else if (current.videoEl) current.videoEl.play().catch(() => {});
  }
  function previewPause() { if (!isPreview) return; previewPaused = true; pvPause(); pauseCurrentMedia(); }
  function previewPlay() { if (!isPreview) return; previewPaused = false; pvResume(); playCurrentMedia(); }

  // Sichtbare Schicht setzen; nicht sichtbare Slots nach dem Fade entladen
  // (stoppt Video/Audio in iframes).
  function activate(layer) {
    [slots[0], slots[1], els.ytLayer].forEach((L) => L.classList.toggle('active', L === layer));
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      slots.forEach((s) => { if (s !== layer) s.innerHTML = ''; });
      if (layer !== els.ytLayer) YT.pause();
    }, FADE + 80);
  }

  function buildNode(c) {
    const node = document.createElement('div');
    node.className = 'content';
    if (c.type === 'color') {
      node.style.background = c.color || '#000000';
    } else if (c.type === 'image') {
      const img = document.createElement('img');
      img.src = `/uploads/${c.filename}`;
      img.className = c.crop ? 'cover' : 'contain';
      node.appendChild(img);
    } else if (c.type === 'video') {
      const v = document.createElement('video');
      v.src = `/uploads/${c.filename}`;
      v.muted = c.muted !== false; v.playsInline = true; v.preload = 'auto';
      v.className = c.crop ? 'cover' : 'contain';
      node.appendChild(v);
    } else if (c.type === 'webpage') {
      if (c.embeddable === false) node.appendChild(buildNotice('Diese Seite erlaubt keine Einbettung', c.url));
      else {
        const f = document.createElement('iframe');
        f.src = c.url || 'about:blank';
        f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media');
        f.setAttribute('referrerpolicy', 'no-referrer');
        node.appendChild(f);
      }
    } else if (c.type === 'screenshare') {
      node.classList.add('screenshare');
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = !c.withAudio;
      v.className = 'contain';
      node.appendChild(v);
      const notice = buildShareNotice(c.sessionId);
      node.appendChild(notice);
      // Empfang nur auf Wand/Monitor aufbauen – die Entwurf-Vorschau zeigt nur den Hinweis.
      if (!isPreview) startShareReceiver(c, node, v);
    } else if (c.type === 'external') {
      // Externer Inhalt (z.B. DRM-Streaming): wird als nativer Vollbild-Browser auf
      // dem Anzeige-PC geöffnet (legt sich über die Wand). Hier nur ein neutraler
      // Halte-Hintergrund mit Namen – sichtbar in Vorschau/Monitor und kurz beim
      // Schließen des nativen Fensters.
      node.classList.add('external');
      node.appendChild(buildNotice(c.name || 'Externer Inhalt', ''));
      if (viewer === 'wall') openExternalWindow(c.url);
    }
    return node;
  }

  // External-Content steuert ein natives Browserfenster auf dem Anzeige-PC. Nur die
  // eigentliche Wand (viewer === 'wall') löst das aus; Monitor/Vorschau ignorieren es.
  function openExternalWindow(url) {
    if (viewer !== 'wall' || !url) return;
    fetch('/api/external/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    }).catch(() => {});
  }
  function closeExternalWindow() {
    if (viewer !== 'wall') return;
    fetch('/api/external/close', { method: 'POST' }).catch(() => {});
  }

  // Beitritts-Hinweis für einen Screenshare-Block: Titel, Share-URL und QR-Code.
  // URL/QR werden asynchron ergänzt, sobald der HTTPS-Port bekannt ist.
  function buildShareNotice(sessionId) {
    const wrap = document.createElement('div');
    wrap.className = 'link-notice share-notice';
    const box = document.createElement('div'); box.className = 'link-notice-box';
    const t = document.createElement('div'); t.className = 'link-notice-title';
    t.textContent = 'Bildschirm hier teilen';
    const qr = document.createElement('div'); qr.className = 'share-qr';
    const img = document.createElement('img'); qr.appendChild(img);
    const u = document.createElement('div'); u.className = 'link-notice-url'; u.textContent = '…';
    box.appendChild(t); box.appendChild(qr); box.appendChild(u);
    wrap.appendChild(box);
    shareUrl(sessionId).then((url) => {
      u.textContent = url;
      img.src = `/api/qr?data=${encodeURIComponent(url)}`;
    });
    return wrap;
  }

  function buildNotice(title, url) {
    const wrap = document.createElement('div');
    wrap.className = 'link-notice';
    const box = document.createElement('div'); box.className = 'link-notice-box';
    const t = document.createElement('div'); t.className = 'link-notice-title'; t.textContent = title;
    const u = document.createElement('div'); u.className = 'link-notice-url'; u.textContent = url || '';
    box.appendChild(t); box.appendChild(u); wrap.appendChild(box);
    return wrap;
  }

  // ===== Bildschirmfreigabe (WebRTC-Empfang) =============================
  // Die Wand ist Empfänger (Viewer): Sie tritt der Session des Screenshare-Blocks
  // bei; der teilende Browser (Publisher) baut die Verbindung auf. Pro Publisher
  // eine RTCPeerConnection. Der Capture-Stream lebt beim Publisher weiter – beim
  // Wechsel des Wand-Inhalts bauen wir nur die PeerConnection ab.
  const RTC_CONFIG = { iceServers: [] }; // LAN: Host-Kandidaten genügen
  let currentShare = null; // { sessionId, node, video, pcs: Map<peerId, RTCPeerConnection> }
  let configPromise = null;

  function getConfig() {
    if (!configPromise) {
      configPromise = fetch('/api/config').then((r) => r.json())
        .catch(() => ({ httpsPort: null, lanHosts: [] }));
    }
    return configPromise;
  }
  function isLocalHost(h) { return !h || h === 'localhost' || h === '127.0.0.1' || h === '::1'; }

  async function shareUrl(sessionId) {
    const cfg = await getConfig();
    // Wird die Wall lokal angezeigt (localhost-Kiosk auf dem Server), ist der
    // Browser-Host für entfernte Geräte unbrauchbar → die vom Server gemeldete
    // LAN-IP verwenden. Sonst den Host nehmen, über den die Wall geöffnet wurde.
    let host = location.hostname;
    if (isLocalHost(host) && cfg.lanHosts && cfg.lanHosts.length) host = cfg.lanHosts[0];
    if (location.protocol === 'https:' && !isLocalHost(location.hostname)) {
      return `${location.origin}/share?s=${sessionId}`;
    }
    if (cfg.httpsPort) return `https://${host}:${cfg.httpsPort}/share?s=${sessionId}`;
    return `${location.protocol}//${host}:${location.port || 80}/share?s=${sessionId}`; // Fallback (kein HTTPS)
  }

  function rtcSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rtc', ...obj }));
  }

  function startShareReceiver(content, node, video) {
    stopShareReceiver();
    const sessionId = content.sessionId;
    currentShare = { sessionId, node, video, pcs: new Map() };
    rtcSend({ kind: 'join', session: sessionId, peerRole: 'viewer' });
  }

  function stopShareReceiver() {
    if (!currentShare) return;
    rtcSend({ kind: 'bye', session: currentShare.sessionId });
    for (const pc of currentShare.pcs.values()) { try { pc.close(); } catch (_) {} }
    currentShare = null;
  }

  // Verbindung nach WS-Reconnect erneuern: alte PCs verwerfen und neu beitreten.
  function rejoinShare() {
    if (!currentShare) return;
    for (const pc of currentShare.pcs.values()) { try { pc.close(); } catch (_) {} }
    currentShare.pcs.clear();
    setShareLive(false);
    rtcSend({ kind: 'join', session: currentShare.sessionId, peerRole: 'viewer' });
  }

  function setShareLive(live) {
    if (currentShare && currentShare.node) currentShare.node.classList.toggle('live', !!live);
  }

  async function onRtcMessage(msg) {
    if (!currentShare) return;
    const from = msg.from;
    if (msg.kind === 'offer') {
      // Publisher startet die Verbindung. PC anlegen, Antwort senden.
      let pc = currentShare.pcs.get(from);
      if (pc) { try { pc.close(); } catch (_) {} }
      pc = new RTCPeerConnection(RTC_CONFIG);
      currentShare.pcs.set(from, pc);
      pc.onicecandidate = (e) => {
        if (e.candidate) rtcSend({ kind: 'ice', session: currentShare.sessionId, to: from, candidate: e.candidate });
      };
      pc.ontrack = (e) => {
        if (currentShare && currentShare.video) {
          currentShare.video.srcObject = e.streams[0];
          currentShare.video.play().catch(() => {});
          setShareLive(true);
        }
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          if (currentShare && currentShare.pcs.get(from) === pc) {
            currentShare.pcs.delete(from);
            try { pc.close(); } catch (_) {}
            if (currentShare.pcs.size === 0) setShareLive(false);
          }
        }
      };
      try {
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        rtcSend({ kind: 'answer', session: currentShare.sessionId, to: from, sdp: pc.localDescription });
      } catch (_) { /* ignorieren */ }
    } else if (msg.kind === 'ice') {
      const pc = currentShare.pcs.get(from);
      if (pc && msg.candidate) { try { await pc.addIceCandidate(msg.candidate); } catch (_) {} }
    } else if (msg.kind === 'bye') {
      const pc = currentShare.pcs.get(from);
      if (pc) { try { pc.close(); } catch (_) {} currentShare.pcs.delete(from); }
      if (currentShare.pcs.size === 0) setShareLive(false);
    }
    // 'join'/'peers' brauchen wir als Viewer nicht – der Publisher initiiert.
  }

  function scheduleAdvance(entry) {
    clearTimer();
    const c = entry.content;
    // Bildschirmfreigabe hält, solange präsentiert wird – kein automatisches
    // Weiterschalten (manuelles Weiterschalten/golive bleibt möglich).
    if (c.type === 'screenshare') return;
    if (c.type === 'video' && c.videoMode !== 'duration') {
      if (current && current.videoEl) current.videoEl.onended = () => advance();
      advanceTimer = setTimeout(advance, (c.durationSec || 6) * 1000 + 600000); // Sicherheitsnetz
      return;
    }
    if (c.type === 'youtube' && c.videoMode !== 'duration') {
      advanceTimer = setTimeout(advance, 600000); // YT meldet Ende via onEnded; nur Sicherheitsnetz
      return;
    }
    advanceTimer = setTimeout(advance, Math.max(1, c.durationSec || 6) * 1000);
  }

  function advance() {
    if (!autoAdvance) return;
    clearTimer();
    progBase += contentElapsed(); // gespielte Dauer des verlassenen Blocks aufaddieren
    idx++;
    if (idx < seq.length) { showCurrent(); return; }
    applyAfter();
  }

  function applyAfter() {
    const pl = state.playlists.byId[topId];
    const after = pl ? pl.after : 'loop';
    if (after === 'stop') return; // letztes Bild bleibt stehen
    const prevTop = topId;
    if (after === 'next' && pl.nextId && state.playlists.byId[pl.nextId]) topId = pl.nextId;
    rebuild();
    idx = 0;
    progBase = 0; // Programm beginnt von vorn (Loop/Next)
    if (topId !== prevTop) renderOverlays(); // andere Playlist -> andere Overlay-Clips
    seq.length ? showCurrent() : clearStage();
  }

  // ===== Wand <-> Monitor / Vorschau ======================================
  function curContent() { return seq[idx] ? seq[idx].content : null; }

  function sendNowPlaying() {
    if (viewer !== 'wall' || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!current) { ws.send(JSON.stringify({ type: 'cmd', cmd: 'nowplaying' })); return; }
    let time = 0, duration = 0;
    if (current.type === 'youtube') { const p = YT.getPos(); if (p) { time = p.time; duration = p.duration; } }
    else if (current.type === 'video' && current.videoEl) { time = current.videoEl.currentTime || 0; duration = current.videoEl.duration || 0; }
    const c = curContent();
    ws.send(JSON.stringify({
      type: 'cmd', cmd: 'nowplaying',
      contentId: current.itemId, ctype: current.type,
      videoId: (c && c.videoId) || null, time, duration, progTime: programTime()
    }));
  }

  // Monitor: strikt der Wandposition folgen.
  function applyNowPlaying(np) {
    if (viewer !== 'monitor') return;
    if (!np || !np.contentId) return;
    if (typeof np.progTime === 'number') { wallProgTime = np.progTime; updateOverlayVisibility(); }
    const i = seq.findIndex((e) => e.itemId === np.contentId);
    if (i === -1) return;
    idx = i;
    if (!current || current.itemId !== np.contentId) {
      showContent(seq[i], { startSeconds: np.time || 0 });
    } else if (typeof np.time === 'number' && (current.type === 'youtube' || current.type === 'video')) {
      // Gleicher Content: Drift gegen die Wand korrigieren (z. B. nach Go Live), damit
      // der Live-Mirror nicht dauerhaft versetzt bleibt, bis der Content wechselt.
      if (Math.abs(contentElapsed() - np.time) > 1.2) seekCurrent(np.time);
    }
  }

  function requestSync() {
    if (embedded && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmd', cmd: 'sync-request' }));
    }
  }

  // Springt zu einem Content der ausgeflachten Sequenz (per itemId) und startet ihn
  // ab `time` Sekunden. Wird von der Programm-Timeline (/programm) beim Scrubbing
  // genutzt: setzt die Vorschau auf den Playhead-Punkt. In der Vorschau läuft danach
  // der Auto-Advance regulär weiter. No-op bei unbekannter itemId.
  function gotoEntry(itemId, time, progT) {
    if (!itemId) return;
    const i = seq.findIndex((e) => e.itemId === itemId);
    if (i === -1) return;
    idx = i;
    const off = Math.max(0, time || 0);
    // Programmzeit am Sprungziel setzen, damit Overlay-Scheduling/Playhead passen.
    progBase = (typeof progT === 'number') ? Math.max(0, progT - off) : progBase;
    showContent(seq[i], { startSeconds: off });
    updateOverlayVisibility();
  }

  function seekCurrent(time) {
    if (!current) return;
    if (current.type === 'youtube') YT.seek(time);
    else if (current.type === 'video' && current.videoEl) {
      try { current.videoEl.currentTime = time; current.videoEl.play().catch(() => {}); } catch (_) {}
    }
  }

  // Vorschau-Tick: meldet Position (inkl. itemId + verstrichene Zeit auch für
  // statische Inhalte) an /programm und schaltet selbst weiter (pausierbar).
  function previewTick() {
    const c = current && current.content;
    let pos = null, effEnd = null;
    if (current) {
      if (current.type === 'youtube') {
        const p = YT.getPos();
        if (p) { pos = p; effEnd = c.videoMode !== 'duration' ? p.duration : (c.durationSec || 6); }
        else { pos = { time: pvElapsed(), duration: c.durationSec || 6 }; }
      } else if (current.type === 'video' && current.videoEl && isFinite(current.videoEl.duration) && current.videoEl.duration > 0) {
        const v = current.videoEl;
        pos = { time: v.currentTime, duration: v.duration };
        effEnd = c.videoMode !== 'duration' ? v.duration : (c.durationSec || 6);
      } else {
        // Statischer Content (Farbe/Bild/Webseite) bzw. Video vor Metadaten.
        pos = { time: pvElapsed(), duration: (c && c.durationSec) || 6 };
        effEnd = (c && c.durationSec) || 6;
      }
    }
    window.parent.postMessage({
      type: 'screen-pos', mode: current ? current.type : null,
      itemId: current ? current.itemId : null, paused: previewPaused, pos
    }, '*');
    if (!previewPaused && effEnd && pos && pos.time >= effEnd - 0.2) advance();
  }

  if (viewer === 'preview') {
    setInterval(previewTick, 200);
    requestSync(); setInterval(requestSync, 2000);
  } else if (viewer === 'monitor') {
    requestSync(); setInterval(requestSync, 2000);
  } else {
    setInterval(sendNowPlaying, 1000);
  }

  // ===== Mauszeiger nach Inaktivität ausblenden ===========================
  let idleTimer = null;
  function resetIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, resetIdle));
  resetIdle();
})();
