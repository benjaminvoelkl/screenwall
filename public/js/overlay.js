// Overlay-Canvas-Editor (/overlay). Verwaltet mehrere Overlays (Zeit-Clips) und
// ihre Elemente (Text/Bild/QR) über die /api/overlay-Routen. Elemente werden auf
// einem Canvas in Ausgabegröße (18:16) frei positioniert/skaliert – mit Snap-/
// Orientierungslinien. Änderungen landen im Entwurf; "Go Live" auf /programm.

(() => {
  const U = window.UI;
  const { $, el, hr, textInput, textArea, numInput, checkboxInput, rangeInput, selectInput, btn } = U;
  const PREVIEW_W = 4320, PREVIEW_H = 3840;

  // Beschriftetes Feld in Editor-Optik; die Bausteine selbst kommen aus ui.js.
  const field = (label, input) => { const f = U.field(label, input); f.className = 'ed-field'; return f; };
  const colorInput = (v, onChange) => {
    const i = U.colorInput(v, onChange); i.className = 'ed-color'; return i;
  };
  const setIfNotFocused = U.setIfNotFocused;

  let state = null;
  let selOvId = new URLSearchParams(location.search).get('overlay');
  let selIds = [];                  // Mehrfachauswahl von Elementen (für Gruppen/Bibliothek)
  let scale = 0.1;
  let dragging = false;
  let lastSig = null;

  // ---- API ----------------------------------------------------------------
  // Speichern quittiert sichtbar und meldet Serverfehler (vorher stillschweigend
  // verschluckt: `return r.json().catch(() => ({}))`).
  // U.save meldet Serverfehler bereits per Toast; null (statt {}) sorgt dafür,
  // dass die `if (created && created.id)`-Prüfungen einen Fehlschlag auch als
  // solchen erkennen, statt Erfolg vorzutäuschen.
  const api = (method, url, body) => U.save(method, url, body).catch(() => null);
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
  // ---- Navigation + Entwurfs-Leiste ---------------------------------------
  U.topbarNav('overlay');
  // Wie auf /playlists: die Leiste führt zur Programm-Timeline, wo mit Vorschau
  // und Slide-Bestätigung veröffentlicht wird.
  const draft = U.draftBar();

  // ---- WebSocket ----------------------------------------------------------
  U.connectState({
    onDirty: (dirty) => draft.update({ dirty, show: dirty }),
    onState: (s) => { state = s; render(); }
  });
  U.api('GET', '/api/state', undefined, { quiet: true })
    .then((s) => { state = s; render(); })
    .catch(() => {});

  // ---- Render-Steuerung ---------------------------------------------------
  // Zwei getrennte Signaturen, weil Listen/Canvas und Inspektor auf
  // Unterschiedliches reagieren müssen.
  function structSig() {
    return JSON.stringify(overlays().map((o) => [o.id, o.elements.map((e) => e.id + ':' + e.type)]))
      + '|' + selOvId + '|' + selIds.join(',') + '|' + library().map((l) => l.id).join(',');
  }
  // Genau die Werte, die entscheiden, WELCHE Felder es gibt. Fehlten sie hier,
  // erschienen Rand-Breite, die WLAN-Felder, der Eckenradius und die
  // Datenquellen-Felder erst nach erneutem Anklicken des Elements.
  function inspSig() {
    const e = selElement();
    if (!e) {
      // Ohne Elementauswahl zeigt der Inspektor das Overlay – inkl. "Ebene x von y",
      // das sich beim Umsortieren ändert, also mit in die Signatur muss.
      const o = selOverlay();
      return ['ov', o ? o.id : '-', overlays().findIndex((x) => o && x.id === o.id),
        overlays().length, selIds.length].join(':');
    }
    return [e.id, e.type, e.shape, e.qrMode, !!(e.border && e.border.enabled),
      (e.source || {}).kind, selIds.length].join('|');
  }
  function render() {
    if (!state) return;
    if (!selOverlay() && overlays().length) selOvId = overlays()[0].id;
    const o = selOverlay();
    if (o) selIds = selIds.filter((id) => o.elements.some((e) => e.id === id)); // verschwundene abwählen
    renderOverlayList();
    const sig = structSig();
    const structural = sig !== lastSig; lastSig = sig;
    $('el-box').hidden = !selOverlay();
    if (structural) { renderElementList(); renderLibrary(); rebuildCanvas(); }
    else if (!dragging) updateCanvas();
    renderInspector();
  }

  // Werte-Abgleich ohne Neuaufbau: beim Bauen meldet sich jedes Feld hier an,
  // danach lassen sich die Werte nachziehen, ohne Cursor, offene Auswahllisten
  // oder den Farbwähler zu zerstören.
  let inspBind = [];
  function bind(input, get) { inspBind.push({ input, get }); return input; }
  function syncInspector() {
    const e = selElement(); if (!e) return;
    for (const b of inspBind) setIfNotFocused(b.input, b.get(e));
  }
  function renderInspector() {
    const sig = inspSig();
    if (sig === lastInspSig) { syncInspector(); return; }
    lastInspSig = sig;
    inspBind = [];
    buildInspector();
  }
  let lastInspSig = null;

  // ---- Overlay-Liste ------------------------------------------------------
  function renderOverlayList() {
    const list = $('ov-list');
    list.innerHTML = '';
    if (!overlays().length) { list.innerHTML = '<div class="ed-empty-hint">Noch keine Overlays.</div>'; return; }
    overlays().forEach((o) => {
      const row = document.createElement('div');
      row.className = 'ed-item' + (o.id === selOvId ? ' sel' : '');
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '✦';
      const name = document.createElement('span');
      name.className = 'ed-name'; name.textContent = o.name;
      const tag = document.createElement('span');
      tag.className = 'ed-tag'; tag.textContent = `${o.elements.length} El.`;
      row.append(ic, name, tag);
      row.addEventListener('click', () => { selOvId = o.id; selIds = []; render(); });
      list.appendChild(row);
    });
  }
  $('ov-add').addEventListener('click', async () => {
    const o = await api('POST', '/api/overlay', { name: `Overlay ${overlays().length + 1}` });
    if (o && o.id) { selOvId = o.id; selIds = []; }
  });

  // ---- Overlay-Eigenschaften (Inspektor ohne Elementauswahl) --------------
  function buildOverlayProps(head, body) {
    const o = selOverlay();
    if (!o) {
      head.appendChild(el('div', 'ed-insp-title', 'Kein Overlay'));
      body.appendChild(el('div', 'ed-empty-hint', 'Links ein Overlay auswählen oder anlegen.'));
      return;
    }
    const title = el('div', 'ed-insp-title');
    title.appendChild(el('span', null, 'Overlay'));
    // Ohne diese Angabe war den Ebenen-Knöpfen nicht anzusehen, dass sie wirken:
    // die Bühne zeigt immer nur das gewählte Overlay.
    const idx = overlays().findIndex((x) => x.id === o.id);
    title.appendChild(el('span', 'ed-tag', `Ebene ${idx + 1} von ${overlays().length}`));
    head.appendChild(title);

    const acts = el('div', 'ed-insp-acts');
    acts.appendChild(btn('▲ vor', 'tiny', () => moveZ(o.id, +1)));
    acts.appendChild(btn('▼ zurück', 'tiny ghost', () => moveZ(o.id, -1)));
    acts.appendChild(U.overflowMenu([
      {
        label: '🗑 Overlay löschen', danger: true,
        onClick: async () => {
          const ok = await U.confirmDialog({
            title: 'Overlay löschen?',
            text: `„${o.name}" wird mit allen ${o.elements.length} Elementen gelöscht. `
              + 'Auch seine Anzeigefenster in den Playlists verschwinden damit.',
            confirmLabel: 'Löschen', danger: true
          });
          if (!ok) return;
          await api('DELETE', `/api/overlay/${o.id}`);
          selOvId = null; selIds = [];
        }
      }
    ], { label: `Weitere Aktionen für „${o.name}"` }));
    head.appendChild(acts);

    const b = el('div', 'ed-fields');
    b.appendChild(field('Name', textInput(o.name, (v) => api('PATCH', `/api/overlay/${o.id}`, { name: v }))));
    b.appendChild(field('Hintergrund-Blur (px)', numInput(o.blur, 0, 60, 1, (v) => api('PATCH', `/api/overlay/${o.id}`, { blur: v }))));
    body.appendChild(b);
    body.appendChild(el('div', 'ed-empty-hint',
      'Anzeige-Zeitfenster werden in der Programm-Timeline pro Playlist gesetzt.'));
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
    if (type === 'qr') Object.assign(base, { qrMode: 'url', url: 'https://', w: 0.2, h: 0.2 });
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
    const fillOf = (x) => ((x.type === 'shape' ? x.fill : x.bg) || '#3b82f6');
    const g1 = el('div', 'ed-grid2');
    if (fillLabel) g1.appendChild(field(fillLabel, bind(colorInput(fillOf(e), (v) => patchEl(e.type === 'shape' ? { fill: v } : { bg: v })), fillOf)));
    g1.appendChild(field('Deckkraft', bind(rangeInput(e.fillOpacity ?? 1, 0, 1, 0.05, (v) => patchEl({ fillOpacity: v })), (x) => x.fillOpacity ?? 1)));
    box.appendChild(g1);
    box.appendChild(field('Rand anzeigen', checkboxInput(!!border.enabled, (v) => patchEl({ border: { ...border, enabled: v } }))));
    if (border.enabled) {
      const g2 = el('div', 'ed-grid2');
      g2.appendChild(field('Rand-Breite', bind(numInput(border.width ?? 6, 0, 200, 1, (v) => patchEl({ border: { ...border, width: v } })), (x) => (x.border || {}).width ?? 6)));
      g2.appendChild(field('Rand-Farbe', bind(colorInput(border.color || '#000000', (v) => patchEl({ border: { ...border, color: v } })), (x) => (x.border || {}).color || '#000000')));
      box.appendChild(g2);
    }
    const g3 = el('div', 'ed-grid2');
    g3.appendChild(field('Blur', bind(numInput(e.blur || 0, 0, 200, 1, (v) => patchEl({ blur: v })), (x) => x.blur || 0)));
    g3.appendChild(field('Blur-Art', bind(selectInput([['backdrop', 'Hintergrund'], ['self', 'Selbst']], e.blurMode || 'backdrop', (v) => patchEl({ blurMode: v })), (x) => x.blurMode || 'backdrop')));
    box.appendChild(g3);
    if (!(e.type === 'shape' && e.shape === 'circle')) {
      box.appendChild(field('Eckenradius', bind(numInput(e.radius || 0, 0, 400, 1, (v) => patchEl({ radius: v })), (x) => x.radius || 0)));
    }
  }

  // ---- Inspektor ==========================================================
  // Kopf = worum es geht + die zwei, drei Aktionen dazu. Körper = die Felder,
  // gruppiert in einklappbare Abschnitte statt einer Liste aus ~18 Feldern.
  function buildInspector() {
    const head = $('insp-head'), body = $('insp-body');
    head.replaceChildren(); body.replaceChildren();

    const sel = selElements();
    if (sel.length > 1) { buildMultiProps(head, body, sel); return; }
    const e = selElement();
    if (!e) { buildOverlayProps(head, body); return; }
    buildElementProps(head, body, e);
  }

  function buildMultiProps(head, body, sel) {
    head.appendChild(el('div', 'ed-insp-title', `${sel.length} Elemente ausgewählt`));
    const acts = el('div', 'ed-insp-acts');
    acts.appendChild(btn('⧉ Duplizieren', 'tiny', () => duplicateSelection()));
    acts.appendChild(btn('🗑 Löschen', 'tiny danger', () => deleteSelection()));
    acts.appendChild(btn('＋ Bibliothek', 'tiny ghost', () => saveSelectionToLibrary()));
    head.appendChild(acts);
    body.appendChild(el('div', 'ed-empty-hint',
      'Gemeinsam verschieben, duplizieren, löschen oder als Gruppe sichern. '
      + 'Einzelne Eigenschaften: nur ein Element auswählen.'));
  }

  function buildElementProps(head, body, e) {
    // ---- Kopf
    const title = el('div', 'ed-insp-title');
    title.appendChild(el('span', null, elementTitle(e)));
    title.appendChild(el('span', 'ed-tag', EL_LABEL[e.type] || e.type));
    head.appendChild(title);
    const acts = el('div', 'ed-insp-acts');
    acts.appendChild(btn('⧉ Duplizieren', 'tiny', () => duplicateSelection()));
    acts.appendChild(btn('🗑 Löschen', 'tiny danger', () => deleteSelection()));
    acts.appendChild(U.overflowMenu([
      { label: '＋ In Bibliothek speichern', onClick: () => saveSelectionToLibrary() }
    ], { label: 'Weitere Aktionen für dieses Element' }));
    head.appendChild(acts);

    // ---- Abschnitt "Inhalt" (typabhängig)
    const inhalt = el('div', 'ed-fields');
    if (e.type === 'text') {
      inhalt.appendChild(field('Text', bind(textArea(e.text, (v) => patchEl({ text: v })), (x) => x.text)));
      const g = el('div', 'ed-grid2');
      g.appendChild(field('Farbe', bind(colorInput(e.color || '#ffffff', (v) => patchEl({ color: v })), (x) => x.color || '#ffffff')));
      g.appendChild(field('Ausrichtung', bind(selectInput([['left', 'Links'], ['center', 'Mitte'], ['right', 'Rechts']], e.align, (v) => patchEl({ align: v })), (x) => x.align)));
      inhalt.appendChild(g);
      inhalt.appendChild(field('Schriftgröße (Anteil)', bind(rangeInput(e.fontFrac ?? 0.5, 0.1, 1, 0.02, (v) => patchEl({ fontFrac: v })), (x) => x.fontFrac ?? 0.5)));
      inhalt.appendChild(field('Schriftstärke', bind(selectInput([['400', 'Normal'], ['700', 'Fett'], ['900', 'Extra']], String(e.weight || 700), (v) => patchEl({ weight: Number(v) })), (x) => String(x.weight || 700))));
    } else if (e.type === 'shape') {
      inhalt.appendChild(field('Form', bind(selectInput([['rect', 'Rechteck'], ['circle', 'Kreis']], e.shape || 'rect', (v) => patchEl({ shape: v })), (x) => x.shape || 'rect')));
    } else if (e.type === 'image') {
      inhalt.appendChild(btn(e.filename ? 'Bild ersetzen' : 'Bild hochladen', 'tiny', () => triggerImageUpload()));
      inhalt.appendChild(field('oder Bild-URL', bind(textInput(e.url || '', (v) => patchEl({ url: v })), (x) => x.url || '')));
      inhalt.appendChild(field('Skalierung', bind(selectInput([['contain', 'Einpassen'], ['cover', 'Füllen']], e.fit, (v) => patchEl({ fit: v })), (x) => x.fit)));
    } else if (e.type === 'qr') {
      const mode = e.qrMode || 'url';
      inhalt.appendChild(field('QR-Typ', bind(selectInput([['url', 'URL/Link'], ['wifi', 'WLAN'], ['contact', 'Kontakt']], mode, (v) => patchEl({ qrMode: v })), (x) => x.qrMode || 'url')));
      if (mode === 'wifi') {
        inhalt.appendChild(field('Netzwerk (SSID)', bind(textInput(e.ssid || '', (v) => patchEl({ ssid: v })), (x) => x.ssid || '')));
        inhalt.appendChild(field('Passwort', bind(textInput(e.password || '', (v) => patchEl({ password: v })), (x) => x.password || '')));
        const g = el('div', 'ed-grid2');
        g.appendChild(field('Verschlüsselung', bind(selectInput([['WPA', 'WPA/WPA2'], ['WEP', 'WEP'], ['nopass', 'offen']], e.encryption || 'WPA', (v) => patchEl({ encryption: v })), (x) => x.encryption || 'WPA')));
        g.appendChild(field('Verstecktes Netz', checkboxInput(!!e.hidden, (v) => patchEl({ hidden: v }))));
        inhalt.appendChild(g);
      } else if (mode === 'contact') {
        inhalt.appendChild(field('Name', bind(textInput(e.cname || '', (v) => patchEl({ cname: v })), (x) => x.cname || '')));
        const g = el('div', 'ed-grid2');
        g.appendChild(field('Telefon', bind(textInput(e.phone || '', (v) => patchEl({ phone: v })), (x) => x.phone || '')));
        g.appendChild(field('E-Mail', bind(textInput(e.email || '', (v) => patchEl({ email: v })), (x) => x.email || '')));
        inhalt.appendChild(g);
        const g2 = el('div', 'ed-grid2');
        g2.appendChild(field('Firma', bind(textInput(e.org || '', (v) => patchEl({ org: v })), (x) => x.org || '')));
        g2.appendChild(field('Webseite', bind(textInput(e.url || '', (v) => patchEl({ url: v })), (x) => x.url || '')));
        inhalt.appendChild(g2);
      } else {
        inhalt.appendChild(field('URL / Link', bind(textInput(e.url || e.data || '', (v) => patchEl({ url: v })), (x) => x.url || x.data || '')));
      }
      const gc = el('div', 'ed-grid2');
      gc.appendChild(field('Vordergrund', bind(colorInput(e.fg || '#000000', (v) => patchEl({ fg: v })), (x) => x.fg || '#000000')));
      gc.appendChild(field('Hintergrund', bind(colorInput(e.bg || '#ffffff', (v) => patchEl({ bg: v })), (x) => x.bg || '#ffffff')));
      inhalt.appendChild(gc);
    }
    body.appendChild(U.section({ key: 'ov.insp.inhalt', title: 'Inhalt', open: true, body: inhalt }));

    // ---- Abschnitt "Fläche" (nur wo es eine gibt)
    if (e.type === 'text' || e.type === 'shape') {
      const flaeche = el('div', 'ed-fields');
      appendSurfaceFields(flaeche, e, { fillLabel: e.type === 'shape' ? 'Füllfarbe' : 'Hintergrund' });
      if (e.type === 'text') {
        flaeche.appendChild(field('Innenabstand', bind(rangeInput(e.pad ?? 0, 0, 0.5, 0.02, (v) => patchEl({ pad: v })), (x) => x.pad ?? 0)));
      }
      body.appendChild(U.section({
        key: 'ov.insp.flaeche', title: 'Fläche',
        note: e.type === 'text' ? 'Hintergrund des Textes' : '',
        open: e.type === 'shape', body: flaeche
      }));
    }

    // ---- Abschnitt "Position, Größe & Ebene"
    // Zehntelprozent statt ganzer Prozent: beim Ziehen entstehen feinere Werte,
    // die das Feld sonst beim ersten Anfassen zerstörte.
    const pos = el('div', 'ed-fields');
    const pg = el('div', 'ed-grid2');
    const pct = (v) => Math.round(v * 1000) / 10;
    pg.appendChild(field('X %', bind(numInput(pct(e.x), 0, 100, 0.1, (v) => patchEl({ x: v / 100 })), (x) => pct(x.x))));
    pg.appendChild(field('Y %', bind(numInput(pct(e.y), 0, 100, 0.1, (v) => patchEl({ y: v / 100 })), (x) => pct(x.y))));
    pg.appendChild(field('Breite %', bind(numInput(pct(e.w), 0.1, 100, 0.1, (v) => patchEl({ w: v / 100 })), (x) => pct(x.w))));
    pg.appendChild(field('Höhe %', bind(numInput(pct(e.h), 0.1, 100, 0.1, (v) => patchEl({ h: v / 100 })), (x) => pct(x.h))));
    pos.appendChild(pg);
    const z = el('div', 'ed-row');
    z.appendChild(btn('▲ vor', 'tiny', () => moveElZ(+1)));
    z.appendChild(btn('▼ zurück', 'tiny ghost', () => moveElZ(-1)));
    z.appendChild(btn('⤒ ganz vorn', 'tiny', () => moveElZ(+1, true)));
    z.appendChild(btn('⤓ ganz hinten', 'tiny ghost', () => moveElZ(-1, true)));
    pos.appendChild(z);
    body.appendChild(U.section({ key: 'ov.insp.pos', title: 'Position, Größe & Ebene', open: true, body: pos }));

    // ---- Abschnitt "Datenquelle" (Vorbereitung Wetter/News)
    const src = e.source || { kind: 'static' };
    const quelle = el('div', 'ed-fields');
    quelle.appendChild(field('Datenquelle', bind(selectInput([['static', 'Statisch'], ['url', 'Externe URL']], src.kind, (v) => patchEl({ source: { ...src, kind: v } })), (x) => (x.source || {}).kind || 'static')));
    if (src.kind === 'url') {
      quelle.appendChild(field('URL', bind(textInput(src.url || '', (v) => patchEl({ source: { ...src, kind: 'url', url: v } })), (x) => (x.source || {}).url || '')));
      const g = el('div', 'ed-grid2');
      g.appendChild(field('Refresh (s)', bind(numInput(src.refreshSec || 60, 2, 86400, 1, (v) => patchEl({ source: { ...src, kind: 'url', refreshSec: v } })), (x) => (x.source || {}).refreshSec || 60)));
      g.appendChild(field('JSON-Pfad', bind(textInput(src.jsonPath || '', (v) => patchEl({ source: { ...src, kind: 'url', jsonPath: v } })), (x) => (x.source || {}).jsonPath || '')));
      quelle.appendChild(g);
    }
    body.appendChild(U.section({
      key: 'ov.insp.quelle', title: 'Datenquelle',
      note: src.kind === 'url' ? 'Externe URL' : '', open: false, body: quelle
    }));
  }

  // Eine Löschfunktion für Knopf UND Entf-Taste, ein Element oder mehrere.
  async function deleteSelection() {
    const o = selOverlay(); const sel = selElements();
    if (!o || !sel.length) return;
    const ok = await U.confirmDialog({
      title: sel.length === 1 ? 'Element löschen?' : `${sel.length} Elemente löschen?`,
      text: sel.length === 1
        ? `„${elementTitle(sel[0])}" wird aus „${o.name}" entfernt.`
        : 'Die ausgewählten Elemente werden aus diesem Overlay entfernt.',
      confirmLabel: 'Löschen', danger: true
    });
    if (!ok) return;
    for (const e of sel) await api('DELETE', `/api/overlay/${o.id}/element/${e.id}`);
    selIds = [];
  }

  // Duplizieren über die vorhandene Anlege-Route: der Server vergibt eine neue
  // id und normalisiert, alle Typfelder überleben. Leicht versetzt, damit die
  // Kopie nicht unsichtbar auf dem Original liegt.
  async function duplicateSelection() {
    const o = selOverlay(); const sel = selElements();
    if (!o || !sel.length) return;
    const made = [];
    for (const e of sel) {
      const copy = { ...e };
      delete copy.id;
      copy.x = clamp01((e.x || 0) + 0.02, e.w);
      copy.y = clamp01((e.y || 0) + 0.02, e.h);
      const c = await api('POST', `/api/overlay/${o.id}/element`, { element: copy });
      if (c && c.id) made.push(c.id);
    }
    if (made.length) { selIds = made; render(); }
  }

  function triggerImageUpload() { $('el-image-input').click(); }
  $('el-image-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    const o = selOverlay(), e = selElement();
    if (!file || !o || !e) return;
    const fd = new FormData(); fd.append('file', file, file.name || 'bild');
    try {
      const res = await fetch(`/api/overlay/${o.id}/element/${e.id}/image`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      U.saved('Bild hochgeladen');
    } catch (err) {
      // Vorher schlug ein fehlgeschlagener Upload komplett lautlos fehl.
      U.toast(`Upload fehlgeschlagen: ${err.message}`, 'err');
    }
  });

  // ---- Canvas =============================================================
  function rebuildCanvas() {
    const canvas = $('ov-canvas');
    canvas.innerHTML = '';
    const o = selOverlay();
    // Der Hintergrund-Blur wirkt auf der Wand (screen.js), war hier aber nie zu
    // sehen – der eingestellte Wert blieb reine Zahl.
    if (o && o.blur > 0) {
      const bl = el('div', 'ov-blurlayer');
      bl.style.backdropFilter = `blur(${o.blur}px)`;
      bl.style.webkitBackdropFilter = `blur(${o.blur}px)`;
      canvas.appendChild(bl);
    }
    if (o) for (const e of o.elements) canvas.appendChild(buildEditEl(e));
    scaleStage();
    renderSelbox();
  }

  // ---- Bühnen-Hintergrund -------------------------------------------------
  // Auf Schwarz sind Transparenz und Blur nicht zu beurteilen; auf der Wand
  // liegt dort echter Inhalt.
  (function buildBgSwitch() {
    const host = $('ov-bg-switch');
    if (!host) return;
    const stage = $('ov-stage');
    const black = btn('Schwarz', 'tiny', () => set(false));
    const karo = btn('Karo', 'tiny', () => set(true));
    function set(checker) {
      stage.classList.toggle('checker', checker);
      // Der aktive Knopf ist der gefüllte, der andere der stille.
      black.classList.toggle('ghost', checker);
      karo.classList.toggle('ghost', !checker);
    }
    host.append(el('span', 'ed-keyhint', 'Hintergrund:'), black, karo);
    set(false);
  })();
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
    // Der Platz kommt jetzt aus dem Layout (.ed-stagewrap), nicht mehr aus der
    // Fensterhöhe – so bestimmt das CSS je Bildschirmbreite, wie groß die Bühne
    // werden darf, statt dass beides gegeneinander rechnet.
    const wrap = stage.parentElement;
    const availW = (wrap.clientWidth || window.innerWidth) - 8;
    const availH = (wrap.clientHeight || window.innerHeight * 0.8) - 8;
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
    flushNudge();
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    // Auswählen erst, wenn nötig: bei gedrückter Zusatztaste entscheidet das
    // Loslassen, sonst würde ein Klick die Mehrfachauswahl vorzeitig ändern.
    if (!additive && !selIds.includes(e.id)) { selectEl(e.id, false); render(); }
    const movers = additive ? [e] : selElements();
    const single = movers.length === 1;
    const sx = ev.clientX, sy = ev.clientY;
    const orig = movers.map((m) => ({ m, x: m.x, y: m.y }));
    // Auswählen und Ziehen waren dieselbe Geste ohne Schwelle: jeder etwas
    // ungenaue Klick hat das Element verschoben. 3 px wie in programm.js.
    let moved = false;
    node.setPointerCapture(ev.pointerId);
    const move = (mv) => {
      if (!moved) {
        if (Math.abs(mv.clientX - sx) <= 3 && Math.abs(mv.clientY - sy) <= 3) return;
        moved = true; dragging = true;
      }
      const dxf = (mv.clientX - sx) / stageW(), dyf = (mv.clientY - sy) / stageH();
      if (single) {
        const snapped = snapMove(clamp01(orig[0].x + dxf, e.w), clamp01(orig[0].y + dyf, e.h), e.w, e.h, e.id);
        e.x = snapped.x; e.y = snapped.y; drawGuides(snapped.guides);
      } else {
        for (const o2 of orig) { o2.m.x = clamp01(o2.x + dxf, o2.m.w); o2.m.y = clamp01(o2.y + dyf, o2.m.h); }
      }
      for (const o2 of orig) { const n = nodeOf(o2.m.id); if (n) styleEditEl(n, o2.m); }
      placeSelboxes();
      syncInspector();     // X/Y im Inspektor liefen beim Ziehen bisher nie mit
    };
    const up = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      // dragging MUSS auf jedem Weg zurückgesetzt werden – bleibt es hängen,
      // nimmt render() dauerhaft den Zweig ohne Canvas-Aktualisierung.
      dragging = false; clearGuides();
      if (!moved) { selectEl(e.id, additive); render(); return; }   // war nur ein Klick
      const o = selOverlay(); if (!o) return;
      for (const o2 of orig) api('PATCH', `/api/overlay/${o.id}/element/${o2.m.id}`, { element: { x: o2.m.x, y: o2.m.y } });
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  // ---- Resize -------------------------------------------------------------
  function startResize(ev, e, dir) {
    ev.preventDefault(); ev.stopPropagation();
    flushNudge();
    const sx = ev.clientX, sy = ev.clientY;
    const o = { x: e.x, y: e.y, w: e.w, h: e.h };
    const node = $('ov-canvas').querySelector(`[data-id="${e.id}"]`);
    const target = ev.target;
    let moved = false;
    target.setPointerCapture(ev.pointerId);
    const move = (m) => {
      if (!moved) {
        if (Math.abs(m.clientX - sx) <= 3 && Math.abs(m.clientY - sy) <= 3) return;
        moved = true; dragging = true;
      }
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
      syncInspector();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      dragging = false;
      if (!moved) return;                  // Griff nur angetippt: nichts senden
      patchEl({ x: e.x, y: e.y, w: e.w, h: e.h });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
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
  $('ov-stage').addEventListener('pointerdown', (ev) => {
    // Anstehende Pfeiltasten-Verschiebung sichern, bevor etwas anderes passiert.
    flushNudge();
    // Sonst bleibt der Fokus nach dem Editieren eines Zahlenfelds dort liegen
    // und die Entf-Taste greift nicht.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (ev.target === $('ov-stage') || ev.target === $('ov-canvas')) { selIds = []; render(); }
  });

  // ---- Tastatur ===========================================================
  // Pfeiltasten verschieben lokal und schreiben gebündelt zurück – sonst
  // entstünde pro Tastendruck ein Request.
  let nudgeTimer = null, nudgeIds = new Set();
  function flushNudge() {
    clearTimeout(nudgeTimer); nudgeTimer = null;
    const o = selOverlay();
    if (!o || !nudgeIds.size) { nudgeIds.clear(); return; }
    for (const id of nudgeIds) {
      const e = o.elements.find((x) => x.id === id);
      if (e) api('PATCH', `/api/overlay/${o.id}/element/${e.id}`, { element: { x: e.x, y: e.y } });
    }
    nudgeIds.clear();
  }
  function nudge(dx, dy) {
    const sel = selElements(); if (!sel.length) return;
    for (const e of sel) {
      e.x = clamp01(e.x + dx, e.w); e.y = clamp01(e.y + dy, e.h);
      const n = nodeOf(e.id); if (n) styleEditEl(n, e);
      nudgeIds.add(e.id);
    }
    placeSelboxes(); syncInspector();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(flushNudge, 300);
  }
  window.addEventListener('beforeunload', flushNudge);

  const isTyping = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  document.addEventListener('keydown', (ev) => {
    // Nicht ins Tippen funken, und Dialoge behalten ihre eigenen Tasten
    // (U.dialog lauscht in der Capture-Phase auf Esc und Tab).
    // Geprüft wird beides: das Ziel des Ereignisses UND wo der Fokus steht –
    // sonst genügt ein umgeleitetes Ereignis, um im Feld zu löschen.
    if (isTyping(ev.target) || isTyping(document.activeElement) || document.querySelector('.modal')) return;
    if (!selOverlay()) return;
    const mod = ev.ctrlKey || ev.metaKey;

    if (mod && (ev.key === 'd' || ev.key === 'D')) { ev.preventDefault(); duplicateSelection(); return; }
    if (mod && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      selIds = selOverlay().elements.map((e) => e.id); render();
      return;
    }
    if (mod) return;

    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelection(); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); selIds = []; render(); return; }

    const step = ev.shiftKey ? 0.02 : 0.0025;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); nudge(-step, 0); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); nudge(step, 0); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); nudge(0, -step); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); nudge(0, step); }
  });
  window.addEventListener('resize', () => { scaleStage(); renderSelbox(); });

  // ---- Bibliothek (wiederverwertbare Vorlagen) ---------------------------
  function renderLibrary() {
    // Reine Liste: das Speichern liegt im Inspektor, also dort, wo die Auswahl
    // ist, die gespeichert werden soll.
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
      const del = U.iconBtn('✕', `Vorlage „${en.name}" löschen`, 'btn tiny danger', async (ev) => {
        ev.stopPropagation();
        const ok = await U.confirmDialog({
          title: 'Vorlage löschen?',
          text: `„${en.name}" wird aus der Bibliothek entfernt. Bereits eingefügte Elemente bleiben erhalten.`,
          confirmLabel: 'Löschen', danger: true
        });
        if (ok) await api('DELETE', `/api/library/${en.id}`);
      });
      row.append(name, tag, ins, del);
      list.appendChild(row);
    });
  }
  async function saveSelectionToLibrary() {
    const sel = selElements(); if (!sel.length) return;
    const strip = (e) => { const c = { ...e }; delete c.id; return c; };
    const single = sel.length === 1;
    const res = await U.promptDialog({
      title: single ? 'Element als Vorlage speichern' : `${sel.length} Elemente als Gruppe speichern`,
      label: 'Name der Vorlage',
      value: single ? elementTitle(sel[0]) : `Gruppe (${sel.length})`,
      confirmLabel: 'Speichern'
    });
    if (!res) return;
    const name = res.value || (single ? 'Vorlage' : `Gruppe (${sel.length})`);
    if (single) await api('POST', '/api/library', { name, kind: 'element', element: strip(sel[0]) });
    else await api('POST', '/api/library', { name, kind: 'group', elements: sel.map(strip) });
  }

  // ---- kleine Helfer ------------------------------------------------------
  // Die Formular-Bausteine (el/hr/field/textInput/…) liegen jetzt in ui.js und
  // werden oben destrukturiert – sie waren hier und in playlists.js doppelt.
  function clamp01(v, size) { return Math.max(0, Math.min(1 - (size || 0), v)); }
})();
