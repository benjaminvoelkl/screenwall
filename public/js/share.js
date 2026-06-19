// Publisher-Seite für die Bildschirmfreigabe (/share?s=<sessionId>).
//
// Ablauf: getDisplayMedia() wird GENAU EINMAL aufgerufen; der Capture-Stream
// lebt, solange dieser Tab offen ist. Über das WS-Signaling tritt die Seite der
// Session bei (peerRole 'publisher') und baut pro Wand (Viewer) eine eigene
// RTCPeerConnection auf – der Publisher ist immer der Anbietende (Offer).
// Schließt eine Wand die Verbindung (Inhaltswechsel), bleibt der Stream hier
// erhalten; kommt die Wand zurück, wird einfach eine neue Verbindung aufgebaut –
// ohne erneute Bestätigung im Browser.
(() => {
  const $ = (id) => document.getElementById(id);
  const sessionId = new URLSearchParams(location.search).get('s') || '';
  const RTC_CONFIG = { iceServers: [] }; // LAN: Host-Kandidaten genügen

  const shareBtn = $('shareBtn');
  const stopBtn = $('stopBtn');
  const statusEl = $('status');
  const hintEl = $('hint');
  const preview = $('preview');

  let ws = null;
  let reconnectTimer = null;
  let localStream = null;
  const pcs = new Map(); // viewerId -> RTCPeerConnection

  function setStatus(text, cls) {
    statusEl.innerHTML = `<span class="dot ${cls || ''}"></span>` + text;
  }

  if (!sessionId) {
    setStatus('Kein gültiger Link (Session fehlt).', '');
    shareBtn.disabled = true;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    // Tritt z.B. auf, wenn die Seite NICHT über HTTPS geladen wurde.
    shareBtn.disabled = true;
    setStatus('Bildschirmfreigabe in diesem Browser nicht verfügbar.', '');
    hintEl.textContent = location.protocol !== 'https:'
      ? 'Die Seite muss über HTTPS geöffnet werden (https://…). Bitte den QR-Code/Link von der Wall verwenden und die Zertifikatswarnung einmalig bestätigen.'
      : 'Dieser Browser unterstützt getDisplayMedia nicht.';
  }

  // ---- WebSocket-Signaling (mit Reconnect) -------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/?role=share`);
    ws.addEventListener('open', () => { if (localStream) join(); });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg && msg.type === 'rtc') onRtc(msg);
    });
    ws.addEventListener('close', () => { ws = null; scheduleReconnect(); });
    ws.addEventListener('error', () => { try { ws.close(); } catch (_) {} });
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
  }
  function rtcSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rtc', ...obj }));
  }
  connect();

  function join() {
    rtcSend({ kind: 'join', session: sessionId, peerRole: 'publisher' });
  }

  // ---- Verbindungsaufbau pro Wand (Viewer) -------------------------------
  async function offerTo(viewerId) {
    if (!localStream) return;
    let pc = pcs.get(viewerId);
    if (pc) { try { pc.close(); } catch (_) {} }
    pc = new RTCPeerConnection(RTC_CONFIG);
    pcs.set(viewerId, pc);
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    pc.onicecandidate = (e) => {
      if (e.candidate) rtcSend({ kind: 'ice', session: sessionId, to: viewerId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        if (pcs.get(viewerId) === pc) { try { pc.close(); } catch (_) {} pcs.delete(viewerId); }
        updateStatus();
      } else if (pc.connectionState === 'connected') {
        updateStatus();
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      rtcSend({ kind: 'offer', session: sessionId, to: viewerId, sdp: pc.localDescription });
    } catch (_) { /* ignorieren */ }
  }

  async function onRtc(msg) {
    if (msg.kind === 'peers') {
      // Bereits anwesende Wände → jeder bekommt ein Offer.
      for (const p of (msg.peers || [])) if (p.peerRole === 'viewer') offerTo(p.id);
    } else if (msg.kind === 'join') {
      if (msg.peerRole === 'viewer') offerTo(msg.from);
    } else if (msg.kind === 'answer') {
      const pc = pcs.get(msg.from);
      if (pc) { try { await pc.setRemoteDescription(msg.sdp); } catch (_) {} }
    } else if (msg.kind === 'ice') {
      const pc = pcs.get(msg.from);
      if (pc && msg.candidate) { try { await pc.addIceCandidate(msg.candidate); } catch (_) {} }
    } else if (msg.kind === 'bye') {
      const pc = pcs.get(msg.from);
      if (pc) { try { pc.close(); } catch (_) {} pcs.delete(msg.from); }
      updateStatus();
    }
  }

  function updateStatus() {
    if (!localStream) { setStatus('Bereit', ''); return; }
    const n = [...pcs.values()].filter((pc) => pc.connectionState === 'connected').length;
    if (n > 0) setStatus(`Wird übertragen (${n} Anzeige${n > 1 ? 'n' : ''})`, 'live');
    else setStatus('Teilen aktiv – warte auf die Wall …', 'connecting');
  }

  // ---- Start / Stopp -----------------------------------------------------
  shareBtn.addEventListener('click', async () => {
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (_) {
      setStatus('Freigabe abgebrochen.', '');
      return;
    }
    preview.srcObject = localStream;
    preview.classList.add('on');
    preview.play().catch(() => {});
    shareBtn.style.display = 'none';
    stopBtn.style.display = '';
    hintEl.textContent = 'Du kannst diesen Tab im Hintergrund lassen. Zum Beenden „Teilen beenden“ tippen.';
    // Wenn der Nutzer im Browser-Dialog „Freigabe beenden“ klickt:
    for (const track of localStream.getTracks()) track.onended = stopSharing;
    join();
    updateStatus();
  });

  stopBtn.addEventListener('click', stopSharing);

  function stopSharing() {
    rtcSend({ kind: 'bye', session: sessionId });
    for (const pc of pcs.values()) { try { pc.close(); } catch (_) {} }
    pcs.clear();
    if (localStream) { for (const t of localStream.getTracks()) t.stop(); localStream = null; }
    preview.srcObject = null;
    preview.classList.remove('on');
    shareBtn.style.display = '';
    stopBtn.style.display = 'none';
    hintEl.textContent = '';
    setStatus('Bereit', '');
  }

  window.addEventListener('pagehide', () => { try { stopSharing(); } catch (_) {} });
})();
