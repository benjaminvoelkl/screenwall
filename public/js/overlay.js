// Willkommens-Overlay als eigene Seite (/overlay). Bearbeitet den Entwurf
// (welcome.*) und zeigt – sobald es Änderungen gibt – einen Go-Live-Button,
// der zur Programm-Timeline führt, wo veröffentlicht wird.

(() => {
  let state = null;
  let curTplSel = null;
  const $ = (id) => document.getElementById(id);

  async function postState(patch) {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
  }
  function setIfNotFocused(el, value) {
    if (!el || document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
  }

  // ---- WebSocket: Entwurf + dirty ----------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/?role=control`);
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') {
          state = msg.state;
          if (typeof msg.dirty === 'boolean') setDirty(msg.dirty);
          render();
        }
      } catch (_) {}
    });
    ws.addEventListener('close', () => setTimeout(connect, 1500));
    ws.addEventListener('error', () => ws.close());
  }
  connect();
  fetch('/api/state').then((r) => r.json()).then((s) => { state = s; render(); });

  // Go Live erscheint nur bei Änderungen; führt zur Programm-Timeline (Veröffentlichen).
  function setDirty(dirty) {
    const btn = $('go-live');
    if (btn) btn.classList.toggle('hidden', !dirty);
  }
  $('go-live').addEventListener('click', () => { location.href = '/programm'; });

  // ---- Overlay-Einstellungen ---------------------------------------------
  $('wc-visible').addEventListener('change', (e) =>
    postState({ welcome: { visible: e.target.checked } }));

  $('wc-template').addEventListener('change', (e) => {
    const v = e.target.value;
    curTplSel = v;
    if (v.startsWith('preset:')) fetch(`/api/welcome/preset/${v.slice(7)}/apply`, { method: 'POST' });
    else if (v.startsWith('style:')) postState({ welcome: { template: v.slice(6) } });
  });
  $('wc-fontsize').addEventListener('input', (e) => {
    $('wc-fontsize-val').textContent = `${e.target.value} vw`;
    postState({ welcome: { fontSize: Number(e.target.value) } });
  });
  $('wc-blur').addEventListener('input', (e) => {
    $('wc-blur-val').textContent = `${e.target.value} px`;
    postState({ welcome: { blur: Number(e.target.value) } });
  });
  $('wc-headline').addEventListener('input', (e) =>
    postState({ welcome: { headline: e.target.value } }));

  for (const side of ['left', 'right']) {
    $(`wc-${side}-text`).addEventListener('input', (e) =>
      postState({ welcome: { [side]: { text: e.target.value } } }));
    $(`wc-${side}-textsize`).addEventListener('input', (e) => {
      $(`wc-${side}-textsize-val`).textContent = `${e.target.value} vw`;
      postState({ welcome: { [side]: { textSize: Number(e.target.value) } } });
    });
    $(`wc-${side}-logosize`).addEventListener('input', (e) => {
      $(`wc-${side}-logosize-val`).textContent = `${e.target.value} vw`;
      postState({ welcome: { [side]: { logoSize: Number(e.target.value) } } });
    });
    enableWcOrder($(`wc-${side}-order`), (parts) =>
      postState({ welcome: { [side]: { logoPos: parts[0] === 'logo' ? 'top' : 'bottom' } } }));
  }

  // Logo-Upload je Seite (eigener Endpoint, speichert Dateiname am welcome-State).
  function bindLogo(side) {
    $(`wc-${side}-logo`).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const fd = new FormData();
      fd.append('side', side);
      fd.append('file', file, file.name || 'logo');
      await fetch('/api/welcome/logo', { method: 'POST', body: fd });
    });
    $(`wc-${side}-logo-del`).addEventListener('click', async () => {
      await fetch('/api/welcome/logo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side })
      });
    });
  }
  bindLogo('left');
  bindLogo('right');

  // Presets
  $('wc-preset-save').addEventListener('click', async () => {
    const n = (state.welcome.presets || []).length + 1;
    const name = prompt('Name der Vorlage:', `Vorlage ${n}`);
    if (name === null) return;
    const r = await fetch('/api/welcome/preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const created = await r.json();
    if (created && created.id) curTplSel = `preset:${created.id}`;
  });
  $('wc-preset-delete').addEventListener('click', () => {
    const v = $('wc-template').value;
    if (!v.startsWith('preset:')) return;
    const id = v.slice(7);
    const p = (state.welcome.presets || []).find((x) => x.id === id);
    if (p && confirm(`Eigene Vorlage „${p.name}" löschen?`)) {
      fetch(`/api/welcome/preset/${id}`, { method: 'DELETE' });
      curTplSel = null;
    }
  });

  function renderTemplateSelect() {
    const sel = $('wc-template');
    if (document.activeElement === sel) return;
    const grp = $('wc-template-presets');
    grp.innerHTML = '';
    const presets = state.welcome.presets || [];
    for (const p of presets) {
      const o = document.createElement('option');
      o.value = `preset:${p.id}`;
      o.textContent = p.name;
      grp.appendChild(o);
    }
    grp.hidden = presets.length === 0;
    let want = curTplSel;
    if (!want || ![...sel.options].some((o) => o.value === want)) {
      want = `style:${state.welcome.template || 'elegant'}`;
    }
    sel.value = want;
    curTplSel = sel.value;
    $('wc-preset-delete').disabled = !sel.value.startsWith('preset:');
  }

  // Mini-Drag&Drop für die zwei Logo/Text-Einträge einer Seite (horizontal).
  function enableWcOrder(container, onChange) {
    let dragging = null;
    container.querySelectorAll('.wc-order-item').forEach((item) => {
      item.addEventListener('dragstart', () => { dragging = item; item.classList.add('dragging'); });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        dragging = null;
        onChange(Array.from(container.children).map((c) => c.dataset.part));
      });
    });
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragging) return;
      const others = [...container.querySelectorAll('.wc-order-item:not(.dragging)')];
      const after = others.find((c) => {
        const box = c.getBoundingClientRect();
        return e.clientX <= box.left + box.width / 2;
      });
      if (after == null) container.appendChild(dragging);
      else container.insertBefore(dragging, after);
    });
  }

  function renderLogoPreview(side, logo) {
    const img = $(`wc-${side}-preview`);
    if (logo) { img.src = `/uploads/${logo}`; img.classList.remove('hidden'); }
    else { img.removeAttribute('src'); img.classList.add('hidden'); }
    $(`wc-${side}-logo-del`).disabled = !logo;
  }
  function renderWcOrder(side, logoPos) {
    const c = $(`wc-${side}-order`);
    const logo = c.querySelector('[data-part="logo"]');
    const text = c.querySelector('[data-part="text"]');
    const first = logoPos === 'bottom' ? text : logo;
    const second = logoPos === 'bottom' ? logo : text;
    c.appendChild(first);
    c.appendChild(second);
  }

  function render() {
    if (!state) return;
    const w = state.welcome;
    setIfNotFocused($('wc-visible'), w.visible);
    renderTemplateSelect();
    setIfNotFocused($('wc-fontsize'), w.fontSize);
    $('wc-fontsize-val').textContent = `${w.fontSize} vw`;
    setIfNotFocused($('wc-blur'), w.blur);
    $('wc-blur-val').textContent = `${w.blur} px`;
    setIfNotFocused($('wc-headline'), w.headline);
    for (const side of ['left', 'right']) {
      const s = w[side];
      setIfNotFocused($(`wc-${side}-text`), s.text);
      setIfNotFocused($(`wc-${side}-textsize`), s.textSize);
      $(`wc-${side}-textsize-val`).textContent = `${s.textSize} vw`;
      setIfNotFocused($(`wc-${side}-logosize`), s.logoSize);
      $(`wc-${side}-logosize-val`).textContent = `${s.logoSize} vw`;
      renderLogoPreview(side, s.logo);
      renderWcOrder(side, s.logoPos);
    }
  }
})();
