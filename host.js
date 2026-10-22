// HOST — the player. Shares his screen + sound, receives the Operator's commands
// and writes them into the game through the CoopOperator mod.

const Host = (() => {
  let settings = null;
  let stream = null;
  let peer = null;
  let guest = null;      // the Operator's data connection
  let call = null;       // the video call to the Operator
  let roomCode = null;
  let recentCmds = [];   // simple flood guard
  let stateTimer = null;
  let lastStateJson = '';
  let lastState = null;  // his deck + RAM, as reported by the mod
  let lastHeartbeat = 0;

  // ---------- UI helpers ----------

  function setStatus(text, cls = '') {
    const el = $('host-status');
    el.textContent = text;
    el.className = 'status ' + cls;
  }

  function log(kind, text) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t"></span><span class="${kind}"></span>`;
    li.querySelector('.t').textContent = timeStamp();
    li.querySelector(`.${kind}`).textContent = text;
    $('host-log').prepend(li);
    while ($('host-log').children.length > 60) $('host-log').lastChild.remove();
  }

  async function refreshGame() {
    const s = await window.neural.gameStatus();
    $('game-folder').textContent = s.gameFolder || 'Not found — choose it';
    $('game-folder').className = 'value ' + (s.gameFolder ? '' : 'bad');
    $('cet-status').textContent = !s.gameFolder ? '—' : s.cetInstalled ? 'Installed' : 'Not installed — click Install / Update';
    $('cet-status').className = 'value ' + (s.cetInstalled ? 'ok' : 'bad');
    $('reds-status').textContent = !s.gameFolder ? '—' : s.redscriptInstalled ? 'Installed' : 'Not installed — click Install / Update';
    $('reds-status').className = 'value ' + (s.redscriptInstalled ? 'ok' : 'bad');
    $('mod-status').textContent = !s.gameFolder ? '—' : s.modInstalled ? 'Installed' : 'Not installed — click Install / Update';
    $('mod-status').className = 'value ' + (s.modInstalled ? 'ok' : 'bad');
    $('install-mod').disabled = !s.gameFolder;
    return s;
  }

  let sourcesLoading = false;
  let sourcesTimer = null;

  async function loadSources() {
    if (sourcesLoading) return;
    sourcesLoading = true;
    let list;
    try {
      list = await window.neural.captureSources();
    } finally {
      sourcesLoading = false;
    }
    const box = $('sources');
    box.innerHTML = '';
    let selectedId = settings.captureSourceId;
    if (!list.some((s) => s.id === selectedId)) {
      // Prefer a window called "Cyberpunk 2077", else the first screen
      selectedId = (list.find((s) => /cyberpunk/i.test(s.name)) || list.find((s) => s.id.startsWith('screen:')) || list[0])?.id;
      if (selectedId) settings = await window.neural.saveSettings({ captureSourceId: selectedId });
    }
    for (const src of list) {
      const btn = document.createElement('button');
      btn.className = 'source' + (src.id === selectedId ? ' selected' : '');
      btn.innerHTML = '<img alt=""><span></span>';
      btn.querySelector('img').src = src.thumbnail;
      btn.querySelector('span').textContent = src.name;
      btn.addEventListener('click', async () => {
        settings = await window.neural.saveSettings({ captureSourceId: src.id });
        box.querySelectorAll('.source').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
      box.appendChild(btn);
    }
  }

  // ---------- streaming ----------

  async function capture() {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: settings.frameRate, max: settings.frameRate } },
      audio: settings.shareAudio,
    });
    const video = s.getVideoTracks()[0];
    if (video) video.contentHint = 'motion';   // favor smooth motion over sharp text
    return s;
  }

  // Raise the video bitrate once the connection is ready
  async function tuneQuality(mediaCall) {
    for (let i = 0; i < 30; i++) {
      const pc = mediaCall.peerConnection;
      const sender = pc?.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        try {
          const p = sender.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = settings.maxBitrateMbps * 1_000_000;
          p.encodings[0].maxFramerate = settings.frameRate;
          p.degradationPreference = 'maintain-framerate';
          await sender.setParameters(p);
          return;
        } catch { /* not negotiated yet */ }
      }
      await sleep(500);
    }
  }

  function openRoom() {
    roomCode = randomCode();
    peer = new Peer(ROOM_PREFIX + roomCode, { config: iceConfig(settings) });

    peer.on('open', () => {
      $('room-code').textContent = roomCode;
      $('room-idle').hidden = true;
      $('room-live').hidden = false;
      setStatus('Waiting for Peri…', 'warn');
    });

    peer.on('connection', (conn) => {
      if (guest && guest.open) {
        // Let Peri back in if it's the same Operator reconnecting (e.g. the app was closed),
        // or if the old connection has gone quiet (no heartbeat for 6 s).
        const sameOperator = conn.metadata?.operatorId && conn.metadata.operatorId === guest.metadata?.operatorId;
        const stale = Date.now() - lastHeartbeat > 6000;
        if (!sameOperator && !stale) {
          conn.on('open', () => { conn.send({ type: 'busy' }); setTimeout(() => conn.close(), 500); });
          return;
        }
        dropGuest('Peri reconnecting…');
      }
      guest = conn;
      lastHeartbeat = Date.now();
      conn.on('open', () => {
        setStatus('Peri jacked in', 'live');
        log('act', 'Peri connected');
        call = peer.call(conn.peer, stream);
        tuneQuality(call);
        if (lastState) conn.send({ type: 'state', state: lastState });
      });
      conn.on('data', (msg) => { if (conn === guest) onData(msg); });   // ignore old connections
      conn.on('close', () => {
        if (guest !== conn) return;
        dropGuest('Peri disconnected');
      });
    });

    peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {   // code already taken: pick another
        peer.destroy();
        openRoom();
        return;
      }
      setStatus('Error: ' + err.type, 'warn');
      console.warn(err);
    });
  }

  function dropGuest(reason) {
    const old = guest;
    guest = null;
    if (call) { call.close(); call = null; }
    if (old) { try { old.close(); } catch { /* already gone */ } }
    setStatus('Waiting for Peri…', 'warn');
    log('act', reason);
  }

  // ---------- commands from the Operator ----------

  async function onData(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hb') {               // latency check + "still here"
      lastHeartbeat = Date.now();
      guest?.send({ type: 'hb', t: msg.t });
      return;
    }
    if (msg.type !== 'cmd') return;

    // Flood guard: at most 8 commands per second
    const now = Date.now();
    recentCmds = recentCmds.filter((t) => now - t < 1000);
    if (recentCmds.length >= 8) return;
    recentCmds.push(now);

    const { cmd } = msg;
    const command = { cmd };
    if (cmd === 'say') {
      command.text = String(msg.text || '').slice(0, 220);
      command.name = String(msg.name || 'PeriBot').slice(0, 20);
      command.icon = String(msg.icon || '');
      if (!command.text.trim()) return;
    } else if (cmd === 'ult') {
      // nothing to check
    } else if (cmd === 'ulthack' || cmd === 'ultmenu') {
      command.id = String(msg.id || '').slice(0, 40);
      if (cmd === 'ulthack') {
        command.slot = Number(msg.slot);
        if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot > 7) return;
      }
    } else if (cmd === 'focus') {
      command.on = !!msg.on;
    } else if (cmd === 'pick') {
      command.seq = Number(msg.seq);
      command.index = Number(msg.index);
      command.title = String(msg.title || '').slice(0, 60);
    } else if (cmd === 'menuclose') {
      // nothing to check
    } else if (cmd === 'hack' || cmd === 'ping' || cmd === 'menu') {
      const x = Number(msg.x), y = Number(msg.y);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
      command.x = x; command.y = y;
      if (cmd === 'hack') {
        command.slot = Number(msg.slot);
        if (!Number.isInteger(command.slot) || command.slot < 0 || command.slot > 7) return;
      }
    } else {
      return;
    }

    const ok = await window.neural.sendToGame(command);
    guest?.send({ type: 'ack', cmd, ok });

    if (cmd === 'say') log('say', `${command.name}: ${command.text}`);
    else if (cmd === 'ping') log('act', 'Ping');
    else if (cmd === 'menu') log('act', 'Scanning…');
    else if (cmd === 'ult') log('act', 'OVERRIDE');
    else if (cmd === 'ulthack') log('act', `OVERRIDE hack: ${lastState?.deck?.[command.slot]?.name || 'slot ' + (command.slot + 1)}`);
    else if (cmd === 'ultmenu') log('act', 'OVERRIDE scan');
    else if (cmd === 'pick') log('act', `Hack: ${command.title}`);
    else if (cmd === 'focus') { if (command.on) log('act', 'Focus'); }
    else if (cmd === 'menuclose') { /* quiet */ }
    else log('act', `Hack: ${lastState?.deck?.[command.slot]?.name || 'slot ' + (command.slot + 1)}`);
    if (!ok) log('act', '⚠ could not reach the mod — check the game folder');
  }

  // ---------- his deck/RAM -> Peri ----------

  async function pollState() {
    const state = await window.neural.gameState();
    if (!state) return;
    const json = JSON.stringify(state);
    if (json === lastStateJson) return;
    lastStateJson = json;
    lastState = state;
    if (guest?.open) guest.send({ type: 'state', state });
  }

  function applyVirtual() {
    window.neural.sendToGame({ cmd: 'virtual', on: !!settings.virtualDeck });
  }

  function applyLock() {
    // Ticked "Only Peri can hack" = the host can't
    window.neural.sendToGame({ cmd: 'lock', allowed: !!settings.hostCanHack });
  }

  // ---------- public ----------

  // Keep the list fresh while choosing (new windows like Cyberpunk appear by themselves).
  // Stops while a room is live so the picker doesn't flicker.
  function watchSources() {
    clearInterval(sourcesTimer);
    sourcesTimer = setInterval(() => {
      if (!$('view-host').classList.contains('active')) { clearInterval(sourcesTimer); return; }
      if (!stream) loadSources();
    }, 4000);
  }

  async function enter() {
    settings = await window.neural.getSettings();
    $('share-audio').checked = settings.shareAudio;
    $('only-peri').checked = !settings.hostCanHack;
    $('virtual-deck').checked = !!settings.virtualDeck;
    await refreshGame();
    await loadSources();
    watchSources();
  }

  async function start() {
    const game = await refreshGame();
    if (!game.gameFolder) { setStatus('Choose the game folder first', 'warn'); return; }

    $('start-host').disabled = true;
    try {
      stream = await capture();
    } catch (err) {
      setStatus('Could not capture the screen', 'warn');
      console.warn(err);
      $('start-host').disabled = false;
      return;
    }
    $('host-preview').srcObject = stream;
    applyLock();
    applyVirtual();
    clearInterval(stateTimer);
    stateTimer = setInterval(pollState, 400);
    openRoom();
    $('start-host').disabled = false;
  }

  function stop() {
    if (call) call.close();
    if (guest) guest.close();
    if (peer) peer.destroy();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    clearInterval(stateTimer);
    call = guest = peer = stream = null;
    $('host-preview').srcObject = null;
    $('room-idle').hidden = false;
    $('room-live').hidden = true;
    setStatus('Offline');
  }

  // ---------- wiring ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('pick-folder').addEventListener('click', async () => { await window.neural.pickGameFolder(); refreshGame(); });
    $('install-mod').addEventListener('click', async () => {
      const btn = $('install-mod'), status = $('update-status');
      btn.disabled = true;
      btn.textContent = 'Updating…';
      const res = await window.neural.runUpdate(true);
      btn.textContent = 'Install / Update';
      btn.disabled = false;
      if (res.restarting) {
        showUpdateStatus(status, `Updating NeuralLink to ${res.version}… it will reopen and finish by itself`, 'busy');
        return;
      }
      if (res.ok) {
        showUpdateStatus(status, `✓ Updated — ${describeUpdate(res)}`, 'ok');
        setStatus('Updated — start Cyberpunk', 'live');
        log('act', `Updated: ${describeUpdate(res)}`);
      } else {
        showUpdateStatus(status, 'Update failed: ' + res.error, 'warn');
        setStatus('Update failed', 'warn');
      }
      refreshGame();
    });
    $('virtual-deck').addEventListener('change', async (e) => {
      settings = await window.neural.saveSettings({ virtualDeck: e.target.checked });
      applyVirtual();
      log('act', e.target.checked ? 'Experimental: Peri\'s own cyberdeck ON' : 'Experimental cyberdeck OFF');
    });
    $('only-peri').addEventListener('change', async (e) => {
      settings = await window.neural.saveSettings({ hostCanHack: !e.target.checked });
      applyLock();
      log('act', e.target.checked ? 'Only Peri can hack' : 'Host can hack too');
    });
    $('share-audio').addEventListener('change', async (e) => {
      settings = await window.neural.saveSettings({ shareAudio: e.target.checked });
    });
    $('start-host').addEventListener('click', start);
    $('stop-host').addEventListener('click', stop);
    $('copy-code').addEventListener('click', () => navigator.clipboard.writeText(roomCode || ''));
    $('refresh-sources').addEventListener('click', () => loadSources());
  });

  return { enter, stop };
})();
