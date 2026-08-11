// Programm-Timeline (/programm). Zeigt das Programm (ausgeflachte Start-Playlist)
// wie in einem Videoschnitt-Programm: Zeitstrahl + parallele Spuren für Content,
// Musik (Platzhalter) und Overlay. Scrubben am Zeitstrahl steuert per WebSocket
// die eingebettete /screen-Vorschau (cmd:'goto'); "Preview & Go Live" startet die
// Vorschau ab dem Playhead-Punkt und veröffentlicht den Entwurf.
//
// Gemeinsame Bausteine kommen aus ui.js (UI.*) und content.js (CT.*): Dialoge statt
// prompt/confirm, Toasts statt stillem Speichern, ein Content-Typ-Register.

(() => {
  const { $, fmtClock } = window.UI;
  const U = window.UI;

  let state = null;
  let liveNowPlaying = null;          // Was läuft gerade live auf der Wand?
  let seq = [];                       // ausgeflachte Content-Liste [{itemId, content}]
  let blocks = [];                    // Layout [{itemId, content, start, dur, x, w}]
  let total = 0;                      // Gesamtdauer in Sekunden
  let pxPerSec = 12;
  let playheadT = 0;                  // Playhead-Position in Sekunden
  let mode = 'live';                  // 'live' = Wand spiegeln | 'draft' = Entwurf-Vorschau
  let liveProg = { t: 0, ts: 0 };     // letzter Programmzeit-Stand der Wand (für Live-Playhead)
  const measured = {};                // itemId -> gemessene Dauer (für "bis Ende"-Videos)

  // ---- Navigation, Entwurfs-Leiste, Lautstärke (gemeinsame Bausteine) -----
  U.topbarNav('programm');
  U.bindVolume();
  // Auf dieser Seite liegt die Veröffentlichungs-Vorschau selbst – die Leiste
  // öffnet daher direkt das Go-Live-Modal statt zu navigieren.
  const draft = U.draftBar({ onPublish: () => openGoLive() });

  // ---- API/WS -------------------------------------------------------------
  const conn = U.connectState({
    onConn: U.bindConnDot(),
    onDirty: (dirty) => setDirty(dirty),
    onState: (s) => { state = s; render(); },
    onCmd: (msg) => {
      if (msg.cmd !== 'nowplaying') return;
      liveNowPlaying = msg;
      if (typeof msg.progTime === 'number') liveProg = { t: msg.progTime, ts: performance.now() };
      applyLiveNow();
      updateLiveMarker();
    }
  });
  const wsSend = (obj) => conn.send(obj);
  U.api('GET', '/api/state', undefined, { quiet: true }).then((s) => { state = s; render(); }).catch(() => {});
  // Echte Video-/YouTube-Längen serverseitig nachtragen, damit die Timeline korrekt
  // layoutet (ohne sie laufen ~30 s Nominaldauer pro Block). Der folgende state-
  // Broadcast rendert die Timeline mit den echten Dauern neu.
  U.api('POST', '/api/probe-durations', undefined, { quiet: true }).catch(() => {});

  // ---- Vorschau-Modus: Live-Spiegel (Wand) <-> Entwurf-Vorschau -----------
  // Standard = Live-Spiegel (Sicht 'monitor', /screen?view=live): zeigt die echte
  // Wand und bleibt nach F5 synchron. Beim Scrubben/Bearbeiten wechselt die
  // Vorschau in den Entwurf-Modus (Sicht 'preview'). Initialisierung am Dateiende.

  // Im Entwurf-Modus meldet die Vorschau laufend ihre Position (itemId + Zeit) und
  // der Playhead folgt; im Live-Modus folgt der Playhead der Wand (nowplaying).
  let scrubbing = false;
  let zooming = false;   // während Zoom selbst scrollen wir verankert
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'screen-pos' || !d.itemId) return;
    const t = d.pos ? d.pos.time || 0 : 0;
    const dur = d.pos ? d.pos.duration || 0 : 0;
    const b = blocks.find((x) => x.itemId === d.itemId);
    if (!b) return;
    // Play/Pause-Zustand der Vorschau übernehmen, damit Button & Playhead stimmen.
    if (mode === 'draft' && typeof d.paused === 'boolean') syncPlaying(!d.paused);
    const c = b.content;
    // Gemessene Dauer nur übernehmen, wenn die echte Länge NICHT bekannt ist
    // (videoDuration kommt jetzt vom Server) und gerade NICHT gescrubbt wird – sonst
    // würde ein Re-Layout während des Ziehens die Timeline verschieben/umskalieren.
    if (dur > 0 && !scrubbing && !(c.videoDuration > 0)
        && (c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration'
        && Math.abs((measured[d.itemId] || 0) - dur) > 0.5) {
      measured[d.itemId] = dur; render(); return;
    }
    // Bei Pause die rote Linie einfrieren (kein Fortschreiben aus pos.time).
    if (!scrubbing && !d.paused) { playheadT = Math.min(total, b.start + t); positionPlayhead(); }
  });

  // ===== Ausflachen / Dauern (aus content.js – identisch mit /playlists) ====
  const flatten = (plId, byId, visited) => window.CT.flatten(plId, byId, visited);
  // Echte (vom Server geprobte) Länge bevorzugen – stabil, kein Re-Layout beim
  // Scrubben. `measured` ist nur die Rückfallebene aus der Live-Messung.
  const blockDur = (itemId, c) => window.CT.blockDur(itemId, c, measured);

  // ===== Rendering =========================================================
  // Ebenen-/Layer-Icon (gestapelte Ebenen) für die Overlay-Spur.
  const LAYERS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 16l10 5 10-5"/></svg>';

  // Zoom: Slider 0 = max. Detail, 100 = "Alles" (komplette Timeline passt in die
  // sichtbare Breite). Fit-Wert ergibt sich aus Gesamtdauer und Containerbreite.
  const MAX_DETAIL_PX = 60;
  function fitPxPerSec() {
    const avail = $('tl-scroll').clientWidth - 8;
    // Untergrenze nur gegen 0/negativ – sonst würde der Floor lange Timelines
    // (z. B. ~220 min) am Einpassen hindern und "Alles" zeigte nur einen Ausschnitt.
    return total > 0 ? Math.max(0.01, avail / total) : MAX_DETAIL_PX;
  }
  function zoomPxPerSec() {
    const v = Number($('tl-zoom').value);
    const fit = fitPxPerSec();
    const detail = Math.max(fit, MAX_DETAIL_PX);
    // Geometrisch interpolieren: gleichmäßiges Zoomgefühl von Fit (v=100) bis Detail (v=0).
    return fit * Math.pow(detail / fit, (100 - v) / 100);
  }

  function render() {
    if (!state || !state.playlists) return;

    const pls = state.playlists;
    const root = pls.byId[pls.rootId];
    $('tl-title').textContent = root ? `Playlist: ${root.name}` : 'Playlist';
    seq = root ? flatten(pls.rootId, pls.byId, new Set()) : [];

    // 1) Dauern + Gesamtdauer (unabhängig vom Zoom).
    const durs = seq.map((e) => blockDur(e.itemId, e.content));
    total = durs.reduce((a, b) => a + b, 0);

    const empty = seq.length === 0;
    $('prog-empty').classList.toggle('hidden', !empty);
    $('tl-grid').classList.toggle('hidden', empty);
    $('tl-total').textContent = `Gesamt: ${fmtClock(total)}`;
    // Chips & Highlights auch ohne Inhalte zeichnen (Highlights sind global).
    renderChapterChips();
    renderHighlights();
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
    renderChapterLane();
    renderOverlayLanes();
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
      else if (c.type === 'youtube') {
        // Standbild als Fallback; sobald das Storyboard geladen ist, Filmstreifen drüber.
        el.style.backgroundImage = `url('https://i.ytimg.com/vi/${c.videoId}/mqdefault.jpg')`;
        const sb = ytStoryboard(c.videoId);
        if (sb) el.appendChild(buildYtFilmstrip(sb, b.dur, pxPerSec));
      } else if (c.type === 'video' && c.filename) el.appendChild(buildFilmstrip(c.filename, b.dur, pxPerSec));
      if ((c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration') el.classList.add('end-video');

      const badge = document.createElement('span');
      badge.className = 'tl-b-type'; badge.textContent = window.CT.badge(c.type);
      badge.title = window.CT.label(c.type);
      el.appendChild(badge);

      const label = document.createElement('div');
      label.className = 'tl-b-label';
      label.textContent = c.name || c.url || c.videoId || window.CT.label(c.type);
      el.appendChild(label);

      const dur = document.createElement('div');
      dur.className = 'tl-b-dur';
      const isEnd = (c.type === 'video' || c.type === 'youtube') && c.videoMode !== 'duration';
      const known = measured[b.itemId] || c.videoDuration;
      dur.textContent = isEnd
        ? (known ? fmtClock(b.dur) : '≈ bis Ende')
        : fmtClock(b.dur);
      el.appendChild(dur);

      lane.appendChild(el);
    }
  }

  // Filmstreifen: Keyframe-Dichte folgt dem Zoom (siehe content.js). Die Timeline
  // nutzt größere Kacheln als das Storyboard auf /playlists – daher die Optionen.
  const FS_OPT = { stripCls: 'tl-filmstrip', frameCls: 'tl-frame', thumbPx: 110, maxFrames: 60 };
  const YT_OPT = { ...FS_OPT, frameCls: 'tl-frame tl-sb' };
  const buildFilmstrip = (filename, dur, pps) => window.CT.buildFilmstrip(filename, dur, pps, FS_OPT);
  const buildYtFilmstrip = (sb, dur, pps) => window.CT.buildYtFilmstrip(sb, dur, pps, YT_OPT);
  // Sobald das Storyboard geladen ist, neu zeichnen (Filmstreifen statt Standbild).
  const ytStoryboard = (videoId) => window.CT.ytStoryboard(videoId, render);

  // Overlay-Spuren der AKTUELLEN (Root-)Playlist: ein Overlay ist wiederverwendbarer
  // Inhalt; seine Anzeigefenster liegen als Clips an der Playlist (mehrere je Overlay).
  // Jeder Clip ist verschiebbar (start), trimmbar (duration), ein-/ausblendbar, löschbar
  // und öffnet per Klick den Overlay-Editor.
  const el2 = (t, c) => { const n = document.createElement(t); if (c) n.className = c; return n; };
  const rootPlaylist = () => state.playlists.byId[state.playlists.rootId];
  // Speichern quittiert sichtbar (gebündelt, damit ein Ziehen EINEN Toast auslöst)
  // und meldet Serverfehler, statt sie zu verschlucken.
  const clipsUrl = () => `/api/playlist/${state.playlists.rootId}/overlay-clips`;
  function apiPatchClip(clipId, fields) {
    return U.save('PATCH', `${clipsUrl()}/${clipId}`, fields).catch(() => {});
  }
  function apiDeleteClip(clipId) {
    return U.save('DELETE', `${clipsUrl()}/${clipId}`).catch(() => {});
  }
  function apiAddClip(overlayId, start) {
    return U.save('POST', clipsUrl(), { overlayId, start: Math.max(0, start || 0), duration: null });
  }
  function renderOverlayLanes() {
    const gut = $('ov-gutter'), lanes = $('ov-lanes');
    gut.innerHTML = ''; lanes.innerHTML = '';
    const pl = rootPlaylist();
    const clips = (pl && pl.overlayClips) || [];
    // Clips nach Overlay gruppieren (Reihenfolge wie state.overlays).
    const groups = [];
    for (const o of (state.overlays || [])) { const cs = clips.filter((c) => c.overlayId === o.id); if (cs.length) groups.push({ o, clips: cs }); }
    if (!groups.length) {
      const gl = el2('div', 'tl-gutter-label'); gl.innerHTML = `<span class="ic" aria-hidden="true">${LAYERS_ICON}</span> Overlay`;
      gut.appendChild(gl);
      const lane = el2('div', 'tl-lane empty'); lane.textContent = 'Keine Overlay-Fenster – über „+ Einfügen" anlegen';
      lanes.appendChild(lane);
      return;
    }
    for (const g of groups) {
      const gl = el2('div', 'tl-gutter-label');
      const ic = el2('span', 'ic'); ic.innerHTML = LAYERS_ICON; ic.setAttribute('aria-hidden', 'true');
      const nm = el2('span'); nm.textContent = g.o.name; nm.style.cssText = 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      // Spurgebundenes Einfügen: fügt ein Fenster GENAU dieses Overlays ein und ist
      // damit eine andere Handlung als das allgemeine "+ Einfügen"-Menü.
      const add = U.iconBtn('＋', `Weiteres Fenster von „${g.o.name}" am Playhead einfügen`, 'tl-ov-eye',
        () => apiAddClip(g.o.id, playheadT));
      gl.append(ic, nm, add);
      gut.appendChild(gl);
      const lane = el2('div', 'tl-lane');
      for (const c of g.clips) lane.appendChild(buildOverlayClip(c, g.o));
      lanes.appendChild(lane);
    }
  }

  let suppressClick = false;
  function buildOverlayClip(c, o) {
    const start = c.start || 0;
    const end = c.duration == null ? total : Math.min(total, start + c.duration);
    const clip = el2('div', 'tl-ov-clip' + (c.enabled ? '' : ' disabled'));
    clip.style.left = start * pxPerSec + 'px';
    clip.style.width = Math.max(10, (end - start) * pxPerSec) + 'px';

    const lh = el2('div', 'tl-ov-handle l'), rh = el2('div', 'tl-ov-handle r');
    const label = el2('span', 'tl-ov-label');
    label.textContent = o.name + (c.duration == null ? ' · immer' : '');
    const eye = U.iconBtn(c.enabled ? '👁' : '🚫',
      c.enabled ? `„${o.name}" ausblenden` : `„${o.name}" einblenden`, 'tl-ov-eye',
      (e) => { e.stopPropagation(); apiPatchClip(c.id, { enabled: !c.enabled }); });
    eye.addEventListener('pointerdown', (e) => e.stopPropagation());
    const del = U.iconBtn('🗑', `Fenster von „${o.name}" entfernen`, 'tl-ov-eye', async (e) => {
      e.stopPropagation();
      const ok = await U.confirmDialog({
        title: 'Overlay-Fenster entfernen?',
        text: `Das Anzeigefenster von „${o.name}" wird aus dieser Playlist entfernt. Das Overlay selbst bleibt erhalten.`,
        confirmLabel: 'Entfernen', danger: true
      });
      if (ok) apiDeleteClip(c.id);
    });
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    clip.append(lh, label, eye, del, rh);

    bindClipDrag(clip, c);
    bindTrim(lh, c, 'l'); bindTrim(rh, c, 'r');
    clip.addEventListener('click', () => { if (!suppressClick) location.href = '/overlay?overlay=' + o.id; });
    clip.title = `Ziehen = verschieben · Ränder = Länge · Klick öffnet den Overlay-Editor`;
    return clip;
  }

  const timeAtX = (clientX) => (clientX - $('tl-tracks').getBoundingClientRect().left) / pxPerSec;
  function bindClipDrag(clip, c) {
    clip.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('tl-ov-handle')) return; // Trimmen separat
      e.stopPropagation();
      clip.setPointerCapture(e.pointerId);
      const sx = e.clientX, orig = c.start || 0; let moved = false;
      const move = (m) => {
        const dx = (m.clientX - sx) / pxPerSec;
        if (Math.abs(m.clientX - sx) > 3) moved = true;
        const span = c.duration == null ? 0 : c.duration;
        c.start = Math.max(0, Math.min(Math.max(0, total - span), orig + dx));
        const end = c.duration == null ? total : Math.min(total, c.start + c.duration);
        clip.style.left = c.start * pxPerSec + 'px';
        clip.style.width = Math.max(10, (end - c.start) * pxPerSec) + 'px';
      };
      const up = () => {
        clip.removeEventListener('pointermove', move); clip.removeEventListener('pointerup', up);
        if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); apiPatchClip(c.id, { start: c.start }); }
      };
      clip.addEventListener('pointermove', move); clip.addEventListener('pointerup', up);
    });
  }
  function bindTrim(handle, c, side) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const clip = handle.parentElement;
      const end0 = c.duration == null ? total : (c.start || 0) + c.duration;
      const move = (m) => {
        const t = Math.max(0, Math.min(total, timeAtX(m.clientX)));
        if (side === 'r') {
          c.duration = Math.max(0.5, t - (c.start || 0));
        } else {
          const ns = Math.max(0, Math.min(end0 - 0.5, t));
          c.duration = end0 - ns; c.start = ns;
        }
        const s = c.start || 0, en = s + c.duration;
        clip.style.left = s * pxPerSec + 'px';
        clip.style.width = Math.max(10, (en - s) * pxPerSec) + 'px';
      };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
        apiPatchClip(c.id, { start: c.start || 0, duration: c.duration });
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    });
  }

  // ===== Kapitel (benannte Bereiche; schnelles Springen) ===================
  function chaptersOf(pl) { return (pl && pl.chapters) || []; }
  const chaptersUrl = () => `/api/playlist/${state.playlists.rootId}/chapters`;
  function apiPatchChapter(id, fields) {
    return U.save('PATCH', `${chaptersUrl()}/${id}`, fields).catch(() => {});
  }
  function apiDeleteChapter(id) {
    return U.save('DELETE', `${chaptersUrl()}/${id}`).catch(() => {});
  }
  // Live-Sprung: wirkt SOFORT auf der Wand (kein Entwurf, kein Go Live nötig).
  async function jumpChapterLive(chapter) {
    try {
      await U.api('POST', '/api/play', { playlistId: state.playlists.rootId, chapterId: chapter.id });
      U.toast(`Live: ${chapter.name}`);
    } catch (_) {}
  }
  // Kapitel am Playhead anlegen – mit Farbe, die vorher nur per API setzbar war.
  async function addChapterHere() {
    const res = await U.promptDialog({
      title: `Kapitel bei ${fmtClock(playheadT)} anlegen`,
      label: 'Name des Kapitels',
      value: `Kapitel ${fmtClock(playheadT)}`,
      confirmLabel: 'Anlegen',
      extraFields: [{ key: 'color', label: 'Farbe', input: U.colorInput('#4f8cff') }]
    });
    if (!res) return;
    await U.save('POST', chaptersUrl(), {
      name: res.value || 'Kapitel', start: Math.round(playheadT), color: res.color
    }).catch(() => {});
  }
  async function renameChapter(c) {
    const res = await U.promptDialog({
      title: 'Kapitel bearbeiten',
      label: 'Name des Kapitels',
      value: c.name,
      extraFields: [{ key: 'color', label: 'Farbe', input: U.colorInput(c.color || '#4f8cff') }]
    });
    if (!res) return;
    apiPatchChapter(c.id, { name: res.value || 'Kapitel', color: res.color });
  }
  async function deleteChapter(c) {
    // Vorher wurde ein Kapitel ohne Rückfrage gelöscht, ein Highlight aber mit.
    const ok = await U.confirmDialog({
      title: 'Kapitel löschen?',
      text: `„${c.name}" wird aus der Playlist entfernt. Die Inhalte selbst bleiben unverändert.`,
      confirmLabel: 'Löschen', danger: true
    });
    if (ok) apiDeleteChapter(c.id);
  }

  function renderChapterLane() {
    const lane = $('lane-chapters');
    lane.innerHTML = '';
    const chs = chaptersOf(rootPlaylist());
    if (!chs.length) { lane.classList.add('empty'); lane.textContent = 'Keine Kapitel – über „+ Einfügen" am Playhead anlegen'; return; }
    lane.classList.remove('empty');
    for (let i = 0; i < chs.length; i++) {
      const c = chs[i], next = chs[i + 1];
      // Ende: feste Dauer, sonst bis zum nächsten Kapitel bzw. Programmende.
      const end = c.duration != null ? Math.min(total, (c.start || 0) + c.duration) : (next ? next.start : total);
      lane.appendChild(buildChapterSeg(c, end));
    }
  }
  function buildChapterSeg(c, end) {
    const start = c.start || 0;
    const seg = el2('div', 'tl-chapter');
    seg.style.left = start * pxPerSec + 'px';
    seg.style.width = Math.max(10, (end - start) * pxPerSec) + 'px';
    seg.style.setProperty('--chap-color', c.color || '#4f8cff');
    const lh = el2('div', 'tl-ov-handle l'), rh = el2('div', 'tl-ov-handle r');
    const label = el2('span', 'tl-ov-label'); label.textContent = c.name;
    // Der Live-Sprung braucht eine EIGENE Schaltfläche: ein Klick auf das Segment
    // scrubbt nur die Vorschau. Vorher bedeutete derselbe Klick auf dem Chip oben
    // "sofort live" und hier "nur Vorschau" – ohne jeden Hinweis.
    const live = U.iconBtn('▶', `„${c.name}" sofort live auf die Wand`, 'tl-ov-eye live',
      (e) => { e.stopPropagation(); jumpChapterLive(c); });
    live.addEventListener('pointerdown', (e) => e.stopPropagation());
    const ren = U.iconBtn('✏', `„${c.name}" bearbeiten`, 'tl-ov-eye',
      (e) => { e.stopPropagation(); renameChapter(c); });
    ren.addEventListener('pointerdown', (e) => e.stopPropagation());
    const del = U.iconBtn('🗑', `„${c.name}" löschen`, 'tl-ov-eye',
      (e) => { e.stopPropagation(); deleteChapter(c); });
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    seg.append(lh, label, live, ren, del, rh);
    bindChapterDrag(seg, c);
    bindChapterTrim(lh, c, 'l'); bindChapterTrim(rh, c, 'r');
    // Klick im Editor = Vorschau an den Anfang scrubben (Wand bleibt unangetastet).
    seg.addEventListener('click', () => { if (!suppressClick) scrubTo(c.start || 0); });
    seg.title = `Klick = Vorschau an den Anfang · ▶ = sofort live · Ziehen = verschieben`;
    return seg;
  }
  function bindChapterDrag(seg, c) {
    seg.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('tl-ov-handle')) return;
      e.stopPropagation();
      seg.setPointerCapture(e.pointerId);
      const sx = e.clientX, orig = c.start || 0; let moved = false;
      const move = (m) => {
        if (Math.abs(m.clientX - sx) > 3) moved = true;
        seg._ns = Math.max(0, Math.min(total, orig + (m.clientX - sx) / pxPerSec));
        seg.style.left = seg._ns * pxPerSec + 'px';
      };
      const up = () => {
        seg.removeEventListener('pointermove', move); seg.removeEventListener('pointerup', up);
        if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 50); apiPatchChapter(c.id, { start: Math.round(seg._ns) }); }
      };
      seg.addEventListener('pointermove', move); seg.addEventListener('pointerup', up);
    });
  }
  function bindChapterTrim(handle, c, side) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const seg = handle.parentElement;
      const start0 = c.start || 0;
      const end0 = start0 + (seg.offsetWidth / pxPerSec); // aktuelles Ende (auch bei null-Dauer)
      const move = (m) => {
        const t = Math.max(0, Math.min(total, timeAtX(m.clientX)));
        let s = start0, en = end0;
        if (side === 'r') en = Math.max(s + 0.5, t); else s = Math.min(end0 - 0.5, t);
        seg.style.left = s * pxPerSec + 'px';
        seg.style.width = Math.max(10, (en - s) * pxPerSec) + 'px';
        seg._s = s; seg._dur = en - s;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up);
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 50);
        apiPatchChapter(c.id, { start: Math.round(seg._s != null ? seg._s : start0), duration: Math.round(seg._dur != null ? seg._dur : (end0 - start0)) });
      };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    });
  }
  function renderChapterChips() {
    const bar = $('chapter-chips');
    bar.innerHTML = '';
    const chs = chaptersOf(rootPlaylist());
    bar.classList.toggle('hidden', !chs.length);
    for (const c of chs) {
      const chip = el2('button', 'chapter-chip');
      chip.type = 'button';
      chip.style.setProperty('--chap-color', c.color || '#4f8cff');
      const dot = el2('span', 'chip-dot');
      const nm = el2('span'); nm.textContent = c.name;
      const tm = el2('span', 'chip-time'); tm.textContent = fmtClock(c.start || 0);
      // Sichtbares Zeichen, dass dieser Klick SOFORT auf der Wand wirkt.
      const go = el2('span', 'chip-live'); go.textContent = '▶ live'; go.setAttribute('aria-hidden', 'true');
      chip.append(dot, nm, tm, go);
      chip.title = `„${c.name}" sofort live auf die Wand springen`;
      chip.setAttribute('aria-label', `${c.name} bei ${fmtClock(c.start || 0)} – sofort live auf die Wand springen`);
      chip.addEventListener('click', () => jumpChapterLive(c));
      bar.appendChild(chip);
    }
  }

  // ===== Highlights (kuratierte, playlist-übergreifende Schnellzugriffe) ====
  async function jumpHighlightLive(h) {
    try {
      await U.api('POST', '/api/play', { highlightId: h.id });
      U.toast(`Live: ${h.name}`);
    } catch (_) {}
  }
  const apiPatchHighlight = (id, fields) => U.save('PATCH', `/api/highlights/${id}`, fields).catch(() => {});
  const apiDeleteHighlight = (id) => U.save('DELETE', `/api/highlights/${id}`).catch(() => {});
  function moveHighlight(idx, dir) {
    const ids = (state.highlights || []).map((h) => h.id);
    const j = idx + dir; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    U.save('POST', '/api/highlights/order', { order: ids }).catch(() => {});
  }
  async function addHighlightHere() {
    const res = await U.promptDialog({
      title: `Highlight bei ${fmtClock(playheadT)} speichern`,
      label: 'Name des Highlights',
      value: `Highlight ${fmtClock(playheadT)}`,
      confirmLabel: 'Speichern'
    });
    if (!res) return;
    await U.save('POST', '/api/highlights', {
      name: res.value || 'Highlight', playlistId: state.playlists.rootId, start: Math.round(playheadT)
    }).catch(() => {});
  }
  async function renameHighlight(h) {
    const res = await U.promptDialog({ title: 'Highlight umbenennen', label: 'Name', value: h.name });
    if (res) apiPatchHighlight(h.id, { name: res.value || 'Highlight' });
  }
  async function deleteHighlight(h) {
    const ok = await U.confirmDialog({
      title: 'Highlight löschen?',
      text: `Der Schnellzugriff „${h.name}" wird entfernt. Die Playlist und ihre Inhalte bleiben unverändert.`,
      confirmLabel: 'Löschen', danger: true
    });
    if (ok) apiDeleteHighlight(h.id);
  }
  function renderHighlights() {
    const list = $('highlights-list');
    if (!list) return;
    list.innerHTML = '';
    const hls = state.highlights || [];
    if (!hls.length) {
      const hint = el2('span', 'hint'); hint.style.margin = '0';
      hint.textContent = 'Noch keine Highlights – über „+ Einfügen" die aktuelle Position speichern.';
      list.appendChild(hint); return;
    }
    const byId = state.playlists.byId;
    hls.forEach((h, idx) => {
      const card = el2('div', 'hl-card');
      card.style.setProperty('--hl-color', h.color || 'var(--start)');
      const jump = el2('button', 'hl-btn');
      jump.type = 'button';
      const nm = el2('span', 'hl-name'); nm.textContent = h.name;
      const meta = el2('span', 'hl-meta'); meta.textContent = `${byId[h.playlistId] ? byId[h.playlistId].name : '??'} · ${fmtClock(h.start || 0)}`;
      jump.append(nm, meta);
      jump.title = `„${h.name}" sofort live auf die Wand springen`;
      jump.setAttribute('aria-label', jump.title);
      jump.addEventListener('click', () => jumpHighlightLive(h));

      // Reihenfolge bleibt sichtbar (häufig genutzt); Umbenennen/Löschen wandern
      // ins ⋯-Menü – dieselbe Systematik wie bei den Playlist-Karten.
      const ctr = el2('div', 'hl-ctrls');
      const up = U.iconBtn('↑', `„${h.name}" nach vorn`, 'hl-mini', () => moveHighlight(idx, -1));
      up.disabled = idx === 0;
      const down = U.iconBtn('↓', `„${h.name}" nach hinten`, 'hl-mini', () => moveHighlight(idx, 1));
      down.disabled = idx === hls.length - 1;
      ctr.append(up, down);
      const more = U.overflowMenu([
        { label: '✏ Umbenennen', onClick: () => renameHighlight(h) },
        { label: '🗑 Löschen', danger: true, onClick: () => deleteHighlight(h) }
      ], { label: `Weitere Aktionen für „${h.name}"`, btnCls: 'hl-mini' });
      ctr.appendChild(more);
      card.append(jump, ctr);
      list.appendChild(card);
    });
  }

  function positionPlayhead() {
    const px = playheadT * pxPerSec;
    $('tl-playhead').style.left = px + 'px';
    $('tl-prog-scrub').style.width = Math.max(0, px) + 'px'; // grauer Fortschritt bis zum Scrubhead
    $('prog-clock').textContent = `${fmtClock(playheadT)} / ${fmtClock(total)}`;
    // Playhead im Sichtbereich halten (außer beim Scrubben/Zoomen, die scrollen selbst).
    if (!scrubbing && !zooming) {
      const sc = $('tl-scroll');
      if (px < sc.scrollLeft + 30 || px > sc.scrollLeft + sc.clientWidth - 30) {
        sc.scrollLeft = Math.max(0, px - sc.clientWidth / 2);
      }
    }
    updateLiveMarker();
  }

  // Aktuelle Live-Programmzeit der Wand (lokal interpoliert), oder null wenn unbekannt.
  function liveProgTime() {
    if (!liveProg.ts) return null;
    return Math.min(total, liveProg.t + (performance.now() - liveProg.ts) / 1000);
  }
  // Roter Live-Marker + roter Fortschritt: läuft an der echten Wand-Position immer
  // mit, unabhängig davon, wohin der (graue) Scrubhead gerade gezogen wurde.
  function updateLiveMarker() {
    const head = $('tl-livehead'), fill = $('tl-prog-live');
    if (!head || !fill) return;
    const lt = liveProgTime();
    if (lt == null) { head.classList.add('hidden'); fill.classList.add('hidden'); return; }
    head.classList.remove('hidden'); fill.classList.remove('hidden');
    const px = lt * pxPerSec;
    head.style.left = px + 'px';
    fill.style.width = Math.max(0, px) + 'px';
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
    if (e) wsSend({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset, progTime: T });
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
      if (mode === 'live') setPreviewMode('draft'); // Scrubben = Entwurf-Vorschau
      scrubbing = true; tracks.setPointerCapture(e.pointerId);
      scrubTo(timeAt(e.clientX));
    });
    tracks.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(timeAt(e.clientX), { throttle: true }); });
    const end = () => { if (!scrubbing) return; scrubbing = false; sendGoto(playheadT); };
    tracks.addEventListener('pointerup', end);
    tracks.addEventListener('pointercancel', end);
  })();

  // Zoomen verankert: Die Zeit unter dem Anker (Cursor/Pinch-Mitte, sonst
  // Viewport-Mitte) bleibt nach dem Render an Ort und Stelle.
  function applyZoom(anchorClientX) {
    const sc = $('tl-scroll');
    const rect = sc.getBoundingClientRect();
    const ax = (anchorClientX != null) ? (anchorClientX - rect.left) : sc.clientWidth / 2;
    const anchorT = pxPerSec > 0 ? (sc.scrollLeft + ax) / pxPerSec : 0;
    zooming = true;
    render();
    sc.scrollLeft = Math.max(0, anchorT * pxPerSec - ax);
    zooming = false;
  }
  // Direkt auf eine Ziel-pxPerSec zoomen (Wheel/Pinch): clampen + Slider-Formel
  // invertieren, damit der Regler synchron bleibt.
  function setZoomByPps(targetPps, anchorClientX) {
    const fit = fitPxPerSec();
    const detail = Math.max(fit, MAX_DETAIL_PX);
    const pps = Math.max(fit, Math.min(detail, targetPps));
    const v = detail > fit ? 100 - 100 * Math.log(pps / fit) / Math.log(detail / fit) : 100;
    $('tl-zoom').value = String(Math.max(0, Math.min(100, Math.round(v))));
    applyZoom(anchorClientX);
  }
  $('tl-zoom').addEventListener('input', () => applyZoom());

  // Mausrad/Trackpad über dem Scrubboard zoomt am Cursor (statt zu scrollen).
  $('tl-scroll').addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoomByPps(pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87), e.clientX);
  }, { passive: false });

  // Zwei-Finger-Pinch (Touch) zoomt; ein Finger bleibt Scrubben.
  const pinchPts = new Map();
  let pinch = null; // { startDist, startPps }
  const sc0 = $('tl-scroll');
  sc0.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pinchPts.set(e.pointerId, e);
    if (pinchPts.size === 2) {
      scrubbing = false; // laufendes Scrubben abbrechen
      const [a, b] = [...pinchPts.values()];
      pinch = { startDist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, startPps: pxPerSec };
    }
  });
  sc0.addEventListener('pointermove', (e) => {
    if (!pinchPts.has(e.pointerId)) return;
    pinchPts.set(e.pointerId, e);
    if (pinch && pinchPts.size === 2) {
      e.preventDefault();
      const [a, b] = [...pinchPts.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      const midX = (a.clientX + b.clientX) / 2;
      setZoomByPps(pinch.startPps * (dist / pinch.startDist), midX);
    }
  }, { passive: false });
  const endPinch = (e) => { pinchPts.delete(e.pointerId); if (pinchPts.size < 2) pinch = null; };
  sc0.addEventListener('pointerup', endPinch);
  sc0.addEventListener('pointercancel', endPinch);
  // ===== "+ Einfügen" ======================================================
  // Ein Menü statt vier Schaltflächen und einer dauerhaft sichtbaren Auswahlliste.
  // Alle Einträge beziehen sich auf die aktuelle Playhead-Position.
  async function addOverlayClipHere() {
    const overlays = state.overlays || [];
    if (!overlays.length) { newOverlayHere(); return; }
    const sel = U.selectInput(overlays.map((o) => [o.id, o.name]), overlays[0].id);
    const body = U.el('div', 'dlg-fields');
    body.append(
      U.field('Welches Overlay?', sel),
      U.el('p', 'hint', `Das Anzeigefenster beginnt bei ${fmtClock(playheadT)} und läuft zunächst bis zum Programmende. Länge und Lage danach direkt in der Spur ziehen.`)
    );
    U.dialog({
      title: 'Overlay-Fenster einfügen',
      body,
      actions: [
        { label: 'Abbrechen', cls: 'ghost', onClick: (h) => h.close() },
        { label: 'Einfügen', onClick: (h) => { h.close(); apiAddClip(sel.value, playheadT); } }
      ]
    });
  }
  // Neues Overlay anlegen + Fenster (Clip) am Playhead, dann zum Editor.
  async function newOverlayHere() {
    try {
      const o = await U.api('POST', '/api/overlay', {});
      if (!o || !o.id) return;
      await apiAddClip(o.id, playheadT);
      location.href = '/overlay?overlay=' + o.id;
    } catch (_) {}
  }
  $('tl-insert').appendChild(U.overflowMenu([
    { label: '📑 Kapitel am Playhead', onClick: addChapterHere },
    { label: '⭐ Position als Highlight', onClick: addHighlightHere },
    'sep',
    { label: '✦ Overlay-Fenster einfügen…', onClick: addOverlayClipHere },
    { label: '✦ Neues Overlay anlegen', onClick: newOverlayHere }
  ], { glyph: '+ Einfügen', label: 'Am Playhead einfügen', btnCls: 'tl-tbtn tl-insert-btn' }));

  window.addEventListener('resize', () => { syncPreviewTop(); updatePreviewCollapse(); render(); });

  // ===== Vorschau-Skalierung (18:16) =======================================
  const PREVIEW_W = 4320, PREVIEW_H = 3840;
  let previewH = 0; // aktuelle Vorschauhöhe (px), vom Scroll-Collapse gesteuert
  function scalePreview(stage, wrap, availW, availH) {
    if (!stage || stage.offsetParent === null) return;
    const scale = Math.max(0.01, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    stage.style.width = Math.round(PREVIEW_W * scale) + 'px';
    stage.style.height = Math.round(PREVIEW_H * scale) + 'px';
    wrap.style.transform = `scale(${scale})`;
  }
  // Collapsing-Header: oben groß (BIG), beim Runterscrollen bis zur jetzigen Größe
  // (MIN) schrumpfen; danach bleibt die Vorschau sticky und nur das Scrubboard scrollt.
  function previewBounds() {
    const big = window.innerHeight * 0.62;
    const min = window.innerHeight * 0.42;
    // Schrumpfrate ~0,5 (range = 2*Δ) → kein Scroll-Feedback-Ruckeln.
    return { big, min, range: Math.max(120, (big - min) * 2) };
  }
  function scaleInlinePreview() {
    const stage = $('prev-stage');
    const availW = (stage.parentElement.clientWidth || window.innerWidth) - 28;
    if (!previewH) previewH = previewBounds().big;
    scalePreview(stage, $('prev-frame-wrap'), availW, previewH);
  }
  function updatePreviewCollapse() {
    const { big, min, range } = previewBounds();
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const p = Math.max(0, Math.min(1, y / range));
    previewH = big + (min - big) * p;
    scaleInlinePreview();
  }
  // Vorschau klebt unter der (sticky) Topbar – top auf deren Höhe setzen.
  function syncPreviewTop() {
    const tb = document.querySelector('.topbar');
    const sec = document.querySelector('.prog-preview');
    if (sec) sec.style.top = (tb ? tb.offsetHeight : 0) + 'px';
  }
  function scaleGolivePreview() {
    scalePreview($('golive-stage'), $('golive-frame-wrap'), window.innerWidth * 0.9, window.innerHeight * 0.62);
  }
  window.addEventListener('scroll', updatePreviewCollapse, { passive: true });
  requestAnimationFrame(() => { syncPreviewTop(); updatePreviewCollapse(); });
  setPreviewMode('live'); // Start als Live-Spiegel der Wand (F5-fest); dirty -> Entwurf

  // ===== Vorschau-Modus (Live-Spiegel <-> Entwurf) =========================
  function setPreviewMode(m) {
    const changed = m !== mode || !$('prev-frame').src;
    mode = m;
    if (changed) $('prev-frame').src = m === 'live' ? '/screen?view=live' : '/screen';
    $('tl-transport').style.display = m === 'draft' ? '' : 'none';
    $('tl-live').classList.toggle('hidden', m === 'live');
    // EIN Statusindikator: Badge (samt Erklärung) plus roter Rahmen. Der frühere
    // zusätzliche Text neben der Uhr sagte dasselbe ein zweites Mal.
    const live = m === 'live';
    $('prev-stage').classList.toggle('live', live);
    const badge = $('prog-live-badge');
    badge.classList.toggle('is-live', live);
    badge.textContent = live ? '● LIVE auf der Wand' : 'ENTWURF – am Zeitstrahl scrubben';
    if (m === 'draft' && changed) seedDraftToPlayhead();
  }
  // Nach Moduswechsel die (neu ladende) Entwurf-Vorschau auf den Playhead setzen.
  function seedDraftToPlayhead() {
    const e = entryAt(playheadT); if (!e) return;
    [300, 900, 1600].forEach((d) => setTimeout(() => {
      if (mode === 'draft') wsSend({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset, progTime: playheadT });
    }, d));
  }
  $('tl-live').addEventListener('click', () => { positioned = false; updateGoLive(); setPreviewMode('live'); });

  // Live-Modus: Playhead folgt der Wand (nowplaying.progTime, lokal interpoliert).
  setInterval(() => {
    if (mode === 'live' && !scrubbing && liveProg.ts) {
      playheadT = Math.min(total, liveProg.t + (performance.now() - liveProg.ts) / 1000);
      positionPlayhead();         // positioniert Scrub- + Live-Marker
    } else {
      updateLiveMarker();         // im Entwurf läuft die rote Live-Linie weiter mit
    }
  }, 200);

  // ===== Wiedergabe (Play/Pause – pausiert nur die Vorschau) ===============
  let playing = true;
  // Button-/Statusanzeige ohne Kommando (Spiegelung des echten Vorschau-Zustands).
  function syncPlaying(p) {
    if (playing === p) return;
    playing = p;
    $('tl-play').textContent = p ? '⏸' : '▶';
    $('tl-play').title = p ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)';
  }
  function setPlaying(p) {
    syncPlaying(p);
    wsSend({ type: 'cmd', cmd: p ? 'play' : 'pause' });
  }
  // Space pausiert die Vorschau. Im Live-Spiegel zuerst in den Entwurf wechseln
  // (Wand bleibt unangetastet) und die Pause robust an das ladende Iframe nachsenden.
  function togglePlay() {
    if (mode === 'live') {
      setPreviewMode('draft');
      playing = true; // frisch geladene Vorschau spielt
      setPlaying(false);
      [300, 900, 1600].forEach((d) => setTimeout(() => { if (mode === 'draft' && !playing) wsSend({ type: 'cmd', cmd: 'pause' }); }, d));
      return;
    }
    setPlaying(!playing);
  }
  $('tl-play').addEventListener('click', togglePlay);
  $('tl-to-start').addEventListener('click', () => scrubTo(0));
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (!$('golive-modal').classList.contains('hidden')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    // Zifferntasten 0–9 springen prozentual auf die Timeline (0=Start, 5=50%, 9=90%).
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      if (mode === 'live') setPreviewMode('draft');
      scrubTo(total * Number(e.key) / 10);
    }
  });

  // ===== Go Live ===========================================================
  let dirtyState = false, positioned = false;
  function setDirty(dirty) {
    const became = dirty && !dirtyState;
    dirtyState = dirty;
    if (became && mode === 'live') setPreviewMode('draft'); // Bearbeitung -> Entwurf-Vorschau
    updateGoLive();
  }
  // dirty = unveröffentlichte Änderungen; positioned = Playhead wurde bewegt, man
  // kann also bewusst ab dieser Stelle live gehen.
  function updateGoLive() {
    draft.update({ dirty: dirtyState, show: dirtyState || positioned });
  }

  function openGoLive() {
    $('golive-frame').src = '/screen';
    $('golive-modal').classList.remove('hidden');
    resetSlide();
    scaleGolivePreview();
    requestAnimationFrame(scaleGolivePreview);
    // Modal-Vorschau ab Playhead-Punkt starten, sobald das Iframe verbunden ist.
    const e = entryAt(playheadT);
    if (e) setTimeout(() => wsSend({ type: 'cmd', cmd: 'goto', itemId: e.itemId, time: e.offset, progTime: playheadT }), 1200);
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

  // ---- Slide-to-go-live (Gestik aus ui.js, hier nur die Wirkung) -----------
  const goliveSlide = U.bindSlide($('golive-slider'), async () => {
    // Wand ab dem Cursor (Playhead) starten: Position mitgeben.
    const e = entryAt(playheadT);
    const body = e ? { goto: { itemId: e.itemId, time: e.offset, progTime: playheadT } } : {};
    try {
      await U.api('POST', '/api/golive', body);
      U.toast('Auf der Wand veröffentlicht');
    } catch (_) {}
    closeGoLive();
    positioned = false;
    setPreviewMode('live'); // jetzt ist Entwurf = Live -> Live-Spiegel zeigen
  });
  const resetSlide = () => goliveSlide.reset();
  window.addEventListener('resize', () => {
    if (!$('golive-modal').classList.contains('hidden')) {
      scaleGolivePreview();
      goliveSlide.refresh();
    }
  });

  // ===== Utils =============================================================
  // Tick-Abstand so wählen, dass Beschriftungen ~70px auseinander liegen.
  function chooseStep(pps) {
    const target = 70 / pps; // Sekunden pro ~70px
    const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const n of nice) if (n >= target) return n;
    return 3600;
  }
})();
