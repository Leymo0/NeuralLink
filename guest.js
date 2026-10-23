// GUEST — the Operator. Joins a room, watches the host's game, and sends
// hacks / pings / slow-mo / messages with mouse + keyboard.

const Guest = (() => {
  let settings = null;
  let peer = null;
  let conn = null;
  let code = null;
  let selected = 0;            // selected hack slot (0-based) for left-click
  let state = null;            // his deck + RAM, from the host
  let lastResultSeq = null;
  let mouse = { x: 0, y: 0 };
  let hbTimer = null;
  let fadeTimer = null;
  let listeningFor = null;   // keybind being changed
  let connectTimeout = null;

  const ACTIONS = [
    ...Array.from({ length: MAX_SLOTS }, (_, i) => [`slot${i + 1}`, `Hack slot ${i + 1}`]),
    ['focus', 'Focus (hold)'],
    ['ping', 'Ping'],
    ['ult', 'Ultimate (Override)'],
    ['chat', 'Talk'],
    ['fullscreen', 'Fullscreen'],
  ];

  const keyLabel = (k) => (k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k);

  // ---------- keybinds ----------

  function renderKeybinds() {
    const box = $('keybinds');
    box.innerHTML = '';
    for (const [action, label] of ACTIONS) {
      const name = document.createElement('span');
      name.textContent = label;
      const btn = document.createElement('button');
      btn.textContent = listeningFor === action ? 'press a key…' : keyLabel(settings.keybinds[action]);
      btn.classList.toggle('listening', listeningFor === action);
      btn.addEventListener('click', () => { listeningFor = action; renderKeybinds(); });
      box.append(name, btn);
    }
    // Keys shown on the in-game console
    document.querySelectorAll('[data-key]').forEach((b) => { b.textContent = keyLabel(settings.keybinds[b.dataset.key]); });
    renderHackBar();
  }

  async function captureKeybind(e) {
    if (!listeningFor) return false;
    e.preventDefault();
    if (e.key !== 'Escape') {
      const keybinds = { ...settings.keybinds, [listeningFor]: e.key };
      settings = await window.neural.saveSettings({ keybinds });
    }
    listeningFor = null;
    renderKeybinds();
    return true;
  }

  // ---------- profile (name + icon he sees) ----------

  const iconSrc = (id) => `assets/icons/${id}.png`;

  function renderProfile() {
    const name = settings.operatorName || 'PeriBot';
    const icon = settings.operatorIcon || 'peri2';
    if (document.activeElement !== $('op-name')) $('op-name').value = name;
    document.querySelectorAll('.icon-choice').forEach((b) => b.classList.toggle('selected', b.dataset.icon === icon));
    $('preview-icon').src = iconSrc(icon);
    $('preview-name').textContent = name;
    document.querySelectorAll('.chat-icon').forEach((b) => b.classList.toggle('selected', b.dataset.icon === icon));
    $('chat-name').textContent = name;
  }

  // Tab in the chat box: next icon
  function cycleIcon() {
    const ids = ['peri1', 'peri2', 'peri3'];
    const next = ids[(ids.indexOf(settings.operatorIcon) + 1) % ids.length];
    pickIcon(next);
  }

  let nameTimer = null;
  function onNameInput() {
    const name = $('op-name').value.replace(/[|]/g, '').slice(0, 20);
    settings.operatorName = name.trim() || 'PeriBot';
    renderProfile();
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => window.neural.saveSettings({ operatorName: settings.operatorName }), 400);
  }

  async function pickIcon(id) {
    settings = await window.neural.saveSettings({ operatorIcon: id });
    renderProfile();
  }

  // ---------- connection ----------

  function joinError(text) {
    $('join-error').textContent = text;
    $('join-btn').disabled = false;
  }

  function connect() {
    code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return joinError('Room codes are 6 letters/numbers.');

    $('join-error').textContent = 'Connecting…';
    state = null;
    lastResultSeq = null;
    renderHackBar();
    $('join-btn').disabled = true;
    cleanup();

    peer = new Peer({ config: iceConfig(settings) });

    peer.on('open', () => {
      conn = peer.connect(ROOM_PREFIX + code, { reliable: true, metadata: { operatorId: settings.operatorId } });
      conn.on('open', () => { clearTimeout(connectTimeout); startHeartbeat(); });
      conn.on('data', onData);
      conn.on('close', lost);
    });

    // The host calls us with his screen once the data link is open
    peer.on('call', (call) => {
      call.answer(undefined, { sdpTransform: streamSdp });
      currentCall = call;
      call.on('stream', (stream) => {
        clearTimeout(connectTimeout);
        applySmoothing();
        watchStats();
        const video = $('stage-video');
        video.srcObject = stream;
        video.volume = Number($('volume').value);
        video.play().catch(() => {});
        $('join-error').textContent = '';
        $('join-btn').disabled = false;
        $('stage-lost').hidden = true;
        showView('stage');
        toast('Jacked in');
      });
      call.on('close', lost);
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') return joinError('No room with that code. Check it with the host.');
      joinError('Connection error: ' + err.type);
      console.warn(err);
    });

    connectTimeout = setTimeout(() => {
      joinError('Could not connect. If this keeps happening, your internet may need a relay server (see README).');
      cleanup();
    }, 20000);
  }

  function onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'busy') { joinError('Someone else is already the Operator in this room.'); cleanup(); }
    // (round-trip time now comes from the stream stats)
    if (msg.type === 'ack' && !msg.ok) toast('Host’s game didn’t get it — is the mod installed?');
    if (msg.type === 'state') onState(msg.state);
  }

  function startHeartbeat() {
    clearInterval(hbTimer);
    hbTimer = setInterval(() => { if (conn?.open) conn.send({ type: 'hb', t: Date.now() }); }, 2000);
  }

  function lost() {
    if (!$('view-stage').classList.contains('active')) return;
    $('stage-lost').hidden = false;
    closeChat();
  }

  // ---------- smooth playback + stream stats ----------

  let currentCall = null, statsTimer = null, lastStats = null;

  // A small buffer (≈150 ms) smooths over a shaky connection; "lowest delay" turns it off
  function applySmoothing() {
    const target = settings?.smoothPlayback === false ? 0 : 150;
    for (const r of currentCall?.peerConnection?.getReceivers() || []) {
      try { r.jitterBufferTarget = target; } catch { /* older engines */ }
      try { r.playoutDelayHint = target / 1000; } catch { /* older engines */ }
    }
  }

  function watchStats() {
    clearInterval(statsTimer);
    lastStats = null;
    statsTimer = setInterval(async () => {
      const s = await readStreamStats(currentCall?.peerConnection, 'inbound', lastStats).catch(() => null);
      if (s) lastStats = s;
      $('stage-latency').textContent = describeStats(s, 'peri');
    }, 2000);
  }

  function cleanup() {
    clearInterval(statsTimer);
    currentCall = null;
    focusing = false;
    hoverTag = null;
    $('tags').innerHTML = '';
    menuSeqShown = menuSeqClosed = 0;
    $('hack-menu').hidden = true;
    clearInterval(hbTimer);
    clearTimeout(connectTimeout);
    if (conn) conn.close();
    if (peer) peer.destroy();
    conn = peer = null;
    $('stage-video').srcObject = null;
  }

  function send(cmd) {
    if (!conn?.open) { toast('Not connected'); return false; }
    conn.send({ type: 'cmd', ...cmd });
    return true;
  }

  // ---------- coordinates ----------

  // Where the video actually sits inside the window (it keeps its aspect ratio)
  function videoRect() {
    const v = $('stage-video');
    const W = v.clientWidth, H = v.clientHeight;
    const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale, h = vh * scale;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  function toGame(px, py) {
    const r = videoRect();
    const x = (px - r.x) / r.w, y = (py - r.y) / r.h;
    return (x >= 0 && x <= 1 && y >= 0 && y <= 1) ? { x, y } : null;
  }

  // ---------- actions ----------

  function toast(text, ok = false) {
    const t = $('stage-toast');
    t.classList.toggle('ok', ok);
    t.textContent = text;
    t.style.opacity = 1;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.style.opacity = 0), 1500);
  }

  function ripple(x, y, kind, label) {
    const el = document.createElement('div');
    el.className = 'ripple' + (kind === 'ping' ? ' ping' : '');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (label) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;
      el.appendChild(tag);
    }
    $('stage-overlay').appendChild(el);
    setTimeout(() => el.remove(), 650);
  }

  // ---------- focus (hold to slow everything) ----------

  let focusing = false;

  function setFocus(on) {
    if (on === focusing) return;
    focusing = on;
    $('stage-overlay').classList.toggle('focusing', on);
    if (conn?.open) conn.send({ type: 'cmd', cmd: 'focus', on });
  }

  function renderFocus() {
    const f = state?.focus || [0, 1, false];
    $('focus-fill').style.width = `${Math.max(0, Math.min(100, (f[0] / (f[1] || 1)) * 100))}%`;
    document.querySelector('.focus-meter').classList.toggle('active', !!f[2]);
  }

  // ---------- focus name tags: every target on his screen, hover a name to hack it ----------

  let hoverTag = null;
  const tagsShown = () => !ultActive() && (state?.tags?.length || 0) > 0;

  function renderTags() {
    const box = $('tags');
    if (!tagsShown()) {
      if (box.childElementCount) box.innerHTML = '';
      if (hoverTag) { hoverTag = null; aimDirty = true; lastAimSent = null; }
      return;
    }
    const r = videoRect();
    box.innerHTML = '';
    for (const t of state.tags) {
      const el = document.createElement('div');
      el.className = 'tag ' + t.kind + (t.id === hoverTag ? ' hover' : '');
      el.dataset.id = t.id;
      el.style.left = `${r.x + t.x * r.w}px`;
      el.style.top = `${r.y + t.y * r.h}px`;
      el.innerHTML = '<span></span><i></i>';
      el.querySelector('span').textContent = t.name;
      box.appendChild(el);
    }
    updateTagHover();
  }

  // The name tag nearest the mouse (within 70 px of its label) is the target
  function updateTagHover() {
    if (!tagsShown()) return;
    let best = null, bestD = 70;
    for (const el of $('tags').children) {
      const b = el.querySelector('span').getBoundingClientRect();
      const d = Math.hypot(mouse.x - (b.left + b.width / 2), mouse.y - (b.top + b.height / 2));
      if (d < bestD) { bestD = d; best = el.dataset.id; }
    }
    if (best !== hoverTag) {
      hoverTag = best;
      for (const el of $('tags').children) el.classList.toggle('hover', el.dataset.id === hoverTag);
      // real hotbar costs for the hovered tag (or back to "what's under the mouse")
      if (hoverTag && conn?.open) conn.send({ type: 'cmd', cmd: 'aimid', id: hoverTag });
      else { aimDirty = true; lastAimSent = null; }
    }
  }

  function tagHack(slot) {
    const deck = state?.deck || [];
    if (slot >= deck.length) return toast(`Slot ${slot + 1} is empty`);
    const t = (state?.tags || []).find((x) => x.id === hoverTag);
    send({ cmd: 'ulthack', id: hoverTag, slot });
    toast(`${deck[slot].name} → ${t ? t.name : 'target'}`, true);
  }

  // ---------- aim: tell the game what's under the mouse (for real hotbar costs) ----------

  let aimDirty = false;
  let lastAimSent = null;
  setInterval(() => {
    if (!aimDirty || !conn?.open || !$('view-stage').classList.contains('active') || ultActive() || chatOpen() || hoverTag) return;
    aimDirty = false;
    const p = toGame(mouse.x, mouse.y);
    const key = p ? `${p.x.toFixed(3)},${p.y.toFixed(3)}` : 'none';
    if (key === lastAimSent) return;
    lastAimSent = key;
    conn.send({ type: 'cmd', cmd: 'aim', ...(p || {}) });
  }, 250);

  // ---------- ULTIMATE: OVERRIDE radar ----------

  let hoverId = null;
  const ultActive = () => (state?.ult?.left || 0) > 0;

  function renderUlt() {
    const u = state?.ult;
    const slot = $('ult-slot');
    if (u) {
      slot.classList.toggle('active', u.left > 0);
      slot.classList.toggle('ready', u.left <= 0 && u.cd <= 0);
      $('ult-text').textContent = u.left > 0 ? `Override ${u.left.toFixed(1)}s`
        : u.cd > 0 ? `Override ${Math.ceil(u.cd)}s` : 'Override';
    }
    const radar = $('radar');
    if (!u || u.left <= 0) {
      if (!radar.hidden) { radar.hidden = true; hoverId = null; }
      return;
    }
    radar.hidden = false;
    $('stage-console').classList.remove('faded');
    $('radar-time').textContent = `${u.left.toFixed(1)}s`;
    $('radar-fill').style.width = `${Math.max(0, (u.left / (u.duration || 6)) * 100)}%`;

    const field = $('radar-field');
    const size = field.clientWidth;
    const dots = $('radar-dots');
    dots.innerHTML = '';
    for (const t of u.targets || []) {
      // x = meters to V's right, y = meters ahead; V faces up
      const r = Math.min(1, Math.hypot(t.x, t.y) / (u.radius || 40)) * 0.5;
      const ang = Math.atan2(t.x, t.y);
      const px = size / 2 + Math.sin(ang) * r * size;
      const py = size / 2 - Math.cos(ang) * r * size;
      const el = document.createElement('div');
      el.className = 'radar-dot ' + t.kind + (t.id === hoverId ? ' hover' : '');
      el.dataset.id = t.id;
      el.style.left = `${px}px`;
      el.style.top = `${py}px`;
      el.innerHTML = '<i></i><span></span>';
      el.querySelector('span').textContent = t.name;
      dots.appendChild(el);
    }
    updateHover();
  }

  // The radar target nearest the mouse (within 60 px) is the one you hack
  function updateHover() {
    if (!ultActive()) return;
    let best = null, bestD = 60;
    for (const el of $('radar-dots').children) {
      const b = el.querySelector('i').getBoundingClientRect();
      const d = Math.hypot(mouse.x - (b.left + b.width / 2), mouse.y - (b.top + b.height / 2));
      if (d < bestD) { bestD = d; best = el.dataset.id; }
    }
    if (best !== hoverId) {
      hoverId = best;
      for (const el of $('radar-dots').children) el.classList.toggle('hover', el.dataset.id === hoverId);
    }
  }

  function ultHack(slot) {
    if (!hoverId) return toast('Hover a target on the map first');
    const deck = state?.deck || [];
    if (slot >= deck.length) return toast(`Slot ${slot + 1} is empty`);
    send({ cmd: 'ulthack', id: hoverId, slot });
    const t = (state?.ult?.targets || []).find((x) => x.id === hoverId);
    toast(`${deck[slot].name} → ${t ? t.name : 'target'}`, true);
  }

  // ---------- hack menu (the game's own list for an NPC or device) ----------

  let menuSeqShown = 0;
  let menuSeqClosed = 0;

  function menuOpen() {
    return !$('hack-menu').hidden;
  }

  function renderMenu() {
    const menu = state?.menu;
    const box = $('hack-menu');
    if (!menu || menu.seq <= menuSeqClosed) { box.hidden = true; return; }
    if (menu.seq === menuSeqShown && !box.hidden) return;   // already showing this one
    menuSeqShown = menu.seq;

    $('menu-name').textContent = menu.name || 'Target';
    const list = $('menu-items');
    list.innerHTML = '';
    (menu.items || []).slice(0, 9).forEach((item, i) => {
      const li = document.createElement('li');
      li.className = item.locked ? 'locked' : '';
      li.innerHTML = '<b></b><span class="name"></span><span class="cost"></span>';
      li.querySelector('b').textContent = i + 1;
      li.querySelector('.name').textContent = item.name;
      li.querySelector('.cost').textContent = item.cost || '';
      if (item.locked && item.reason) {
        const r = document.createElement('span');
        r.className = 'reason';
        r.textContent = item.reason;
        li.querySelector('.name').appendChild(r);
      }
      li.addEventListener('mousedown', (e) => { e.stopPropagation(); pickMenu(i); });
      list.appendChild(li);
    });
    if (!list.children.length) list.innerHTML = '<li class="locked"><span class="name">No hacks available</span></li>';

    // Place it next to the target (or the mouse on the radar), kept inside the window
    const r = videoRect();
    box.hidden = false;
    const x = ultActive() ? mouse.x + 24 : r.x + (menu.x ?? 0.5) * r.w + 24;
    const y = ultActive() ? mouse.y - 20 : r.y + (menu.y ?? 0.5) * r.h - 20;
    box.style.left = `${Math.max(8, Math.min(x, innerWidth - box.offsetWidth - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(y, innerHeight - box.offsetHeight - 90))}px`;
  }

  function pickMenu(i) {
    const menu = state?.menu;
    const item = menu?.items?.[i];
    if (!menu || !item) return;
    if (item.locked) { toast(`${item.name}: ${item.reason || 'locked'}`); return; }
    send({ cmd: 'pick', seq: menu.seq, index: i, title: item.name });
    closeMenu(false);
  }

  function closeMenu(tellHost = true) {
    if (!menuOpen()) return;
    menuSeqClosed = Math.max(menuSeqClosed, state?.menu?.seq || menuSeqShown);
    $('hack-menu').hidden = true;
    if (tellHost) send({ cmd: 'menuclose' });
  }

  function scanAt(px, py) {
    const p = toGame(px, py);
    if (!p) return;
    if (send({ cmd: 'menu', ...p })) ripple(px, py, 'ping', 'SCAN');
  }

  // ---------- his real cyberdeck ----------

  function onState(next) {
    state = next;
    renderHackBar();
    renderFocus();
    renderTags();
    renderUlt();
    renderMenu();

    // Results of hacks (newest last). Show only ones we haven't seen.
    const results = Array.isArray(state.results) ? state.results : [];
    if (lastResultSeq === null) {
      lastResultSeq = results.reduce((m, r) => Math.max(m, r.seq), 0);   // don't replay old ones
      return;
    }
    for (const r of results) {
      if (r.seq > lastResultSeq) {
        lastResultSeq = r.seq;
        toast(r.text, r.ok);
      }
    }
  }

  function renderHackBar() {
    const bar = $('hack-bar');
    const ram = state?.ram || [0, 0];
    $('ram-fill').style.width = ram[1] > 0 ? `${Math.min(100, (ram[0] / ram[1]) * 100)}%` : '0';
    $('ram-text').textContent = ram[1] > 0 ? `${Math.floor(ram[0])}/${Math.floor(ram[1])}` : '–/–';
    $('ram-label').textContent = state?.virtual ? 'PERI RAM' : 'RAM';
    $('ram').classList.toggle('virtual', !!state?.virtual);

    bar.innerHTML = '';
    const note = (text) => { const n = document.createElement('span'); n.className = 'muted'; n.textContent = text; bar.appendChild(n); };
    if (!state) return note('Waiting for his cyberdeck…');
    if (!state.scripts) return note('Hacking offline — PeriLink not installed on his PC');
    const deck = (state.deck || []).slice(0, MAX_SLOTS);
    if (!deck.length) return note('No quickhacks — he needs a cyberdeck (or turn on the experimental mode on his Host screen)');
    if (selected >= deck.length) selected = 0;

    // Real costs for the target under the mouse, when there is one (else the base cost)
    const aim = !ultActive() && state.aim && state.aim.kind === 'npc' ? state.aim : null;
    const free = ultActive();
    const label = document.createElement('span');
    label.className = 'aim-label';
    label.textContent = free ? 'FREE' : aim ? `→ ${aim.name || 'target'}` : state.aim?.kind === 'device' ? `→ ${state.aim.name || 'device'} (menu)` : 'base cost';
    bar.appendChild(label);

    deck.forEach((hack, i) => {
      const real = aim?.costs?.[i];
      const notHere = real && real.cost < 0;
      const shownCost = free ? 0 : real && real.cost >= 0 ? real.cost : hack.cost;
      const el = document.createElement('div');
      el.className = 'hack-slot'
        + (i === selected ? ' selected' : '')
        + (!free && !notHere && shownCost > ram[0] ? ' poor' : '')
        + (notHere || (real && !real.usable) ? ' unavailable' : '')
        + (real && real.cost >= 0 ? ' exact' : '')
        + (hack.ultimate ? ' ultimate' : '');
      el.title = notHere ? `${hack.name} doesn't work on this target`
        : `${hack.name} — ${shownCost} RAM${real ? ' on this target' : ' (base)'}${real && !real.usable ? ' · not available right now' : ''}`;
      const key = document.createElement('b');
      key.textContent = keyLabel(settings.keybinds[`slot${i + 1}`] || '');
      const name = document.createElement('span');
      name.textContent = hack.name;
      const cost = document.createElement('span');
      cost.className = 'cost';
      cost.textContent = notHere ? '–' : free ? '0' : shownCost;
      el.append(key, name, cost);
      el.addEventListener('mousedown', (e) => { e.stopPropagation(); select(i); });
      bar.appendChild(el);
    });
  }

  function select(slot) {
    selected = slot;
    renderHackBar();
  }

  function castAt(slot, px, py) {
    const deck = state?.deck || [];
    if (!state?.scripts) return toast('Hacking offline on his PC');
    if (slot >= deck.length) return toast(`Slot ${slot + 1} is empty`);
    const p = toGame(px, py);
    if (!p) return;
    if (send({ cmd: 'hack', slot, ...p })) ripple(px, py, 'hack', deck[slot].name.toUpperCase());
  }

  function pingAt(px, py) {
    const p = toGame(px, py);
    if (!p) return;
    if (send({ cmd: 'ping', ...p })) ripple(px, py, 'ping', 'LOOK');
  }

  // ---------- chat ----------

  const chatOpen = () => $('chat').classList.contains('open');

  function openChat() {
    setFocus(false);
    closeMenu();
    $('chat').classList.add('open');
    $('stage-overlay').classList.add('typing');
    $('chat-input').value = '';
    $('chat-input').focus();
  }

  function closeChat() {
    $('chat').classList.remove('open');
    $('stage-overlay').classList.remove('typing');
    $('chat-input').blur();
  }

  // ---------- console fade (gets out of the way while you watch) ----------

  function wakeConsole() {
    $('stage-console').classList.remove('faded');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => { if (!ultActive()) $('stage-console').classList.add('faded'); }, 3500);
  }

  // ---------- public ----------

  async function enter() {
    settings = await window.neural.getSettings();
    if (!settings.operatorId) {   // stable id so the host lets us back in after a crash
      settings = await window.neural.saveSettings({ operatorId: randomCode(16) });
    }
    renderKeybinds();
    renderProfile();
    $('smooth-playback').checked = settings.smoothPlayback !== false;
    $('join-error').textContent = '';
    $('join-btn').disabled = false;
    $('join-code').focus();
  }

  function leave() {
    cleanup();
    closeChat();
    $('stage-lost').hidden = true;
  }

  // ---------- wiring ----------

  document.addEventListener('DOMContentLoaded', () => {
    $('join-btn').addEventListener('click', connect);
    $('op-name').addEventListener('input', onNameInput);
    $('smooth-playback').addEventListener('change', async (e) => {
      settings = await window.neural.saveSettings({ smoothPlayback: e.target.checked });
      applySmoothing();
    });
    document.querySelectorAll('.icon-choice').forEach((b) => b.addEventListener('click', () => pickIcon(b.dataset.icon)));
    $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
    $('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

    $('leave').addEventListener('click', () => { leave(); showView('join'); });
    $('lost-leave').addEventListener('click', () => { leave(); showView('join'); });
    $('rejoin').addEventListener('click', () => { $('join-code').value = code; showView('join'); connect(); });
    $('volume').addEventListener('input', (e) => { $('stage-video').volume = Number(e.target.value); });
    // Don't let the console's controls keep keyboard focus (Space/Enter would trigger them)
    ['volume', 'leave'].forEach((id) => $(id).addEventListener('mouseup', () => setTimeout(() => $(id).blur(), 0)));

    $('chat-input').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = $('chat-input').value.trim();
        closeChat();
        if (text && send({ cmd: 'say', text, name: settings.operatorName, icon: settings.operatorIcon })) toast('Transmitted');
      } else if (e.key === 'Escape') {
        closeChat();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        cycleIcon();
      }
    });

    document.querySelectorAll('.chat-icon').forEach((b) => b.addEventListener('mousedown', (e) => {
      e.preventDefault();            // keep typing focus in the box
      e.stopPropagation();
      pickIcon(b.dataset.icon);
    }));

    const overlay = $('stage-overlay');

    overlay.addEventListener('mousemove', (e) => {
      mouse = { x: e.clientX, y: e.clientY };
      $('reticle').style.left = e.clientX + 'px';
      $('reticle').style.top = e.clientY + 'px';
      wakeConsole();
      updateHover();
      updateTagHover();
      aimDirty = true;
    });

    overlay.addEventListener('mousedown', (e) => {
      if (chatOpen() || e.target.closest('#stage-console, #stage-lost, #chat, #hack-menu')) return;
      if (menuOpen()) { closeMenu(); return; }      // click away closes the menu
      if (ultActive()) {                            // the radar takes the clicks
        if (e.button === 0) ultHack(selected);
        if (e.button === 2 && hoverId) send({ cmd: 'ultmenu', id: hoverId });
        return;
      }
      if (hoverTag) {                               // focusing over a name tag
        if (e.button === 0) tagHack(selected);
        if (e.button === 2) send({ cmd: 'ultmenu', id: hoverTag });
        if (e.button === 1) { e.preventDefault(); pingAt(e.clientX, e.clientY); }
        return;
      }
      if (e.button === 0) castAt(selected, e.clientX, e.clientY);
      if (e.button === 2) scanAt(e.clientX, e.clientY);     // right-click: scan / hack menu
      if (e.button === 1) { e.preventDefault(); pingAt(e.clientX, e.clientY); }   // middle-click: ping
    });
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('keydown', async (e) => {
      if (await captureKeybind(e)) return;
      if (!$('view-stage').classList.contains('active') || chatOpen()) return;

      const kb = settings.keybinds;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const is = (action) => !!kb[action] && key === (kb[action].length === 1 ? kb[action].toLowerCase() : kb[action]);

      // Menu open: number keys pick from it, Esc closes it
      if (menuOpen()) {
        if (/^[1-9]$/.test(e.key)) { e.preventDefault(); pickMenu(Number(e.key) - 1); return; }
        if (e.key === 'Escape')   { e.preventDefault(); closeMenu(); return; }
      }

      if (is('ult')) { e.preventDefault(); if (!e.repeat && send({ cmd: 'ult' })) toast('OVERRIDE', true); return; }
      if (ultActive() || hoverTag) {
        for (let i = 0; i < MAX_SLOTS; i++) {
          if (kb[`slot${i + 1}`] && is(`slot${i + 1}`)) {
            e.preventDefault();
            select(i);
            if (ultActive()) ultHack(i); else tagHack(i);
            return;
          }
        }
      }
      if (is('focus')) {
        e.preventDefault();
        // Space would otherwise "click" the last clicked button (e.g. Unplug)
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        if (!e.repeat) setFocus(true);
        return;
      }
      if (e.repeat) return;
      if (is('ping'))  { e.preventDefault(); pingAt(mouse.x, mouse.y); return; }

      for (let i = 0; i < MAX_SLOTS; i++) {
        if (kb[`slot${i + 1}`] && is(`slot${i + 1}`)) {
          e.preventDefault();
          select(i);
          castAt(i, mouse.x, mouse.y);
          return;
        }
      }
      if (is('chat'))       { e.preventDefault(); openChat(); return; }
      if (is('fullscreen')) { e.preventDefault(); window.neural.toggleFullscreen(); return; }
    });
  });

  // Releasing the focus key (or leaving the window) ends focus
  document.addEventListener('keyup', (e) => {
    const bind = settings?.keybinds?.focus;
    if (!bind) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === (bind.length === 1 ? bind.toLowerCase() : bind)) {
      if ($('view-stage').classList.contains('active') && !chatOpen()) e.preventDefault();
      setFocus(false);
    }
  });
  window.addEventListener('blur', () => setFocus(false));

  // Closing the app: hang up properly so the host frees the Operator spot right away
  window.addEventListener('beforeunload', () => { try { conn?.close(); } catch { /* ignore */ } });

  return { enter, leave, _onState: onState };   // _onState: used by tests
})();
