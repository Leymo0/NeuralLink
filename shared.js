// Shared bits for the Host and Join screens.

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROOM_PREFIX = 'neurallink-cp77-';           // keeps our rooms apart on the public signaling server
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O or 1/I mix-ups
const MAX_SLOTS = 8;   // hack slots Peri can bind (his deck has up to this many)

// 16 characters: impossible to guess, so nobody can stumble into the room. Shown as XXXX-XXXX-XXXX-XXXX.
const CODE_LENGTH = 16;
const formatCode = (c) => (c || '').match(/.{1,4}/g)?.join('-') || '';
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode(length = CODE_LENGTH) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function iceConfig(settings) {
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      ...(settings.turnServers || []),
    ],
  };
}

// Game audio is music, not a phone call: ask for full-quality stereo Opus in the connection
// setup (both sides must agree, so host and guest both apply this).
function hiFiAudioSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const wanted = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '256000', maxplaybackrate: '48000', useinbandfec: '1', usedtx: '0' };
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (fmtp.test(sdp)) {
    return sdp.replace(fmtp, (_all, params) => {
      const map = {};
      params.split(';').forEach((kv) => { const [k, v] = kv.split('='); if (k) map[k.trim()] = (v || '').trim(); });
      Object.assign(map, wanted);
      return `a=fmtp:${pt} ` + Object.entries(map).map(([k, v]) => `${k}=${v}`).join(';');
    });
  }
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ` + Object.entries(wanted).map(([k, v]) => `${k}=${v}`).join(';'));
}

// Stream quality presets (host picks one). Resolution is capped so the encoder isn't
// compressing a full 1440p/4K/ultrawide screen every frame.
const STREAM_PRESETS = {
  '1080p60': { w: 1920, h: 1080, fps: 60, mbps: 10, label: '1080p · 60 fps' },
  '1080p30': { w: 1920, h: 1080, fps: 30, mbps: 6,  label: '1080p · 30 fps' },
  '720p60':  { w: 1280, h: 720,  fps: 60, mbps: 5,  label: '720p · 60 fps' },
};
// Legacy = exactly how 0.6.4 streamed: full screen size, default codec, no speed hints
STREAM_PRESETS.legacy = { legacy: true, fps: 60, mbps: 8, label: 'Legacy (0.6.4 behaviour)' };
const streamPreset = (key) => STREAM_PRESETS[key] || STREAM_PRESETS['1080p60'];

// Put H.264 first in the video codec list: on Windows it's usually compressed by the
// graphics card, leaving the CPU free for the game (VP8, the default, uses the CPU).
function preferH264(sdp) {
  const lines = sdp.split('\r\n');
  const mIndex = lines.findIndex((l) => l.startsWith('m=video '));
  if (mIndex < 0) return sdp;
  const parts = lines[mIndex].split(' ');
  const header = parts.slice(0, 3), pts = parts.slice(3);
  const rtpmap = {}, fmtp = {}, apt = {};
  for (const l of lines) {
    let m = l.match(/^a=rtpmap:(\d+) ([^/]+)\//);
    if (m) rtpmap[m[1]] = m[2].toUpperCase();
    m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (m) { fmtp[m[1]] = m[2]; const a = m[2].match(/apt=(\d+)/); if (a) apt[m[1]] = a[1]; }
  }
  const h264 = pts.filter((pt) => rtpmap[pt] === 'H264' && /packetization-mode=1/.test(fmtp[pt] || ''));
  if (!h264.length) return sdp;
  // high/main profiles before baseline, each followed by its retransmission (rtx) payload
  h264.sort((a, b) => (/profile-level-id=4d/.test(fmtp[b] || '') - /profile-level-id=4d/.test(fmtp[a] || '')));
  const first = [];
  for (const pt of h264) {
    first.push(pt);
    for (const [rtx, of] of Object.entries(apt)) if (of === pt && pts.includes(rtx)) first.push(rtx);
  }
  lines[mIndex] = [...header, ...first, ...pts.filter((pt) => !first.includes(pt))].join(' ');
  return lines.join('\r\n');
}

// Start the connection at a sensible speed instead of WebRTC's very cautious default
// (which shows 270p for the first ~10-20 s), and never let it collapse below ~1.5 Mbps.
// It still adapts upward/downward with the real connection.
function videoBitrateHints(sdp, startKbps = 4000, minKbps = 1500, maxKbps = 12000) {
  const lines = sdp.split('\r\n');
  const m = lines.findIndex((l) => l.startsWith('m=video '));
  if (m < 0) return sdp;
  const pts = lines[m].split(' ').slice(3);
  const hint = `x-google-start-bitrate=${startKbps};x-google-min-bitrate=${minKbps};x-google-max-bitrate=${maxKbps}`;
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^a=fmtp:(\d+) (.*)$/);
    if (f && pts.includes(f[1]) && !/apt=/.test(f[2]) && !/x-google-start-bitrate/.test(f[2])) {
      lines[i] = `${lines[i]};${hint}`;
    }
  }
  return lines.join('\r\n');
}

const streamSdp = (sdp) => videoBitrateHints(preferH264(hiFiAudioSdp(sdp)));

// Live numbers for the stats line. kind: 'outbound' (host) or 'inbound' (Peri).
async function readStreamStats(pc, kind, prev) {
  if (!pc) return null;
  const report = await pc.getStats();
  const out = { t: performance.now() };
  let codecId = null;
  report.forEach((s) => {
    if (s.type === `${kind}-rtp` && s.kind === 'video') {
      out.w = s.frameWidth; out.h = s.frameHeight; out.fps = s.framesPerSecond;
      out.bytes = kind === 'outbound' ? s.bytesSent : s.bytesReceived;
      out.limit = s.qualityLimitationReason;        // host only: 'cpu' | 'bandwidth' | 'none'
      out.lost = s.packetsLost; out.freezes = s.freezeCount;
      codecId = s.codecId;
    }
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) {
      out.rtt = Math.round(s.currentRoundTripTime * 1000);
    }
  });
  if (codecId && report.get(codecId)) out.codec = report.get(codecId).mimeType.replace('video/', '');
  if (prev && prev.bytes != null && out.bytes != null) {
    out.mbps = ((out.bytes - prev.bytes) * 8) / ((out.t - prev.t) * 1000);
  }
  return out;
}

function describeStats(s, side) {
  if (!s || !s.w) return side === 'host' ? 'Waiting for Peri…' : 'Connecting…';
  const parts = [`${s.w}×${s.h}`, `${Math.round(s.fps || 0)} fps`];
  if (s.codec) parts.push(s.codec);
  if (s.mbps != null) parts.push(`${s.mbps.toFixed(1)} Mbps`);
  if (s.rtt != null) parts.push(`${s.rtt} ms`);
  if (side === 'host' && s.limit && s.limit !== 'none') {
    parts.push(s.limit === 'cpu' ? '⚠ held back by this PC (try 1080p 30 or 720p)' : '⚠ held back by the internet');
  }
  return parts.join(' · ');
}

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
}

function timeStamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "✓ Updated" style status line. kind: 'busy' | 'ok' | 'warn'
function showUpdateStatus(el, text, kind) {
  el.hidden = false;
  el.className = 'update-status ' + (kind || '');
  el.textContent = text;
}

function describeUpdate(res) {
  const parts = [`NeuralLink ${res.app}`];
  for (const [key, label] of [['cet', 'CET'], ['redscript', 'redscript']]) {
    const m = res.mods?.[key];
    if (!m) continue;
    parts.push(m.source === 'bundled'
      ? `${label}: built-in copy — couldn't get the latest (${m.error || 'no internet?'})`
      : `${label} ${m.version}`);
  }
  return parts.join(' · ');
}

// App-only update (Peri's side, or anyone from the home screen)
async function homeUpdate() {
  const btn = $('home-update'), status = $('home-update-status');
  btn.disabled = true;
  const res = await window.neural.runUpdate(false);
  btn.disabled = false;
  if (res.restarting) showUpdateStatus(status, `Updating to ${res.version}… NeuralLink will reopen`, 'busy');
  else if (res.ok) showUpdateStatus(status, `✓ Updated — you have the latest (${res.app})`, 'ok');
  else showUpdateStatus(status, 'Update failed: ' + res.error, 'warn');
}

// Navigation
document.addEventListener('DOMContentLoaded', async () => {
  window.neural.appVersion().then((v) => { $('app-version').textContent = `NeuralLink ${v}`; });
  $('home-update').addEventListener('click', homeUpdate);
  window.neural.onUpdateProgress((text) => {
    const target = $('view-host').classList.contains('active') ? $('update-status') : $('home-update-status');
    showUpdateStatus(target, text, 'busy');
  });

  // Just restarted after an app update: finish and say so
  const pending = await window.neural.pendingUpdate();
  if (pending) {
    const text = pending.ok
      ? `✓ Updated — ${describeUpdate(pending)}`
      : `Updated NeuralLink to ${pending.app}, but the game install failed: ${pending.error}`;
    showUpdateStatus($('home-update-status'), text, pending.ok ? 'ok' : 'warn');
    showUpdateStatus($('update-status'), text, pending.ok ? 'ok' : 'warn');
  }

  $('go-host').addEventListener('click', () => { showView('host'); Host.enter(); });
  $('go-join').addEventListener('click', () => { showView('join'); Guest.enter(); });
  document.querySelectorAll('[data-back]').forEach((b) =>
    b.addEventListener('click', () => { Host.stop(); Guest.leave(); showView('home'); }));
});
