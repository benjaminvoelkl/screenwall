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
})();
