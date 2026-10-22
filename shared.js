// Shared bits for the Host and Join screens.

const $ = (id) => document.getElementById(id);

const ROOM_PREFIX = 'neurallink-cp77-';           // keeps our rooms apart on the public signaling server
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O or 1/I mix-ups
const MAX_SLOTS = 8;   // hack slots Peri can bind (his deck has up to this many)

function randomCode(length = 6) {
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
    parts.push(`${label} ${m.version}${m.source === 'bundled' ? ' (built-in, offline)' : ''}`);
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
