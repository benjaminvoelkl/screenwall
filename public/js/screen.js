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
    welcome: $('welcome'),
    wcCard: document.querySelector('.wc-card'),
    wcHeadline: $('wc-headline'),
    wcLeftLogo: $('wc-left-logo'),
    wcLeftText: $('wc-left-text'),
    wcRightLogo: $('wc-right-logo'),
    wcRightText: $('wc-right-text'),
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

    ws.addEventListener('open', () => els.offline.classList.add('hidden'));
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') applyState(msg.state);
        else if (msg.type === 'cmd' && msg.cmd === 'seek') seekCurrent(msg.time);
        else if (msg.type === 'cmd' && msg.cmd === 'goto') gotoEntry(msg.itemId, msg.time);
        else if (msg.type === 'cmd' && msg.cmd === 'pause') previewPause();
        else if (msg.type === 'cmd' && msg.cmd === 'play') previewPlay();
        else if (msg.type === 'cmd' && msg.cmd === 'nowplaying') { if (viewer === 'monitor') applyNowPlaying(msg); }
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

  // ===== Zustand anwenden =================================================
  function applyState(s) {
    if (!s) return;
    state = s;
    renderWelcome(s.welcome || {});
    afterStateRebuild();
  }

  function toggle(el, on) { el.classList.toggle('hidden', !on); }

  // ===== Willkommens-Overlay (über dem Hintergrund) =======================
  function renderWelcome(w) {
    w = w || {};
    const on = w.visible !== false;
    toggle(els.welcome, on);
    if (!on) return;
    [...els.welcome.classList].filter((c) => c.startsWith('tpl-'))
      .forEach((c) => els.welcome.classList.remove(c));
    els.welcome.classList.add(`tpl-${w.template || 'elegant'}`);
    els.wcCard.style.setProperty('--wc-blur', `${w.blur ?? 18}px`);
    els.wcHeadline.textContent = w.headline || '';
    els.wcHeadline.style.fontSize = `${w.fontSize || 8}vw`;
    setSide(els.wcLeftLogo, els.wcLeftText, w.left);
    setSide(els.wcRightLogo, els.wcRightText, w.right);
  }
  function setSide(logoEl, textEl, side) {
    side = side || {};
    if (side.logo) { logoEl.src = `/uploads/${side.logo}`; logoEl.classList.remove('hidden'); }
    else { logoEl.removeAttribute('src'); logoEl.classList.add('hidden'); }
    logoEl.style.width = `${side.logoSize || 22}vw`;
    logoEl.style.height = 'auto';
    textEl.textContent = side.text || '';
    textEl.style.fontSize = `${side.textSize || 4.8}vw`;
    const logoBottom = side.logoPos === 'bottom';
    logoEl.style.order = logoBottom ? '1' : '0';
    textEl.style.order = logoBottom ? '0' : '1';
  }

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
  // wenn der gerade gezeigte Content weiter existiert).
  function afterStateRebuild() {
    rebuild();
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
    opts = opts || {};
    const c = entry.content;
    clearTimer();

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

    // Vorschau: eigene pausierbare Uhr + Weiterschalten per Tick (siehe previewTick).
    // Wand: klassisches scheduleAdvance per Timer.
    if (isPreview) {
      pvReset(opts.startSeconds || 0, !previewPaused);
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
      node.appendChild(buildNotice('Bildschirmübertragung', c.url || '(noch nicht verfügbar)'));
    }
    return node;
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

  function scheduleAdvance(entry) {
    clearTimer();
    const c = entry.content;
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
    idx++;
    if (idx < seq.length) { showCurrent(); return; }
    applyAfter();
  }

  function applyAfter() {
    const pl = state.playlists.byId[topId];
    const after = pl ? pl.after : 'loop';
    if (after === 'stop') return; // letztes Bild bleibt stehen
    if (after === 'next' && pl.nextId && state.playlists.byId[pl.nextId]) topId = pl.nextId;
    rebuild();
    idx = 0;
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
      videoId: (c && c.videoId) || null, time, duration
    }));
  }

  // Monitor: strikt der Wandposition folgen.
  function applyNowPlaying(np) {
    if (viewer !== 'monitor') return;
    if (!np || !np.contentId) return;
    const i = seq.findIndex((e) => e.itemId === np.contentId);
    if (i === -1) return;
    idx = i;
    if (!current || current.itemId !== np.contentId) {
      showContent(seq[i], { startSeconds: np.time || 0 });
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
  function gotoEntry(itemId, time) {
    if (!itemId) return;
    const i = seq.findIndex((e) => e.itemId === itemId);
    if (i === -1) return;
    idx = i;
    showContent(seq[i], { startSeconds: Math.max(0, time || 0) });
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
