// Anzeige-Logik für /screen.
// Holt den Zustand per WebSocket, reagiert live und rendert je Modus.
// Bei Verbindungsabbruch wird automatisch neu verbunden.

(() => {
  const els = {
    offline: document.getElementById('offline'),
    welcome: document.getElementById('welcome'),
    welcomeText: document.getElementById('welcome-text'),
    slideshow: document.getElementById('slideshow'),
    youtube: document.getElementById('youtube')
  };

  let current = null; // letzter Zustand

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
    toggle(els.welcome, mode === 'welcome');
    toggle(els.slideshow, mode === 'slideshow');
    toggle(els.youtube, mode === 'youtube');

    if (mode === 'welcome') renderWelcome(state.welcome);
    if (mode === 'slideshow') Slideshow.update(state.slideshow, prev?.slideshow, prev?.mode !== 'slideshow');
    else Slideshow.stop();

    if (mode === 'youtube') YT.update(state.youtube, prev?.youtube, prev?.mode !== 'youtube');
    else YT.stop();
  }

  function toggle(el, on) { el.classList.toggle('hidden', !on); }

  // ---- Modus 3: Willkommen ------------------------------------------------
  function renderWelcome(w) {
    els.welcome.classList.remove('tpl-elegant', 'tpl-modern', 'tpl-festive');
    els.welcome.classList.add(`tpl-${w.template || 'elegant'}`);
    els.welcomeText.textContent = w.text || '';
    els.welcomeText.style.fontSize = `${w.fontSize || 8}vw`;
    els.welcome.classList.toggle('fade-out', w.visible === false);
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

    return { update, stop };
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
        load();
        started = true;
      }
    }

    function load() {
      const v = videos[idx];
      if (!v) return;
      try { player.loadVideoById(v.videoId); } catch (_) {}
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

    return { update, stop };
  })();

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
