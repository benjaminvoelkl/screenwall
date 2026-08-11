// Live-Monitor (Startseite /). Zeigt im 18:16-Format, was gerade LIVE auf der
// Wand läuft (eingebettetes /screen?view=live), mit TV-Lautstärke und einem
// On-Air-Balken samt aktuellem Live-Modus.
//
// Navigation, Lautstärke, Dialog und Slide-to-confirm kommen aus ui.js.

(() => {
  const U = window.UI;
  const { $ } = U;

  U.topbarNav('monitor');
  U.bindVolume();

  // ---- 18:16-Vorschau einbetten + maßstabsgetreu skalieren ----------------
  const PREVIEW_W = 4320, PREVIEW_H = 3840; // echte Wandfläche (18:16)
  $('monitor-frame').src = '/screen?view=live'; // Live-Mirror (nicht Entwurf)

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

  // ---- On Air / Off Air ---------------------------------------------------
  let offAir = false;
  function setOffAir(off) {
    offAir = !!off;
    const bar = $('onair-bar');
    bar.classList.toggle('off', offAir);
    $('onair-label').textContent = offAir ? 'Off Air' : 'On Air';
    $('onair-hint').textContent = offAir ? '▸ wieder auf Sendung' : '▾ stoppen';
    bar.title = offAir ? 'Wieder auf Sendung' : 'Sendung stoppen';
    bar.setAttribute('aria-label', bar.title);
  }
  U.connectState({ onOffair: setOffAir });

  const postOffAir = (off) => U.api('POST', '/api/offair', { off }).catch(() => {});

  // Ausschalten nur über die Slide-Bestätigung; wieder anschalten direkt.
  $('onair-bar').addEventListener('click', () => {
    if (offAir) postOffAir(false).then(() => U.toast('Wieder auf Sendung'));
    else openStop();
  });

  // ---- Stopp-Bestätigung: Slide-to-stop ----------------------------------
  // Verhindert versehentliches Stoppen; rote Variante des gemeinsamen Sliders.
  function openStop() {
    const body = U.el('div');
    body.appendChild(U.el('p', 'modal-hint',
      'Die Wand wird schwarz. Zum Bestätigen den Regler ganz nach rechts schieben. '
      + 'Wieder auf Sendung geht über „Go Live" auf der Programm-Timeline oder erneut hier.'));
    const slider = U.buildSlide({ label: 'Zum Stoppen schieben →', glyph: '■', danger: true });
    body.appendChild(slider);

    const h = U.dialog({
      title: 'Sendung komplett stoppen?',
      body,
      actions: [{ label: 'Abbrechen', cls: 'ghost', onClick: (hh) => hh.close() }]
    });
    U.bindSlide(slider, async (reset) => {
      try {
        await U.api('POST', '/api/offair', { off: true });
        U.toast('Sendung gestoppt – die Wand ist schwarz');
        h.close();
      } catch (_) { reset(); }
    });
  }
})();
