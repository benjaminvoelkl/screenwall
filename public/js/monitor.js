// Live-Monitor (Startseite /). Zeigt im 18:16-Format, was gerade LIVE auf der
// Wand läuft (eingebettetes /screen?view=live), mit TV-Lautstärke und einem
// On-Air-Balken samt aktuellem Live-Modus.

(() => {
  const $ = (id) => document.getElementById(id);

  // ---- 18:16-Vorschau einbetten + maßstabsgetreu skalieren ----------------
  const PREVIEW_W = 4320, PREVIEW_H = 3840; // echte Wandfläche (18:16)
  const frame = $('monitor-frame');
  frame.src = '/screen?view=live'; // Live-Mirror (nicht Entwurf)

  function scale() {
    const stage = $('monitor-stage');
    const wrap = $('monitor-frame-wrap');
    const availW = window.innerWidth * 0.94;
    // Platz für Menü + On-Air-Streifen (oben) und Lautstärkeleiste (unten) lassen.
    const availH = window.innerHeight - 185;
    const s = Math.max(0.01, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    stage.style.width = Math.round(PREVIEW_W * s) + 'px';
    stage.style.height = Math.round(PREVIEW_H * s) + 'px';
    wrap.style.transform = `scale(${s})`;
  }
  scale();
  window.addEventListener('resize', scale);

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

  // ---- On Air / Off Air (Stopp nur per Modal + Slide) --------------------
  let offAir = false;
  function setOffAir(off) {
    offAir = !!off;
    $('onair-bar').classList.toggle('off', offAir);
    $('onair-label').textContent = offAir ? 'Off Air' : 'On Air';
    $('onair-hint').textContent = offAir ? '▸ wieder auf Sendung' : '▾ stoppen';
    $('onair-bar').title = offAir ? 'Wieder auf Sendung' : 'Sendung stoppen';
  }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/?role=control`);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state' && typeof msg.offair === 'boolean') setOffAir(msg.offair);
      } catch (_) {}
    });
    ws.addEventListener('close', () => setTimeout(connect, 1500));
    ws.addEventListener('error', () => ws.close());
  }
  connect();

  async function postOffAir(off) {
    try { await fetch('/api/offair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ off }) }); } catch (_) {}
  }

  // On-Air-Streifen: ausschalten nur über Slide-Modal; wieder anschalten direkt.
  $('onair-bar').addEventListener('click', () => {
    if (offAir) postOffAir(false);     // wieder auf Sendung (unkritisch)
    else openStop();                   // stoppen nur mit Slide-Bestätigung
  });

  // ---- Stopp-Modal + Slide-to-stop ---------------------------------------
  function openStop() { $('stop-modal').classList.remove('hidden'); resetSlide(); }
  function closeStop() { $('stop-modal').classList.add('hidden'); resetSlide(); }
  $('stop-cancel').addEventListener('click', closeStop);
  $('stop-modal').addEventListener('click', (e) => { if (e.target === $('stop-modal')) closeStop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStop(); });

  let slideX = 0, sliding = false, slideDone = false;
  function slideTravel() { return $('stop-slider').clientWidth - $('stop-handle').offsetWidth - 8; }
  function setSlide(x) {
    slideX = Math.max(0, Math.min(slideTravel(), x));
    $('stop-handle').style.transform = `translateX(${slideX}px)`;
    $('stop-fill').style.width = `${slideX + $('stop-handle').offsetWidth}px`;
  }
  function resetSlide() { slideDone = false; sliding = false; $('stop-handle').style.transition = ''; setSlide(0); }
  async function fireStop() {
    if (slideDone) return;
    slideDone = true; setSlide(slideTravel());
    await postOffAir(true);
    closeStop();
  }
  (function bindSlide() {
    const handle = $('stop-handle');
    let startX = 0, startSlide = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (slideDone) return;
      sliding = true; startX = e.clientX; startSlide = slideX;
      handle.style.transition = 'none'; handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => { if (sliding) setSlide(startSlide + (e.clientX - startX)); });
    const end = () => {
      if (!sliding) return;
      sliding = false; handle.style.transition = 'transform 0.2s ease';
      if (slideX >= slideTravel() * 0.95) fireStop(); else setSlide(0);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  })();
})();
