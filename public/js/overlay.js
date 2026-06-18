// Overlay-Canvas-Editor (/overlay). Verwaltet mehrere Overlays (Zeit-Clips) und
// ihre Elemente (Text/Bild/QR) über die /api/overlay-Routen. Elemente werden auf
// einem Canvas in Ausgabegröße (18:16) frei positioniert/skaliert – mit Snap-/
// Orientierungslinien. Änderungen landen im Entwurf; "Go Live" auf /programm.

(() => {
  const $ = (id) => document.getElementById(id);
  const PREVIEW_W = 4320, PREVIEW_H = 3840;

  let state = null;
  let selOvId = new URLSearchParams(location.search).get('overlay');
  let selIds = [];                  // Mehrfachauswahl von Elementen (für Gruppen/Bibliothek)
  let scale = 0.1;
  let dragging = false;
  let lastSig = null;

  // ---- API ----------------------------------------------------------------
  async function api(method, url, body) {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const r = await fetch(url, opt);
    return r.json().catch(() => ({}));
  }
  const overlays = () => (state && state.overlays) || [];
  const library = () => (state && state.library) || [];
  const selOverlay = () => overlays().find((o) => o.id === selOvId) || null;
  const selElements = () => { const o = selOverlay(); return o ? o.elements.filter((e) => selIds.includes(e.id)) : []; };
  // Einzelauswahl (für Eigenschaften/Patch/Resize): nur wenn genau ein Element gewählt ist.
  const selElement = () => { const els = selElements(); return els.length === 1 ? els[0] : null; };
  function selectEl(id, additive) {
    if (additive) { const i = selIds.indexOf(id); if (i >= 0) selIds.splice(i, 1); else selIds.push(id); }
    else selIds = id ? [id] : [];
  }
  function setIfNotFocused(el, v) { if (el && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }

  // ---- WebSocket ----------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/?role=control`);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') {
          state = msg.state;
          if (typeof msg.dirty === 'boolean') $('go-live').classList.toggle('hidden', !msg.dirty);
          render();
        }
      } catch (_) {}
    });
    ws.addEventListener('close', () => setTimeout(connect, 1500));
    ws.addEventListener('error', () => ws.close());
  }
  connect();
  fetch('/api/state').then((r) => r.json()).then((s) => { state = s; render(); });
  $('go-live').addEventListener('click', () => { location.href = '/programm'; });

  // ---- Render-Steuerung ---------------------------------------------------
  function structSig() {
    return JSON.stringify(overlays().map((o) => [o.id, o.elements.map((e) => e.id + ':' + e.type)]))
      + '|' + selOvId + '|' + selIds.join(',') + '|' + library().map((l) => l.id).join(',');
  }
  function render() {
    if (!state) return;
    if (!selOverlay() && overlays().length) selOvId = overlays()[0].id;
    const o = selOverlay();
    if (o) selIds = selIds.filter((id) => o.elements.some((e) => e.id === id)); // verschwundene abwählen
    renderOverlayList();
    const sig = structSig();
    const structural = sig !== lastSig; lastSig = sig;
    $('ov-props-box').hidden = !selOverlay();
    $('el-box').hidden = !selOverlay();
    if (structural) { renderOverlayProps(); renderElementList(); renderElementProps(); renderLibrary(); rebuildCanvas(); }
    else if (!dragging) updateCanvas();
  }

  // ---- Overlay-Liste ------------------------------------------------------
  function renderOverlayList() {
    const list = $('ov-list');
    list.innerHTML = '';
    if (!overlays().length) { list.innerHTML = '<div class="ed-empty-hint">Noch keine Overlays.</div>'; return; }
    overlays().forEach((o) => {
      const row = document.createElement('div');
      row.className = 'ed-item' + (o.id === selOvId ? ' sel' : '') + (o.enabled ? '' : ' disabled');
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.checked = o.enabled; chk.title = 'Ein-/ausblenden';
      chk.addEventListener('click', (e) => e.stopPropagation());
      chk.addEventListener('change', () => api('PATCH', `/api/overlay/${o.id}`, { enabled: chk.checked }));
      const name = document.createElement('span');
      name.className = 'ed-name'; name.textContent = o.name;
      const tag = document.createElement('span');
      tag.className = 'ed-tag'; tag.textContent = `${o.elements.length} El.`;
      row.append(chk, name, tag);
      row.addEventListener('click', () => { selOvId = o.id; selIds = []; render(); });
      list.appendChild(row);
    });
  }
  $('ov-add').addEventListener('click', async () => {
    const o = await api('POST', '/api/overlay', { name: `Overlay ${overlays().length + 1}` });
    if (o && o.id) { selOvId = o.id; selIds = []; }
  });

  // ---- Overlay-Eigenschaften ---------------------------------------------
  function renderOverlayProps() {
    const o = selOverlay(); const box = $('ov-props');
    box.innerHTML = '';
    if (!o) return;
    box.appendChild(field('Name', textInput(o.name, (v) => api('PATCH', `/api/overlay/${o.id}`, { name: v }))));
    const grid = el('div', 'ed-grid2');
    grid.appendChild(field('Start (s)', numInput(o.start, 0, 100000, 0.5, (v) => api('PATCH', `/api/overlay/${o.id}`, { start: v }))));
    const dur = numInput(o.duration == null ? '' : o.duration, 0, 100000, 0.5, (v) => api('PATCH', `/api/overlay/${o.id}`, { duration: v > 0 ? v : null }));
    dur.placeholder = 'immer';
    grid.appendChild(field('Dauer (s) – leer = immer', dur));
    box.appendChild(grid);
    box.appendChild(field('Hintergrund-Blur (px)', numInput(o.blur, 0, 60, 1, (v) => api('PATCH', `/api/overlay/${o.id}`, { blur: v }))));
    const actions = el('div', 'ed-row'); actions.style.marginTop = '10px';
    actions.appendChild(btn('In den Vordergrund', 'tiny', () => moveZ(o.id, +1)));
    actions.appendChild(btn('Nach hinten', 'tiny ghost', () => moveZ(o.id, -1)));
    actions.appendChild(btn('Löschen', 'tiny ghost', async () => {
      if (confirm(`Overlay „${o.name}" löschen?`)) { await api('DELETE', `/api/overlay/${o.id}`); selOvId = null; selIds = []; }
    }));
    box.appendChild(actions);
  }
  async function moveZ(id, dir) {
    const ids = overlays().map((o) => o.id);
    const i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids.splice(i, 1); ids.splice(j, 0, id);
    await api('POST', '/api/overlays/order', { order: ids });
  }
  // Z-Ordnung eines Elements innerhalb seines Overlays (Array-Ende = Vordergrund).
  // dir > 0 verschiebt nach vorn, edge=true bis ganz vorn/hinten.
  async function moveElZ(dir, edge) {
    const o = selOverlay(), e = selElement(); if (!o || !e) return;
    const ids = o.elements.map((x) => x.id);
    const i = ids.indexOf(e.id); if (i < 0) return;
    let j = edge ? (dir > 0 ? ids.length - 1 : 0) : i + dir;
    j = Math.max(0, Math.min(ids.length - 1, j));
    if (j === i) return;
    ids.splice(i, 1); ids.splice(j, 0, e.id);
    await api('POST', `/api/overlay/${o.id}/elements/order`, { order: ids });
  }

  // ---- Element-Liste ------------------------------------------------------
  const EL_LABEL = { text: 'Text', image: 'Bild', qr: 'QR-Code', shape: 'Fläche' };
  function renderElementList() {
    const o = selOverlay(); const list = $('el-list');
    list.innerHTML = '';
    if (!o) return;
    if (!o.elements.length) { list.innerHTML = '<div class="ed-empty-hint">Noch keine Elemente. Oben hinzufügen.</div>'; return; }
    o.elements.forEach((e) => {
      const row = el('div', 'ed-item' + (selIds.includes(e.id) ? ' sel' : ''));
      const name = el('span', 'ed-name'); name.textContent = elementTitle(e);
      const tag = el('span', 'ed-tag'); tag.textContent = EL_LABEL[e.type] || e.type;
      row.append(name, tag);
      row.addEventListener('click', (ev) => { selectEl(e.id, ev.shiftKey || ev.ctrlKey || ev.metaKey); render(); });
      list.appendChild(row);
    });
  }
  function elementTitle(e) {
    if (e.type === 'text') return e.text || '(Text)';
    if (e.type === 'image') return e.filename ? 'Bild' : (e.url || '(Bild)');
    if (e.type === 'shape') return e.shape === 'circle' ? 'Kreis' : 'Rechteck';
    return e.data || '(QR)';
  }
  document.querySelectorAll('[data-add-el]').forEach((b) => b.addEventListener('click', async () => {
    const o = selOverlay(); if (!o) return;
    const type = b.dataset.addEl;
    const base = { type, x: 0.35, y: 0.4, w: 0.3, h: 0.2 };
    if (type === 'text') Object.assign(base, { text: 'Neuer Text', h: 0.12 });
    if (type === 'qr') Object.assign(base, { data: 'https://', w: 0.2, h: 0.2 });
    if (type === 'rect' || type === 'circle') Object.assign(base, {
      type: 'shape', shape: type === 'circle' ? 'circle' : 'rect',
      fill: '#3b82f6', fillOpacity: 1, border: { enabled: true, width: 6, color: '#000000' },
      blur: 0, blurMode: 'backdrop', radius: type === 'rect' ? 24 : 0
    });
    const created = await api('POST', `/api/overlay/${o.id}/element`, { element: base });
    if (created && created.id) selIds = [created.id];
  }));

  // ---- Element-Eigenschaften ---------------------------------------------
  function patchEl(fields) {
    const o = selOverlay(), e = selElement();
    if (o && e) api('PATCH', `/api/overlay/${o.id}/element/${e.id}`, { element: fields });
  }
  // Gemeinsame Flächen-Stil-Felder (für Shapes und als Hintergrund von Text).
  function appendSurfaceFields(box, e, { fillLabel }) {
    const border = e.border || { enabled: false, width: 6, color: '#000000' };
    const g1 = el('div', 'ed-grid2');
    if (fillLabel) g1.appendChild(field(fillLabel, colorInput((e.type === 'shape' ? e.fill : e.bg) || '#3b82f6', (v) => patchEl(e.type === 'shape' ? { fill: v } : { bg: v }))));
    g1.appendChild(field('Deckkraft', rangeInput(e.fillOpacity ?? 1, 0, 1, 0.05, (v) => patchEl({ fillOpacity: v }))));
    box.appendChild(g1);
    box.appendChild(field('Rand anzeigen', checkboxInput(!!border.enabled, (v) => patchEl({ border: { ...border, enabled: v } }))));
    if (border.enabled) {
      const g2 = el('div', 'ed-grid2');
      g2.appendChild(field('Rand-Breite', numInput(border.width ?? 6, 0, 200, 1, (v) => patchEl({ border: { ...border, width: v } }))));
      g2.appendChild(field('Rand-Farbe', colorInput(border.color || '#000000', (v) => patchEl({ border: { ...border, color: v } }))));
      box.appendChild(g2);
    }
    const g3 = el('div', 'ed-grid2');
    g3.appendChild(field('Blur', numInput(e.blur || 0, 0, 200, 1, (v) => patchEl({ blur: v }))));
    g3.appendChild(field('Blur-Art', selectInput([['backdrop', 'Hintergrund'], ['self', 'Selbst']], e.blurMode || 'backdrop', (v) => patchEl({ blurMode: v }))));
    box.appendChild(g3);
    if (!(e.type === 'shape' && e.shape === 'circle')) {
      box.appendChild(field('Eckenradius', numInput(e.radius || 0, 0, 400, 1, (v) => patchEl({ radius: v }))));
    }
  }

  function renderElementProps() {
    const box = $('el-props'); box.innerHTML = '';
    const sel = selElements();
    if (sel.length > 1) {
      box.appendChild(hr());
      const info = el('div', 'ed-empty-hint'); info.textContent = `${sel.length} Elemente ausgewählt`;
      box.appendChild(info);
      box.appendChild(btn('Auswahl löschen', 'tiny ghost', async () => {
        if (!confirm(`${sel.length} Elemente löschen?`)) return;
        const o = selOverlay(); if (!o) return;
        for (const e of sel) await api('DELETE', `/api/overlay/${o.id}/element/${e.id}`);
        selIds = [];
      }));
      return;
    }
    const e = selElement(); if (!e) return;
    box.appendChild(hr());
    if (e.type === 'text') {
      box.appendChild(field('Text', textArea(e.text, (v) => patchEl({ text: v }))));
      const g = el('div', 'ed-grid2');
      g.appendChild(field('Farbe', colorInput(e.color || '#ffffff', (v) => patchEl({ color: v }))));
      g.appendChild(field('Ausrichtung', selectInput([['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts']], e.align, (v) => patchEl({ align: v }))));
      box.appendChild(g);
      box.appendChild(field('Schriftgröße (Anteil)', rangeInput(e.fontFrac ?? 0.5, 0.1, 1, 0.02, (v) => patchEl({ fontFrac: v }))));
      box.appendChild(field('Schriftstärke', selectInput([['400', 'Normal'], ['700', 'Fett'], ['900', 'Extra']], String(e.weight || 700), (v) => patchEl({ weight: Number(v) }))));
      box.appendChild(hr());
      const cap = el('div', 'ed-cap'); cap.textContent = 'Fläche (Hintergrund)';
      box.appendChild(cap);
      appendSurfaceFields(box, e, { fillLabel: 'Hintergrund' });
      box.appendChild(field('Innenabstand', rangeInput(e.pad ?? 0, 0, 0.5, 0.02, (v) => patchEl({ pad: v }))));
    } else if (e.type === 'shape') {
      box.appendChild(field('Form', selectInput([['rect', 'Rechteck'], ['circle', 'Kreis']], e.shape || 'rect', (v) => patchEl({ shape: v }))));
      appendSurfaceFields(box, e, { fillLabel: 'Füllfarbe' });
    } else if (e.type === 'image') {
      box.appendChild(btn(e.filename ? 'Bild ersetzen' : 'Bild hochladen', 'tiny', () => triggerImageUpload()));
      box.appendChild(field('oder Bild-URL', textInput(e.url || '', (v) => patchEl({ url: v }))));
      box.appendChild(field('Skalierung', selectInput([['contain', 'Einpassen'], ['cover', 'Füllen']], e.fit, (v) => patchEl({ fit: v }))));
    } else if (e.type === 'qr') {
      box.appendChild(field('Inhalt / URL', textInput(e.data || '', (v) => patchEl({ data: v }))));
      const g = el('div', 'ed-grid2');
      g.appendChild(field('Vordergrund', colorInput(e.fg || '#000000', (v) => patchEl({ fg: v }))));
      g.appendChild(field('Hintergrund', colorInput(e.bg || '#ffffff', (v) => patchEl({ bg: v }))));
      box.appendChild(g);
    }
    // Position/Größe (in %)
    const pg = el('div', 'ed-grid2');
    pg.appendChild(field('X %', numInput(Math.round(e.x * 100), 0, 100, 1, (v) => patchEl({ x: v / 100 }))));
    pg.appendChild(field('Y %', numInput(Math.round(e.y * 100), 0, 100, 1, (v) => patchEl({ y: v / 100 }))));
    pg.appendChild(field('Breite %', numInput(Math.round(e.w * 100), 1, 100, 1, (v) => patchEl({ w: v / 100 }))));
    pg.appendChild(field('Höhe %', numInput(Math.round(e.h * 100), 1, 100, 1, (v) => patchEl({ h: v / 100 }))));
    box.appendChild(pg);

    // Externe Datenquelle (Phase-1-Vorbereitung: Wetter/News)
    box.appendChild(hr());
    const src = e.source || { kind: 'static' };
    box.appendChild(field('Datenquelle', selectInput([['static', 'Statisch'], ['url', 'Externe URL']], src.kind, (v) => patchEl({ source: { ...src, kind: v } }))));
    if (src.kind === 'url') {
      box.appendChild(field('URL', textInput(src.url || '', (v) => patchEl({ source: { ...src, kind: 'url', url: v } }))));
      const g = el('div', 'ed-grid2');
      g.appendChild(field('Refresh (s)', numInput(src.refreshSec || 60, 2, 86400, 1, (v) => patchEl({ source: { ...src, kind: 'url', refreshSec: v } }))));
      g.appendChild(field('JSON-Pfad', textInput(src.jsonPath || '', (v) => patchEl({ source: { ...src, kind: 'url', jsonPath: v } }))));
      box.appendChild(g);
    }

    // Z-Ordnung innerhalb des Overlays (Vorder-/Hintergrund)
    box.appendChild(hr());
    const zcap = el('div', 'ed-cap'); zcap.textContent = 'Reihenfolge';
    box.appendChild(zcap);
    const z = el('div', 'ed-row');
    z.appendChild(btn('▲ Vordergrund', 'tiny', () => moveElZ(+1)));
    z.appendChild(btn('▼ Hintergrund', 'tiny ghost', () => moveElZ(-1)));
    z.appendChild(btn('⤒ ganz vorn', 'tiny', () => moveElZ(+1, true)));
    z.appendChild(btn('⤓ ganz hinten', 'tiny ghost', () => moveElZ(-1, true)));
    box.appendChild(z);

    box.appendChild(hr());
    box.appendChild(btn('Element löschen', 'tiny ghost', async () => {
      const o = selOverlay(); if (o && confirm('Element löschen?')) { await api('DELETE', `/api/overlay/${o.id}/element/${e.id}`); selIds = []; }
    }));
  }

  function triggerImageUpload() { $('el-image-input').click(); }
  $('el-image-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    const o = selOverlay(), e = selElement();
    if (!file || !o || !e) return;
    const fd = new FormData(); fd.append('file', file, file.name || 'bild');
    await fetch(`/api/overlay/${o.id}/element/${e.id}/image`, { method: 'POST', body: fd });
  });

  // ---- Canvas =============================================================
  function rebuildCanvas() {
    const canvas = $('ov-canvas');
    canvas.innerHTML = '';
    const o = selOverlay();
    if (o) for (const e of o.elements) canvas.appendChild(buildEditEl(e));
    scaleStage();
    renderSelbox();
  }
  function updateCanvas() {
    const o = selOverlay(); if (!o) return;
    for (const e of o.elements) {
      const node = $('ov-canvas').querySelector(`[data-id="${e.id}"]`);
      if (node) styleEditEl(node, e);
    }
    renderSelbox();
  }

  function buildEditEl(e) {
    const node = el('div', 'ed-el');
    node.dataset.id = e.id;
    styleEditEl(node, e);
    node.addEventListener('pointerdown', (ev) => startMove(ev, e, node));
    return node;
  }
  // Hex-Farbe mit Deckkraft als rgba() (Rand bleibt opak, nur die Füllung wird transparent).
  function withAlpha(color, a) {
    if (a == null || a >= 1) return color;
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color || '');
    if (!m) return color;
    let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
  }
  // Flächen-Layer (hinter dem Inhalt). Längen in Design-Pixeln (Canvas-Koordinaten, mit
  // dem Canvas skaliert) – passend zur Schriftgröße, die ebenfalls in Design-Pixeln rechnet.
  function surfaceEl(e, fillColor) {
    const border = e.border && e.border.enabled && e.border.width > 0;
    const blur = e.blur > 0;
    const isShape = e.type === 'shape';
    const fill = !!(fillColor && fillColor !== '');
    if (!isShape && !border && !blur && !fill) return null;
    const s = el('div', 'ed-surface');
    if (isShape && e.shape === 'circle') s.style.borderRadius = '50%';
    else if (e.radius > 0) s.style.borderRadius = e.radius + 'px';
    if (fill) s.style.background = withAlpha(fillColor, e.fillOpacity);
    if (border) s.style.border = `${e.border.width}px solid ${e.border.color}`;
    if (blur) {
      const f = `blur(${e.blur}px)`;
      if (e.blurMode === 'self') s.style.filter = f;
      else s.style.backdropFilter = s.style.webkitBackdropFilter = f;
    }
    return s;
  }
  function styleEditEl(node, e) {
    node.className = 'ed-el ' + e.type + (e.type === 'text' ? ' align-' + (e.align || 'center') : '');
    node.style.left = e.x * 100 + '%'; node.style.top = e.y * 100 + '%';
    node.style.width = e.w * 100 + '%'; node.style.height = e.h * 100 + '%';
    node.style.outline = ''; node.style.padding = ''; node.classList.remove('empty');
    node.innerHTML = '';
    if (e.type === 'text') {
      const s = surfaceEl(e, e.bg); if (s) node.appendChild(s);
      if (e.pad > 0) node.style.padding = e.pad * (e.h || 0.1) * PREVIEW_H + 'px';
      const tx = el('div', 'ed-text-content');
      tx.style.color = e.color || '#fff';
      tx.style.fontWeight = e.weight || 700;
      tx.style.fontSize = (e.fontFrac || 0.5) * (e.h || 0.1) * PREVIEW_H + 'px';
      tx.textContent = e.text || '';
      node.appendChild(tx);
    } else if (e.type === 'shape') {
      const s = surfaceEl(e, e.fill); if (s) node.appendChild(s);
    } else if (e.type === 'image') {
      if (e.filename || e.url) { const img = document.createElement('img'); img.className = e.fit || 'contain'; img.src = e.filename ? `/uploads/${e.filename}` : e.url; node.appendChild(img); }
      else node.classList.add('empty');
    } else if (e.type === 'qr') {
      const img = document.createElement('img');
      img.src = `/api/qr?data=${encodeURIComponent(e.data || ' ')}&fg=${encodeURIComponent(e.fg || '#000')}&bg=${encodeURIComponent(e.bg || '#fff')}`;
      node.appendChild(img);
    }
  }

  function scaleStage() {
    const stage = $('ov-stage'), canvas = $('ov-canvas');
    const availW = ($('ov-stage').parentElement.clientWidth || window.innerWidth) - 4;
    const availH = window.innerHeight * 0.82;
    scale = Math.max(0.02, Math.min(availW / PREVIEW_W, availH / PREVIEW_H));
    stage.style.width = Math.round(PREVIEW_W * scale) + 'px';
    stage.style.height = Math.round(PREVIEW_H * scale) + 'px';
    canvas.style.transform = `scale(${scale})`;
  }
  const stageW = () => PREVIEW_W * scale, stageH = () => PREVIEW_H * scale;

  // Auswahlrahmen + Griffe (Bühnen-Koordinaten)
  function renderSelbox() {
    $('ov-stage').querySelectorAll('.ed-selbox, .ed-guide').forEach((n) => n.remove());
    const sel = selElements(); if (!sel.length) return;
    const single = sel.length === 1;
    for (const e of sel) {
      const box = el('div', 'ed-selbox' + (single ? '' : ' multi'));
      box.dataset.id = e.id;
      box.style.left = e.x * stageW() + 'px'; box.style.top = e.y * stageH() + 'px';
      box.style.width = e.w * stageW() + 'px'; box.style.height = e.h * stageH() + 'px';
      if (single) for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const h = el('div', 'ed-handle ' + dir);
        h.addEventListener('pointerdown', (ev) => startResize(ev, e, dir));
        box.appendChild(h);
      }
      $('ov-stage').appendChild(box);
    }
  }
  const nodeOf = (id) => $('ov-canvas').querySelector(`[data-id="${id}"]`);

  // ---- Drag (verschieben) – einzeln mit Snap, mehrere gemeinsam -----------
  function startMove(ev, e, node) {
    ev.preventDefault(); ev.stopPropagation();
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (additive) { selectEl(e.id, true); render(); }
    else if (!selIds.includes(e.id)) { selectEl(e.id, false); render(); }
    dragging = true;
    const movers = selElements();
    const single = movers.length === 1;
    const sx = ev.clientX, sy = ev.clientY;
    const orig = movers.map((m) => ({ m, x: m.x, y: m.y }));
    node.setPointerCapture(ev.pointerId);
    const move = (mv) => {
      const dxf = (mv.clientX - sx) / stageW(), dyf = (mv.clientY - sy) / stageH();
      if (single) {
        const snapped = snapMove(clamp01(orig[0].x + dxf, e.w), clamp01(orig[0].y + dyf, e.h), e.w, e.h, e.id);
        e.x = snapped.x; e.y = snapped.y; drawGuides(snapped.guides);
      } else {
        for (const o2 of orig) { o2.m.x = clamp01(o2.x + dxf, o2.m.w); o2.m.y = clamp01(o2.y + dyf, o2.m.h); }
      }
      for (const o2 of orig) { const n = nodeOf(o2.m.id); if (n) styleEditEl(n, o2.m); }
      placeSelboxes();
    };
    const up = async () => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up);
      dragging = false; clearGuides();
      const o = selOverlay(); if (!o) return;
      for (const o2 of orig) api('PATCH', `/api/overlay/${o.id}/element/${o2.m.id}`, { element: { x: o2.m.x, y: o2.m.y } });
    };
    node.addEventListener('pointermove', move); node.addEventListener('pointerup', up);
  }

  // ---- Resize -------------------------------------------------------------
  function startResize(ev, e, dir) {
    ev.preventDefault(); ev.stopPropagation();
    dragging = true;
    const sx = ev.clientX, sy = ev.clientY;
    const o = { x: e.x, y: e.y, w: e.w, h: e.h };
    const node = $('ov-canvas').querySelector(`[data-id="${e.id}"]`);
    ev.target.setPointerCapture(ev.pointerId);
    const move = (m) => {
      const dx = (m.clientX - sx) / stageW(), dy = (m.clientY - sy) / stageH();
      let { x, y, w, h } = o;
      if (dir.includes('e')) w = o.w + dx;
      if (dir.includes('s')) h = o.h + dy;
      if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (dir.includes('n')) { h = o.h - dy; y = o.y + dy; }
      w = Math.max(0.02, Math.min(1, w)); h = Math.max(0.02, Math.min(1, h));
      x = Math.max(0, Math.min(1 - w, x)); y = Math.max(0, Math.min(1 - h, y));
      e.x = x; e.y = y; e.w = w; e.h = h;
      styleEditEl(node, e); placeSelboxes();
    };
    const up = () => {
      ev.target.removeEventListener('pointermove', move); ev.target.removeEventListener('pointerup', up);
      dragging = false;
      patchEl({ x: e.x, y: e.y, w: e.w, h: e.h });
    };
    ev.target.addEventListener('pointermove', move); ev.target.addEventListener('pointerup', up);
  }

  function placeSelboxes() {
    for (const e of selElements()) {
      const box = $('ov-stage').querySelector(`.ed-selbox[data-id="${e.id}"]`); if (!box) continue;
      box.style.left = e.x * stageW() + 'px'; box.style.top = e.y * stageH() + 'px';
      box.style.width = e.w * stageW() + 'px'; box.style.height = e.h * stageH() + 'px';
    }
  }

  // ---- Snap / Orientierungslinien ----------------------------------------
  function snapMove(x, y, w, h, selfId) {
    const o = selOverlay();
    const others = o ? o.elements.filter((e) => e.id !== selfId) : [];
    const thx = 8 / stageW(), thy = 8 / stageH();
    const guides = [];
    const targetsX = [0, 0.5, 1];
    const targetsY = [0, 0.5, 1];
    for (const e of others) { targetsX.push(e.x, e.x + e.w / 2, e.x + e.w); targetsY.push(e.y, e.y + e.h / 2, e.y + e.h); }
    // X: linke Kante / Mitte / rechte Kante an ein Ziel einrasten
    const linesX = [x, x + w / 2, x + w];
    for (let li = 0; li < linesX.length; li++) {
      for (const t of targetsX) {
        if (Math.abs(linesX[li] - t) < thx) { x += t - linesX[li]; guides.push({ axis: 'v', pos: t }); li = 99; break; }
      }
    }
    const linesY = [y, y + h / 2, y + h];
    for (let li = 0; li < linesY.length; li++) {
      for (const t of targetsY) {
        if (Math.abs(linesY[li] - t) < thy) { y += t - linesY[li]; guides.push({ axis: 'h', pos: t }); li = 99; break; }
      }
    }
    return { x: clamp01(x, w), y: clamp01(y, h), guides };
  }
  function drawGuides(guides) {
    clearGuides();
    for (const g of guides) {
      const line = el('div', 'ed-guide ' + g.axis);
      if (g.axis === 'v') line.style.left = g.pos * stageW() + 'px';
      else line.style.top = g.pos * stageH() + 'px';
      $('ov-stage').appendChild(line);
    }
  }
  function clearGuides() { $('ov-stage').querySelectorAll('.ed-guide').forEach((n) => n.remove()); }

  // Klick auf leere Bühne hebt Auswahl auf.
  $('ov-stage').addEventListener('pointerdown', (ev) => { if (ev.target === $('ov-stage') || ev.target === $('ov-canvas')) { selIds = []; render(); } });
  window.addEventListener('resize', () => { scaleStage(); renderSelbox(); });

  // ---- Bibliothek (wiederverwertbare Vorlagen) ---------------------------
  function renderLibrary() {
    const sel = selElements();
    const saveBtn = $('lib-save');
    saveBtn.hidden = sel.length < 1;
    saveBtn.textContent = sel.length > 1 ? `＋ Gruppe (${sel.length}) in Bibliothek` : '＋ Auswahl in Bibliothek';
    const list = $('lib-list'); list.innerHTML = '';
    if (!library().length) { list.innerHTML = '<div class="ed-empty-hint">Noch keine Vorlagen. Element auswählen und speichern.</div>'; return; }
    library().forEach((en) => {
      const row = el('div', 'ed-item');
      const name = el('span', 'ed-name'); name.textContent = en.name;
      const tag = el('span', 'ed-tag'); tag.textContent = en.kind === 'group' ? `${(en.elements || []).length} El.` : (EL_LABEL[en.element?.type] || 'El.');
      const ins = btn('Einfügen', 'tiny', async () => {
        const o = selOverlay(); if (!o) return;
        const created = await api('POST', `/api/overlay/${o.id}/element/from-library/${en.id}`);
        const arr = Array.isArray(created) ? created : (created ? [created] : []);
        if (arr.length) selIds = arr.map((c) => c.id);
      });
      const del = btn('✕', 'tiny ghost', async (ev) => { ev.stopPropagation(); if (confirm(`Vorlage „${en.name}" löschen?`)) await api('DELETE', `/api/library/${en.id}`); });
      row.append(name, tag, ins, del);
      list.appendChild(row);
    });
  }
  $('lib-save').addEventListener('click', async () => {
    const sel = selElements(); if (!sel.length) return;
    const strip = (e) => { const c = { ...e }; delete c.id; return c; };
    if (sel.length === 1) {
      const name = prompt('Name der Vorlage:', elementTitle(sel[0])); if (name == null) return;
      await api('POST', '/api/library', { name, kind: 'element', element: strip(sel[0]) });
    } else {
      const name = prompt('Name der Gruppe:', `Gruppe (${sel.length})`); if (name == null) return;
      await api('POST', '/api/library', { name, kind: 'group', elements: sel.map(strip) });
    }
  });

  // ---- kleine UI-Bausteine ------------------------------------------------
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function hr() { const h = el('div'); h.style.borderTop = '1px solid var(--border)'; h.style.margin = '10px 0'; return h; }
  function field(label, input) { const f = el('label', 'ed-field'); f.appendChild(document.createTextNode(label)); f.appendChild(input); return f; }
  function textInput(v, onChange) { const i = el('input'); i.type = 'text'; i.value = v || ''; i.addEventListener('change', () => onChange(i.value)); return i; }
  function textArea(v, onChange) { const t = el('textarea'); t.rows = 2; t.value = v || ''; t.addEventListener('change', () => onChange(t.value)); return t; }
  function numInput(v, min, max, step, onChange) {
    const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = v;
    i.addEventListener('change', () => { const n = i.value === '' ? 0 : Number(i.value); onChange(Math.max(min, Math.min(max, n))); });
    return i;
  }
  function colorInput(v, onChange) { const i = el('input', 'ed-color'); i.type = 'color'; i.value = v; i.addEventListener('change', () => onChange(i.value)); return i; }
  function checkboxInput(v, onChange) { const i = el('input'); i.type = 'checkbox'; i.checked = !!v; i.addEventListener('change', () => onChange(i.checked)); return i; }
  function rangeInput(v, min, max, step, onChange) {
    const i = el('input'); i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = v;
    i.addEventListener('change', () => onChange(Number(i.value)));
    return i;
  }
  function selectInput(opts, value, onChange) {
    const s = el('select');
    for (const [v, label] of opts) { const o = el('option'); o.value = v; o.textContent = label; s.appendChild(o); }
    s.value = value; s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function btn(label, cls, onClick) { const b = el('button', 'btn ' + (cls || '')); b.textContent = label; b.addEventListener('click', onClick); return b; }
  function clamp01(v, size) { return Math.max(0, Math.min(1 - (size || 0), v)); }
})();
