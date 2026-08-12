// ui.js – gemeinsames UI-Fundament aller Steuer-Seiten (kein Build-Step, IIFE).
//
// Bündelt, was vorher pro Seite kopiert war: WebSocket-Verbindung, API-Aufrufe,
// Slide-to-confirm-Gestik und die kleinen Formular-Bausteine. Ersetzt außerdem
// alle nativen alert()/confirm()/prompt()-Dialoge durch eigene, gestaltete
// Dialoge und quittiert Speichern sichtbar (Toast) statt stillschweigend.
//
// Nutzung: <script src="/js/ui.js"></script> VOR dem Seiten-Skript einbinden.

(() => {
  const $ = (id) => document.getElementById(id);

  // ===== kleine DOM-Bausteine ==============================================
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function hr() {
    const h = el('div');
    h.style.borderTop = '1px solid var(--border)';
    h.style.margin = '10px 0';
    return h;
  }
  function field(label, input) {
    const f = el('label');
    f.appendChild(document.createTextNode(label));
    f.appendChild(input);
    return f;
  }
  function textInput(v, onChange) {
    const i = el('input'); i.type = 'text'; i.value = v || '';
    if (onChange) i.addEventListener('change', () => onChange(i.value));
    return i;
  }
  function textArea(v, onChange) {
    const t = el('textarea'); t.rows = 2; t.value = v || '';
    if (onChange) t.addEventListener('change', () => onChange(t.value));
    return t;
  }
  function numInput(v, min, max, step, onChange) {
    const i = el('input');
    i.type = 'number'; i.min = min; i.max = max; i.step = step == null ? 1 : step; i.value = v;
    if (onChange) i.addEventListener('change', () => {
      const n = i.value === '' ? min : Number(i.value);
      onChange(Math.max(min, Math.min(max, n)));
    });
    return i;
  }
  function colorInput(v, onChange) {
    const i = el('input'); i.type = 'color'; i.value = v || '#000000';
    if (onChange) i.addEventListener('change', () => onChange(i.value));
    return i;
  }
  function checkboxInput(v, onChange) {
    const i = el('input'); i.type = 'checkbox'; i.checked = !!v;
    if (onChange) i.addEventListener('change', () => onChange(i.checked));
    return i;
  }
  function rangeInput(v, min, max, step, onChange) {
    const i = el('input');
    i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = v;
    if (onChange) i.addEventListener('change', () => onChange(Number(i.value)));
    return i;
  }
  function selectInput(opts, value, onChange) {
    const s = el('select');
    for (const [v, label] of opts) {
      const o = el('option', null, label); o.value = v; s.appendChild(o);
    }
    s.value = value;
    if (onChange) s.addEventListener('change', () => onChange(s.value));
    return s;
  }
  function btn(label, cls, onClick) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // Icon-Button: Beschriftung ist nur ein Zeichen, daher IMMER aria-label + title.
  function iconBtn(glyph, label, cls, onClick) {
    const b = el('button', cls || '', glyph);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  // Checkbox mit Beschriftung rechts (label.checkbox aus base.css).
  function checkboxRow(label, checked, onChange) {
    const l = el('label', 'checkbox');
    l.appendChild(checkboxInput(checked, onChange));
    l.appendChild(el('span', null, label));
    return l;
  }

  // ===== Toasts ============================================================
  // Quittieren jede gespeicherte Änderung. aria-live, damit Screenreader es hören.
  let toastRegion = null;
  function region() {
    if (toastRegion) return toastRegion;
    toastRegion = el('div', 'toast-region');
    toastRegion.setAttribute('aria-live', 'polite');
    toastRegion.setAttribute('aria-atomic', 'false');
    document.body.appendChild(toastRegion);
    return toastRegion;
  }
  function toast(msg, kind = 'ok', ms = 2200) {
    const t = el('div', 'toast ' + kind, msg);
    region().appendChild(t);
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 300);
    }, ms);
    return t;
  }
  // Gebündeltes "Gespeichert": ein Drag/Slider löst EINEN Toast aus, nicht zwanzig.
  let savedTimer = null;
  function saved(msg = 'Gespeichert') {
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => toast(msg, 'ok'), 300);
  }

  // ===== API ===============================================================
  // Prüft im Gegensatz zur alten Kopie den Status und macht Serverfehler sichtbar,
  // statt sie stillschweigend zu verschlucken.
  async function api(method, url, body, opts = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res, data;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (!opts.quiet) toast('Keine Verbindung zum Server', 'err', 4000);
      throw e;
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.error)) {
      const msg = (data && data.error) || `Fehler ${res.status}`;
      if (!opts.quiet) toast(msg, 'err', 4000);
      const err = new Error(msg); err.data = data; err.status = res.status;
      throw err;
    }
    if (opts.saved) saved(typeof opts.saved === 'string' ? opts.saved : undefined);
    return data;
  }
  // Speichern + quittieren in einem Aufruf (der Normalfall bei Bearbeitungen).
  const save = (method, url, body) => api(method, url, body, { saved: true });

  // ===== Dialog ============================================================
  // Ein Modal-Helfer mit Esc, Backdrop-Klick und Fokus-Falle. Ersetzt die
  // handgeschriebenen hidden-Umschaltungen und alle nativen Browser-Dialoge.
  let openDialogs = 0;
  function dialog({ title, body, actions = [], wide = false, onClose } = {}) {
    const back = el('div', 'modal');
    const box = el('div', 'modal-box' + (wide ? ' wide' : ''));
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    if (title) {
      const h = el('h3', null, title);
      h.id = 'dlg-title-' + (++openDialogs);
      box.setAttribute('aria-labelledby', h.id);
      box.appendChild(h);
    }
    if (body) box.appendChild(body);

    const bar = el('div', 'modal-actions');
    const handle = { close, box, back };
    for (const a of actions) {
      if (a === 'spacer') { const s = el('span', 'spacer'); bar.appendChild(s); continue; }
      // Ohne cls ist die Aktion die primäre (blau); Abbrechen bekommt 'ghost'.
      const b = btn(a.label, a.cls == null ? '' : a.cls, () => a.onClick && a.onClick(handle));
      if (a.id) b.id = a.id;
      if (a.disabled) b.disabled = true;
      bar.appendChild(b);
    }
    if (actions.length) box.appendChild(bar);

    back.appendChild(box);
    document.body.appendChild(back);

    const prevFocus = document.activeElement;
    const focusables = () => Array.from(box.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((n) => n.offsetParent !== null);

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    function onBackdrop(e) { if (e.target === back) close(); }
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      back.removeEventListener('click', onBackdrop);
      back.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose();
    }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', onBackdrop);

    // Ersten sinnvollen Fokus setzen (Eingabefeld vor Button).
    const firstInput = box.querySelector('input:not([type="checkbox"]), textarea, select');
    (firstInput || focusables()[0] || box).focus();
    if (firstInput && firstInput.select) firstInput.select();

    return handle;
  }

  // Bestätigung statt confirm(). Auflösung: true = bestätigt.
  function confirmDialog({ title, text, confirmLabel = 'OK', cancelLabel = 'Abbrechen', danger = false } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const body = el('div');
      if (text) body.appendChild(el('p', 'modal-hint', text));
      const d = dialog({
        title,
        body,
        actions: [
          { label: cancelLabel, cls: 'ghost', onClick: (h) => h.close() },
          { label: confirmLabel, cls: danger ? 'danger' : '', onClick: (h) => { done = true; h.close(); resolve(true); } }
        ],
        onClose: () => { if (!done) resolve(false); }
      });
      // Bestätigungsschaltfläche vorfokussieren, damit Enter direkt bestätigt.
      const bs = d.box.querySelectorAll('.modal-actions .btn');
      if (bs.length) bs[bs.length - 1].focus();
    });
  }

  // Texteingabe statt prompt(). Auflösung: { value, ...extras } oder null.
  // extraFields: [{ key, label, input }] – z. B. eine Farbwahl neben dem Namen.
  function promptDialog({ title, label = 'Name', value = '', placeholder = '',
                         confirmLabel = 'Speichern', extraFields = [] } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const body = el('div', 'dlg-fields');
      const input = textInput(value);
      input.placeholder = placeholder;
      body.appendChild(field(label, input));
      for (const f of extraFields) body.appendChild(field(f.label, f.input));

      const finish = (h) => {
        const out = { value: input.value.trim() };
        for (const f of extraFields) out[f.key] = f.input.type === 'checkbox' ? f.input.checked : f.input.value;
        done = true; h.close(); resolve(out);
      };
      const d = dialog({
        title,
        body,
        actions: [
          { label: 'Abbrechen', cls: 'ghost', onClick: (h) => h.close() },
          { label: confirmLabel, onClick: finish }
        ],
        onClose: () => { if (!done) resolve(null); }
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(d); } });
    });
  }

  // ===== Überlauf-Menü (⋯) =================================================
  // Sekundäraktionen bündeln, damit je Objekt nur zwei Schaltflächen sichtbar sind.
  // items: [{ label, onClick, danger?, disabled?, title? }] oder 'sep'
  function overflowMenu(items, { label = 'Weitere Aktionen', glyph = '⋯', btnCls = 'menu-btn' } = {}) {
    const wrap = el('span', 'menu-wrap');
    const b = iconBtn(glyph, label, btnCls);
    b.setAttribute('aria-haspopup', 'true');
    b.setAttribute('aria-expanded', 'false');
    const list = el('div', 'menu-list hidden');
    list.setAttribute('role', 'menu');

    for (const it of items) {
      if (it === 'sep') { list.appendChild(el('div', 'menu-sep')); continue; }
      const mi = el('button', 'menu-item' + (it.danger ? ' danger' : ''), it.label);
      mi.type = 'button';
      mi.setAttribute('role', 'menuitem');
      if (it.title) mi.title = it.title;
      if (it.disabled) mi.disabled = true;
      else mi.addEventListener('click', () => { closeMenu(); it.onClick && it.onClick(); });
      list.appendChild(mi);
    }

    function openMenu() {
      list.classList.remove('hidden');
      b.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
      const first = list.querySelector('.menu-item:not([disabled])');
      if (first) first.focus();
    }
    function closeMenu() {
      list.classList.add('hidden');
      b.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function onDocClick(e) { if (!wrap.contains(e.target)) closeMenu(); }
    function onEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); b.focus(); } }

    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (list.classList.contains('hidden')) openMenu(); else closeMenu();
    });
    wrap.append(b, list);
    return wrap;
  }

  // ===== Einklappbarer Abschnitt ===========================================
  // Gruppiert Formularfelder, damit lange Feldlisten (Overlay-Inspektor) und
  // selten gebrauchte Felder ("Weitere Optionen" auf /playlists) nicht alles
  // auf einmal zeigen. Basis ist natives <details>: Tastatur- und
  // Screenreader-Verhalten gibt es damit geschenkt.
  //
  // Der Auf-/Zu-Zustand liegt bewusst NEBEN dem DOM: die Seiten bauen ihre
  // Panels bei jedem Server-Push neu auf, ein Zustand im Element selbst wäre
  // danach weg. Über `key` findet der Abschnitt seinen Zustand wieder.
  const sectionOpen = new Map();
  function section({ key, title, note, open = true, body } = {}) {
    const d = el('details', 'sect');
    const sum = el('summary');
    sum.appendChild(el('span', 'sect-title', title || ''));
    if (note) sum.appendChild(el('span', 'sect-note', note));
    d.appendChild(sum);

    const inner = el('div', 'sect-body');
    if (body) inner.appendChild(body);
    d.appendChild(inner);

    d.open = key && sectionOpen.has(key) ? sectionOpen.get(key) : !!open;
    if (key) d.addEventListener('toggle', () => sectionOpen.set(key, d.open));
    return d;
  }

  // ===== Slide-to-confirm ==================================================
  // Eine Implementierung für alle drei Einsatzorte (Go Live, Playlist abspielen,
  // Sendung stoppen). Erwartet die Struktur aus base.css:
  //   .slide-confirm > .slide-fill + .slide-label + .slide-handle
  function buildSlide({ label, glyph = '▶', danger = false } = {}) {
    const root = el('div', 'slide-confirm' + (danger ? ' danger' : ''));
    root.append(
      el('div', 'slide-fill'),
      el('span', 'slide-label', label),
      el('div', 'slide-handle', glyph)
    );
    return root;
  }
  function bindSlide(root, onDone) {
    const fill = root.querySelector('.slide-fill');
    const handle = root.querySelector('.slide-handle');
    let x = 0, sliding = false, done = false, startX = 0, startX0 = 0;
    const travel = () => root.clientWidth - handle.offsetWidth - 8;
    function set(v) {
      x = Math.max(0, Math.min(travel(), v));
      handle.style.transform = `translateX(${x}px)`;
      fill.style.width = `${x + handle.offsetWidth}px`;
    }
    function reset() { done = false; sliding = false; handle.style.transition = ''; set(0); }
    function fire() {
      if (done) return;
      done = true; set(travel());
      onDone(reset);
    }
    handle.addEventListener('pointerdown', (e) => {
      if (done) return;
      sliding = true; startX = e.clientX; startX0 = x;
      handle.style.transition = 'none';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => { if (sliding) set(startX0 + (e.clientX - startX)); });
    const end = () => {
      if (!sliding) return;
      sliding = false;
      handle.style.transition = 'transform 0.2s ease';
      if (x >= travel() * 0.95) fire(); else set(0);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // Tastatur-/Screenreader-Ersatz für die Ziehgeste.
    handle.tabIndex = 0;
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', root.querySelector('.slide-label').textContent + ' (Leertaste zum Bestätigen)');
    handle.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(); }
    });
    return { reset, refresh: () => set(done ? travel() : x) };
  }

  // ===== WebSocket-Zustand =================================================
  // Ersetzt sechs fast identische connect()-Implementierungen.
  function connectState({ onState, onCmd, onConn, onDirty, onOffair } = {}) {
    let ws = null;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/?role=control`);
      ws.addEventListener('open', () => onConn && onConn(true));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'state') {
          if (typeof msg.dirty === 'boolean' && onDirty) onDirty(msg.dirty);
          if (typeof msg.offair === 'boolean' && onOffair) onOffair(msg.offair);
          if (onState) onState(msg.state, msg);
        } else if (msg.type === 'cmd' && onCmd) {
          onCmd(msg);
        }
      });
      ws.addEventListener('close', () => { onConn && onConn(false); setTimeout(connect, 1500); });
      ws.addEventListener('error', () => ws.close());
    }
    connect();
    return {
      send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
    };
  }
  // Verbindungsanzeige in der Fußzeile (überall identisch aufgebaut).
  function bindConnDot() {
    return (on) => {
      const dot = $('conn-dot'), txt = $('conn-text');
      if (dot) dot.classList.toggle('on', on);
      if (txt) txt.textContent = on ? 'verbunden' : 'getrennt – verbinde neu…';
    };
  }

  // ===== Hauptnavigation ===================================================
  // EINE Navigation für alle Steuer-Seiten. Ersetzt die früheren, pro Seite
  // unterschiedlichen back-links, nav-btns und den schwebenden Overlay-Button.
  const NAV = [
    { key: 'monitor',   href: '/',          label: 'Monitor',   glyph: '🖥' },
    { key: 'programm',  href: '/programm',  label: 'Programm',  glyph: '🎬' },
    { key: 'playlists', href: '/playlists', label: 'Playlists', glyph: '📃' },
    { key: 'overlay',   href: '/overlay',   label: 'Overlays',  glyph: '✦' },
    { key: 'docs',      href: '/docs',      label: 'Hilfe',     glyph: '📖' }
  ];
  function topbarNav(active, mountId = 'topnav') {
    const nav = $(mountId);
    if (!nav) return;
    nav.innerHTML = '';
    nav.setAttribute('aria-label', 'Hauptnavigation');
    for (const item of NAV) {
      const a = el('a');
      a.href = item.href;
      a.innerHTML = `<span aria-hidden="true">${item.glyph}</span><span>${item.label}</span>`;
      if (item.key === active) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    }
  }

  // ===== Entwurfs-Leiste ===================================================
  // Zeigt dauerhaft, dass gespeicherte Änderungen noch NICHT auf der Wand sind.
  // Auf /programm öffnet sie die Vorschau + Slide-Bestätigung, sonst führt sie
  // dorthin – es bleibt genau ein Weg auf die Wand.
  function draftBar({ mountId = 'draftbar', onPublish } = {}) {
    const host = $(mountId);
    if (!host) return { update() {} };
    host.className = 'draftbar hidden';

    const text = el('span', 'draftbar-text');
    text.append(el('span', 'draftbar-dot'), el('span', null, 'Entwurf – nicht veröffentlicht'));

    // Auf /programm liegt die Vorschau + Slide-Bestätigung auf derselben Seite;
    // von den anderen Editoren führt der Weg dorthin. So bleibt es EIN Weg auf die Wand.
    let action;
    if (onPublish) {
      action = el('button', 'go-live', 'Preview & Go Live');
      action.type = 'button';
      action.title = 'Entwurf ansehen und auf die Wand veröffentlichen';
      action.addEventListener('click', () => onPublish());
    } else {
      action = el('a', 'go-live', 'Preview & Go Live →');
      action.href = '/programm';
      action.title = 'Zur Programm-Timeline: Vorschau ansehen und veröffentlichen';
    }
    host.append(text, action);

    // dirty = es gibt unveröffentlichte Änderungen; show = Schaltfläche trotzdem
    // anzeigen (z. B. weil der Playhead verschoben wurde und man ab dort live gehen will).
    return {
      update({ dirty = false, show = false } = {}) {
        host.classList.toggle('hidden', !(dirty || show));
        text.classList.toggle('hidden', !dirty);
        action.classList.toggle('pending', !!dirty);
      },
      action
    };
  }

  // ===== Utils =============================================================
  function fmtClock(s) {
    s = Math.max(0, Math.floor(s || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  // Wert setzen, ohne den Nutzer beim Tippen zu unterbrechen.
  function setIfNotFocused(elm, value) {
    if (!elm || document.activeElement === elm) return;
    if (elm.type === 'checkbox') elm.checked = value;
    else elm.value = value;
  }
  function normalizeUrl(input) {
    let s = (input || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s).href; } catch (_) { return ''; }
  }
  function parseYoutubeId(input) {
    const s = (input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/(?:v=|\/embed\/|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  // ===== Lautstärke der Wand ==============================================
  // Dieselbe Leiste steckt in drei Fußzeilen – die Logik jetzt nur noch einmal.
  function bindVolume({ range = 'vol-range', val = 'vol-val', mute = 'vol-mute' } = {}) {
    const r = $(range), v = $(val), m = $(mute);
    if (!r) return;
    let lastSent = 0;
    const show = (d) => {
      if (d && typeof d.level === 'number') {
        const pct = Math.round(d.level * 100);
        if (document.activeElement !== r) r.value = pct;
        v.textContent = pct + '%';
      } else if (v) { v.textContent = '–'; }
      if (m && d && d.muted !== undefined) {
        m.textContent = d.muted ? '🔇' : '🔊';
        m.setAttribute('aria-label', d.muted ? 'Ton einschalten' : 'Stummschalten');
      }
    };
    const post = async (payload) => {
      try { show(await api('POST', '/api/volume', payload, { quiet: true })); } catch (_) {}
    };
    r.addEventListener('input', () => {
      const pct = Number(r.value);
      if (v) v.textContent = pct + '%';
      const now = performance.now();
      if (now - lastSent > 120) { post({ level: pct / 100 }); lastSent = now; }
    });
    r.addEventListener('change', () => post({ level: Number(r.value) / 100 }));
    if (m) m.addEventListener('click', () => post({ mute: 'toggle' }));
    api('GET', '/api/volume', undefined, { quiet: true })
      .then(show)
      .catch(() => { if (v) v.textContent = '–'; r.disabled = true; });
  }

  window.UI = {
    $, el, hr, field, textInput, textArea, numInput, colorInput, checkboxInput,
    rangeInput, selectInput, btn, iconBtn, checkboxRow,
    toast, saved, api, save,
    dialog, confirmDialog, promptDialog, overflowMenu, section,
    buildSlide, bindSlide,
    connectState, bindConnDot, topbarNav, draftBar, bindVolume,
    fmtClock, escapeHtml, setIfNotFocused, normalizeUrl, parseYoutubeId
  };
})();
