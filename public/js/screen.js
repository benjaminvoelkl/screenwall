// Anzeige-Logik für /screen.
// Holt den Zustand per WebSocket, reagiert live und rendert je Modus.
// Bei Verbindungsabbruch wird automatisch neu verbunden.

(() => {
  const els = {
    offline: document.getElementById('offline'),
    welcome: document.getElementById('welcome'),
    wcCard: document.querySelector('.wc-card'),
    wcHeadline: document.getElementById('wc-headline'),
    wcLeftLogo: document.getElementById('wc-left-logo'),
    wcLeftText: document.getElementById('wc-left-text'),
    wcRightLogo: document.getElementById('wc-right-logo'),
    wcRightText: document.getElementById('wc-right-text'),
    slideshow: document.getElementById('slideshow'),
    youtube: document.getElementById('youtube'),
    link: document.getElementById('link'),
    linkFrame: document.getElementById('link-frame'),
    linkNotice: document.getElementById('link-notice'),
    linkNoticeUrl: document.getElementById('link-notice-url')
  };

  let current = null; // letzter Zustand
  // Läuft /screen eingebettet in der Live-Vorschau? Dann synchronisiert es sich
  // zur echten Wand (statt selbst bei null zu starten) und meldet seine Position.
  const embedded = !!(window.parent && window.parent !== window);

  // ---- WebSocket mit Auto-Reconnect --------------------------------------
  let ws = null;
  let reconnectTimer = null;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      els.offline.classList.add('hidden');
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') applyState(msg.state);
        else if (msg.type === 'cmd' && msg.cmd === 'seek') seekCurrent(msg.time);
        // Wand meldet, was gerade läuft -> Vorschau springt dorthin.
        else if (msg.type === 'cmd' && msg.cmd === 'nowplaying') { if (embedded) applyNowPlaying(msg); }
        // Vorschau fragt beim Start -> Wand antwortet sofort mit ihrer Position.
        else if (msg.type === 'cmd' && msg.cmd === 'sync-request') { if (!embedded) sendNowPlaying(); }
      } catch (_) { /* ignorieren */ }
    });
    ws.addEventListener('close', () => {
      els.offline.classList.remove('hidden');
      scheduleReconnect();
    });
    ws.addEventListener('error', () => ws.close());
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1500);
  }

  connect();

  // Fallback: aktuellen Zustand auch per HTTP holen (falls WS verzögert).
  fetch('/api/state').then((r) => r.json()).then(applyState).catch(() => {});

  // ---- Zustand anwenden ---------------------------------------------------
  function applyState(state) {
    const prev = current;
    current = state;

    // Modus-Sichtbarkeit
    const mode = state.mode;
    toggle(els.slideshow, mode === 'slideshow');
    toggle(els.youtube, mode === 'youtube');
    toggle(els.link, mode === 'link');

    // Willkommens-Overlay liegt über jedem Modus (Diashow, YouTube, Link)
    // und wird allein über `visible` ein-/ausgeschaltet.
    renderWelcome(state.welcome);

    if (mode === 'slideshow') Slideshow.update(state.slideshow, prev?.slideshow, prev?.mode !== 'slideshow');
    else Slideshow.stop();

    els.youtube.classList.toggle('crop', !!state.youtube.crop);
    if (mode === 'youtube') YT.update(state.youtube, prev?.youtube, prev?.mode !== 'youtube');
    else YT.stop();

    if (mode === 'link') LinkShow.update(state.link, prev?.link, prev?.mode !== 'link');
    else LinkShow.stop();
  }

  function toggle(el, on) { el.classList.toggle('hidden', !on); }

  // ---- Willkommens-Overlay (über jedem Modus) -----------------------------
  function renderWelcome(w) {
    w = w || {};
    // Unabhängig vom Modus; nur über `visible` gesteuert.
    const on = w.visible !== false;
    toggle(els.welcome, on);
    if (!on) return;

    // Alle vorhandenen tpl-*-Klassen entfernen (nicht nur die alten drei),
    // sonst bleibt beim Umschalten der vorige Stil kleben.
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
    if (side.logo) {
      logoEl.src = `/uploads/${side.logo}`;
      logoEl.classList.remove('hidden');
    } else {
      logoEl.removeAttribute('src');
      logoEl.classList.add('hidden');
    }
    // Breite steuert die Größe (wirkt bei jedem Seitenverhältnis), Höhe folgt.
    logoEl.style.width = `${side.logoSize || 22}vw`;
    logoEl.style.height = 'auto';
    textEl.textContent = side.text || '';
    textEl.style.fontSize = `${side.textSize || 4.8}vw`;
    // Logo über oder unter dem Text (per Flex-order).
    const logoBottom = side.logoPos === 'bottom';
    logoEl.style.order = logoBottom ? '1' : '0';
    textEl.style.order = logoBottom ? '0' : '1';
  }

  // ---- Modus 1: Diashow (eigene Crossfade-Lösung) -------------------------
  const Slideshow = (() => {
    let timer = null;
    let idx = 0;
    let mediaKey = '';
    let media = [];
    let cfg = {};

    function keyOf(m) { return m.map((x) => x.id).join('|'); }

    function update(s, _prev, justEntered) {
      cfg = s;
      // Aktive Sequenz auswählen; deren Medien werden angezeigt.
      const seq = (s.sequences || []).find((x) => x.id === s.activeSequenceId)
        || (s.sequences || [])[0];
      const newMedia = seq ? seq.media : [];
      // Sequenzwechsel zählt als Änderung -> Neuaufbau.
      const newKey = (s.activeSequenceId || '') + '::' + keyOf(newMedia);
      const changed = newKey !== mediaKey;
      media = newMedia;
      mediaKey = newKey;

      if (changed || justEntered) {
        build();
        idx = 0;
        syncedMediaId = '';
        show(0);
        schedule();
      } else {
        // Nur Einstellungen (z. B. Dauer) geändert – Timer neu takten.
        schedule();
      }
    }

    function build() {
      els.slideshow.innerHTML = '';
      for (const m of media) {
        const slide = document.createElement('div');
        slide.className = 'slide';
        if (m.type === 'video') {
          const v = document.createElement('video');
          v.src = `/uploads/${m.filename}`;
          v.muted = true;        // Autoplay nur stummgeschaltet erlaubt.
          v.playsInline = true;
          v.preload = 'auto';
          slide.appendChild(v);
        } else {
          const img = document.createElement('img');
          img.src = `/uploads/${m.filename}`;
          slide.appendChild(img);
        }
        els.slideshow.appendChild(slide);
      }
    }

    function slidesEls() { return Array.from(els.slideshow.children); }

    function show(i) {
      const slides = slidesEls();
      if (!slides.length) return;
      slides.forEach((s, k) => s.classList.toggle('active', k === i));
      const active = slides[i];
      const video = active.querySelector('video');
      // Andere Videos stoppen.
      slides.forEach((s, k) => {
        const v = s.querySelector('video');
        if (v && k !== i) { v.pause(); v.currentTime = 0; }
      });
      if (video) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    }

    function next() {
      const slides = slidesEls();
      if (!slides.length) return;
      idx = (idx + 1) % slides.length;
      show(idx);
      schedule();
    }

    function schedule() {
      clearTimeout(timer);
      const slides = slidesEls();
      if (slides.length <= 1) return; // nichts weiterzuschalten
      const active = slides[idx];
      const video = active && active.querySelector('video');

      if (video && cfg.videoMode === 'end') {
        // Bei Videoende weiterschalten (Entscheidung: Standard = bis Videoende).
        video.onended = () => next();
        // Sicherheitsnetz, falls 'ended' nicht feuert.
        timer = setTimeout(() => next(), (cfg.durationSec || 6) * 1000 + 600000);
      } else {
        timer = setTimeout(() => next(), Math.max(1, cfg.durationSec || 6) * 1000);
      }
    }

    function stop() {
      clearTimeout(timer);
      timer = null;
      slidesEls().forEach((s) => {
        const v = s.querySelector('video');
        if (v) v.pause();
      });
    }

    function activeVideo() {
      const active = slidesEls()[idx];
      return active ? active.querySelector('video') : null;
    }
    function seek(t) {
      const v = activeVideo();
      if (v) { try { v.currentTime = t; v.play().catch(() => {}); } catch (_) {} }
    }
    function getPos() {
      const v = activeVideo();
      if (v && isFinite(v.duration) && v.duration > 0) {
        return { time: v.currentTime, duration: v.duration };
      }
      return null;
    }

    // Welches Medium läuft gerade an welcher Stelle? (für den Wand-Heartbeat)
    function nowPlaying() {
      const m = media[idx];
      if (!m) return null;
      const v = activeVideo();
      return { mediaId: m.id, time: v ? v.currentTime : 0 };
    }

    // Auf das Medium + die Position der Wand springen (nur in der Vorschau).
    let syncedMediaId = '';
    function syncTo(mediaId, time) {
      if (mediaId === syncedMediaId) return;
      const i = media.findIndex((m) => m.id === mediaId);
      if (i < 0) return;
      syncedMediaId = mediaId;
      if (i !== idx) { idx = i; show(idx); schedule(); }
      const v = activeVideo();
      if (v && time > 0) { try { v.currentTime = time; v.play().catch(() => {}); } catch (_) {} }
    }

    return { update, stop, seek, getPos, nowPlaying, syncTo };
  })();

  // ---- Modus 2: YouTube (IFrame API) --------------------------------------
  const YT = (() => {
    let player = null;
    let ready = false;
    let pendingApply = null;
    let videos = [];
    let muted = true;
    let videoKey = '';
    let started = false;

    // YouTube IFrame API laden.
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => {
      player = new YT_API_Player();
    };

    function YT_API_Player() {
      return new window.YT.Player('yt-player', {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            ready = true;
            // Autoplay-Policy moderner Browser: das iframe braucht ein
            // allow="autoplay" und das Abspielen muss explizit (stumm) erfolgen.
            try { player.getIframe().setAttribute('allow', 'autoplay; encrypted-media; fullscreen; playsinline'); } catch (_) {}
            if (pendingApply) { const p = pendingApply; pendingApply = null; apply(...p); }
          },
          onStateChange: (e) => {
            // Bei ENDED automatisch zum nächsten Video.
            if (e.data === window.YT.PlayerState.ENDED) playNext();
          },
          onError: () => playNext() // Defektes Video überspringen.
        }
      });
    }

    let idx = 0;
    function keyOf(v) { return v.map((x) => x.videoId).join('|'); }

    function update(s, _prev, justEntered) {
      videos = s.videos || [];
      muted = s.muted !== false;
      const newKey = keyOf(videos);
      const restart = newKey !== videoKey || justEntered || !started;
      videoKey = newKey;
      if (!ready) { pendingApply = [restart]; return; }
      apply(restart);
    }

    function apply(restart) {
      if (!videos.length) { try { player.stopVideo(); } catch (_) {} started = false; return; }
      if (muted) { try { player.mute(); } catch (_) {} }
      else { try { player.unMute(); } catch (_) {} }
      if (restart) {
        idx = 0;
        syncedVideoId = '';
        load();
        started = true;
      }
    }

    function load() {
      const v = videos[idx];
      if (!v) return;
      try {
        player.loadVideoById(v.videoId);
        // Stummgeschaltetes Abspielen ist von der Autoplay-Policy erlaubt und
        // wird hier explizit angestoßen, falls autoplay ignoriert wird.
        if (muted) { player.mute(); player.playVideo(); }
      } catch (_) {}
    }

    function playNext() {
      if (!videos.length) return;
      idx = (idx + 1) % videos.length;
      load();
    }

    function stop() {
      try { if (player && player.stopVideo) player.stopVideo(); } catch (_) {}
      started = false;
    }

    function seek(t) {
      try { if (ready && player && player.seekTo) { player.seekTo(t, true); player.playVideo(); } } catch (_) {}
    }
    function getPos() {
      try {
        if (ready && player && player.getDuration) {
          const d = player.getDuration();
          if (d > 0) return { time: player.getCurrentTime(), duration: d };
        }
      } catch (_) {}
      return null;
    }

    // Welches Video läuft gerade an welcher Stelle? (für den Wand-Heartbeat)
    function nowPlaying() {
      if (!ready || !player || !videos[idx]) return null;
      let time = 0;
      try { time = player.getCurrentTime ? player.getCurrentTime() : 0; } catch (_) {}
      return { videoId: videos[idx].videoId, time };
    }

    // Auf das Video + die Position der Wand springen (nur in der Vorschau).
    // Springt pro Video nur einmal -> kein ständiges Nachseeken/Ruckeln.
    let syncedVideoId = '';
    function syncTo(videoId, time) {
      if (!ready || !player || videoId === syncedVideoId) return;
      const i = videos.findIndex((v) => v.videoId === videoId);
      if (i < 0) return;
      syncedVideoId = videoId;
      idx = i;
      try {
        player.loadVideoById({ videoId, startSeconds: Math.max(0, time || 0) });
        if (muted) player.mute();
        player.playVideo();
      } catch (_) {}
    }

    return { update, stop, seek, getPos, nowPlaying, syncTo };
  })();

  // ---- Modus 3: Link (Webseiten im Vollbild, rotierend) -------------------
  const LinkShow = (() => {
    let timer = null;
    let idx = 0;
    let items = [];
    let cfg = {};
    let key = '';

    function keyOf(a) { return a.map((x) => `${x.id}:${x.url}`).join('|'); }

    function update(s, _prev, justEntered) {
      cfg = s || {};
      items = cfg.items || [];
      const newKey = keyOf(items);
      const changed = newKey !== key;
      key = newKey;
      if (changed || justEntered) {
        idx = 0;
        show();
        schedule();
      } else {
        schedule();
      }
    }

    function show() {
      const it = items[idx];
      // Vom Server als nicht-einbettbar erkannt -> Hinweis statt schwarzer Seite.
      const blocked = !!it && it.embeddable === false;
      toggle(els.linkNotice, blocked);
      if (blocked) {
        els.linkNoticeUrl.textContent = it.url;
        if (els.linkFrame.getAttribute('src') !== 'about:blank') els.linkFrame.src = 'about:blank';
        return;
      }
      const url = it ? it.url : 'about:blank';
      // Nur neu laden, wenn sich die URL ändert (vermeidet ständiges Neuladen).
      if (els.linkFrame.getAttribute('src') !== url) els.linkFrame.src = url;
    }

    function schedule() {
      clearTimeout(timer);
      if (items.length <= 1) return; // einzelner Link bleibt stehen
      timer = setTimeout(next, Math.max(3, cfg.durationSec || 15) * 1000);
    }

    function next() {
      if (!items.length) return;
      idx = (idx + 1) % items.length;
      show();
      schedule();
    }

    function stop() {
      clearTimeout(timer);
      timer = null;
      // Seite entladen, damit Audio/Video im iframe stoppt.
      if (els.linkFrame.getAttribute('src') && els.linkFrame.getAttribute('src') !== 'about:blank') {
        els.linkFrame.src = 'about:blank';
      }
    }

    return { update, stop };
  })();

  // ---- Video-Seek (Befehl aus der Live-Vorschau) --------------------------
  // Seekt das aktuell laufende Video. Da der Befehl an alle Clients geht,
  // springen Wand und Vorschau gleichzeitig -> synchron.
  function seekCurrent(time) {
    const mode = current && current.mode;
    if (mode === 'slideshow') Slideshow.seek(time);
    else if (mode === 'youtube') YT.seek(time);
  }

  // ---- Synchronisierung Wand <-> Vorschau ---------------------------------
  // Die echte Wand sendet laufend, welches Video an welcher Stelle läuft.
  function sendNowPlaying() {
    if (embedded || !ws || ws.readyState !== WebSocket.OPEN) return;
    const mode = current && current.mode;
    let np = null;
    if (mode === 'youtube') np = YT.nowPlaying();
    else if (mode === 'slideshow') np = Slideshow.nowPlaying();
    if (np) ws.send(JSON.stringify({ type: 'cmd', cmd: 'nowplaying', mode, ...np }));
  }
  // Die Vorschau springt auf die gemeldete Position der Wand.
  function applyNowPlaying(np) {
    if (np.mode !== (current && current.mode)) return;
    if (np.mode === 'youtube') YT.syncTo(np.videoId, np.time);
    else if (np.mode === 'slideshow') Slideshow.syncTo(np.mediaId, np.time);
  }
  function requestSync() {
    if (embedded && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'cmd', cmd: 'sync-request' }));
    }
  }

  if (embedded) {
    // Vorschau: aktuelle Position an die Positionsleiste der Steuerung melden
    // und bei Bedarf einen sofortigen Sync von der Wand anfordern.
    setInterval(() => {
      const mode = current && current.mode;
      let pos = null;
      if (mode === 'slideshow') pos = Slideshow.getPos();
      else if (mode === 'youtube') pos = YT.getPos();
      window.parent.postMessage({ type: 'screen-pos', mode, pos }, '*');
    }, 250);
    requestSync();
    setInterval(requestSync, 2000); // bis die Wand antwortet / bei Modeswechsel
  } else {
    // Wand: laufender Heartbeat, damit neu geöffnete Vorschauen aufspringen.
    setInterval(sendNowPlaying, 1000);
  }

  // ---- Mauszeiger nach Inaktivität ausblenden -----------------------------
  let idleTimer = null;
  function resetIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
  }
  ['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((e) =>
    window.addEventListener(e, resetIdle)
  );
  resetIdle();
})();
