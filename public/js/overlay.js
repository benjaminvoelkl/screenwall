// Overlay-Canvas-Editor (/overlay). Verwaltet mehrere Overlays (Zeit-Clips) und
// ihre Elemente (Text/Bild/QR) über die /api/overlay-Routen. Elemente werden auf
// einem Canvas in Ausgabegröße (18:16) frei positioniert/skaliert – mit Snap-/
// Orientierungslinien. Änderungen landen im Entwurf; "Go Live" auf /programm.

(() => {
  const $ = (id) => document.getElementById(id);
  const PREVIEW_W = 4320, PREVIEW_H = 3840;

  let state = null;
  let selOvId = new URLSearchParams(location.search).get('overlay');
  let selElId = null;
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
  const selOverlay = () => overlays().find((o) => o.id === selOvId) || null;
  const selElement = () => { const o = selOverlay(); return o ? o.elements.find((e) => e.id === selElId) : null; };
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
    return JSON.stringify(overlays().map((o) => [o.id, o.elements.map((e) => e.id + ':' + e.type)])) + '|' + selOvId + '|' + selElId;
  }
  function render() {
    if (!state) return;
    if (!selOverlay() && overlays().length) selOvId = overlays()[0].id;
    if (selOverlay() && !selElement()) selElId = null;
    renderOverlayList();
    const sig = structSig();
    const structural = sig !== lastSig; lastSig = sig;
    $('ov-props-box').hidden = !selOverlay();
    $('el-box').hidden = !selOverlay();
    if (structural) { renderOverlayProps(); renderElementList(); renderElementProps(); rebuildCanvas(); }
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
      row.addEventListener('click', () => { selOvId = o.id; selElId = null; render(); });
      list.appendChild(row);
    });
  }
  $('ov-add').addEventListener('click', async () => {
    const o = await api('POST', '/api/overlay', { name: `Overlay ${overlays().length + 1}` });
    if (o && o.id) { selOvId = o.id; selElId = null; }
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
      if (confirm(`Overlay „${o.name}" löschen?`)) { await api('DELETE', `/api/overlay/${o.id}`); selOvId = null; selElId = null; }
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

  // ---- Element-Liste ------------------------------------------------------
  const EL_LABEL = { text: 'Text', image: 'Bild', qr: 'QR-Code' };
  function renderElementList() {
    const o = selOverlay(); const list = $('el-list');
    list.innerHTML = '';
    if (!o) return;
    if (!o.elements.length) { list.innerHTML = '<div class="ed-empty-hint">Noch keine Elemente. Oben hinzufügen.</div>'; return; }
    o.elements.forEach((e) => {
      const row = el('div', 'ed-item' + (e.id === selElId ? ' sel' : ''));
      const name = el('span', 'ed-name'); name.textContent = elementTitle(e);
      const tag = el('span', 'ed-tag'); tag.textContent = EL_LABEL[e.type];
      row.append(name, tag);
      row.addEventListener('click', () => { selElId = e.id; render(); });
      list.appendChild(row);
    });
  }
  function elementTitle(e) {
    if (e.type === 'text') return e.text || '(Text)';
    if (e.type === 'image') return e.filename ? 'Bild' : (e.url || '(Bild)');
    return e.data || '(QR)';
  }
  document.querySelectorAll('[data-add-el]').forEach((b) => b.addEventListener('click', async () => {
    const o = selOverlay(); if (!o) return;
    const type = b.dataset.addEl;
    const base = { type, x: 0.35, y: 0.4, w: 0.3, h: 0.2 };
    if (type === 'text') Object.assign(base, { text: 'Neuer Text', h: 0.12 });
    if (type === 'qr') Object.assign(base, { data: 'https://', w: 0.2, h: 0.2 });
    const created = await api('POST', `/api/overlay/${o.id}/element`, { element: base });
    if (created && created.id) selElId = created.id;
  }));

  // ---- Element-Eigenschaften ---------------------------------------------
  function patchEl(fields) {
    const o = selOverlay(), e = selElement();
    if (o && e) api('PATCH', `/api/overlay/${o.id}/element/${e.id}`, { element: fields });
  }
  function renderElementProps() {
    const box = $('el-props'); box.innerHTML = '';
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

    box.appendChild(hr());
    box.appendChild(btn('Element löschen', 'tiny ghost', async () => {
      const o = selOverlay(); if (o && confirm('Element löschen?')) { await api('DELETE', `/api/overlay/${o.id}/element/${e.id}`); selElId = null; }
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
  function styleEditEl(node, e) {
    node.className = 'ed-el ' + e.type + (e.type === 'text' ? ' align-' + (e.align || 'center') : '');
    node.style.left = e.x * 100 + '%'; node.style.top = e.y * 100 + '%';
    node.style.width = e.w * 100 + '%'; node.style.height = e.h * 100 + '%';
    node.style.outline = ''; node.classList.remove('empty');
    if (e.type === 'text') {
      node.textContent = e.text || '';
      node.style.color = e.color || '#fff';
      node.style.fontWeight = e.weight || 700;
      node.style.fontSize = (e.fontFrac || 0.5) * (e.h || 0.1) * PREVIEW_H + 'px';
    } else if (e.type === 'image') {
      node.innerHTML = '';
      if (e.filename || e.url) { const img = document.createElement('img'); img.className = e.fit || 'contain'; img.src = e.filename ? `/uploads/${e.filename}` : e.url; node.appendChild(img); }
      else node.classList.add('empty');
    } else if (e.type === 'qr') {
      node.innerHTML = '';
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
    const e = selElement(); if (!e) return;
    const box = el('div', 'ed-selbox');
    box.style.left = e.x * stageW() + 'px'; box.style.top = e.y * stageH() + 'px';
    box.style.width = e.w * stageW() + 'px'; box.style.height = e.h * stageH() + 'px';
    for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const h = el('div', 'ed-handle ' + dir);
      h.addEventListener('pointerdown', (ev) => startResize(ev, e, dir));
      box.appendChild(h);
    }
    $('ov-stage').appendChild(box);
  }

  // ---- Drag (verschieben) -------------------------------------------------
  function startMove(ev, e, node) {
    ev.preventDefault(); ev.stopPropagation();
    if (selElId !== e.id) { selElId = e.id; render(); }
    dragging = true;
    const sx = ev.clientX, sy = ev.clientY, ox = e.x, oy = e.y;
    node.setPointerCapture(ev.pointerId);
    const move = (m) => {
      let nx = clamp01(ox + (m.clientX - sx) / stageW(), e.w);
      let ny = clamp01(oy + (m.clientY - sy) / stageH(), e.h);
      const snapped = snapMove(nx, ny, e.w, e.h, e.id);
      e.x = snapped.x; e.y = snapped.y;
      styleEditEl(node, e); placeSelbox(e); drawGuides(snapped.guides);
    };
    const up = () => {
      node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up);
      dragging = false; clearGuides();
      patchEl({ x: e.x, y: e.y });
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
      styleEditEl(node, e); placeSelbox(e);
    };
    const up = () => {
      ev.target.removeEventListener('pointermove', move); ev.target.removeEventListener('pointerup', up);
      dragging = false;
      patchEl({ x: e.x, y: e.y, w: e.w, h: e.h });
    };
    ev.target.addEventListener('pointermove', move); ev.target.addEventListener('pointerup', up);
  }

  function placeSelbox(e) {
    const box = $('ov-stage').querySelector('.ed-selbox'); if (!box) return;
    box.style.left = e.x * stageW() + 'px'; box.style.top = e.y * stageH() + 'px';
    box.style.width = e.w * stageW() + 'px'; box.style.height = e.h * stageH() + 'px';
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
  $('ov-stage').addEventListener('pointerdown', (ev) => { if (ev.target === $('ov-stage') || ev.target === $('ov-canvas')) { selElId = null; render(); } });
  window.addEventListener('resize', () => { scaleStage(); renderSelbox(); });

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
