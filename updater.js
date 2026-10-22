// NeuralLink updater
//  - Game mods: downloads the latest Cyber Engine Tweaks and redscript from their GitHub
//    releases and installs them into the game folder (falls back to the built-in copies offline).
//  - The app itself: checks Leymo0/NeuralLink GitHub releases and installs a newer version.

const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const MODS = [
  {
    key: 'cet',
    name: 'Cyber Engine Tweaks',
    repo: 'maximegmd/CyberEngineTweaks',
    asset: /^cet_[\d.]+\.zip$/i,
    check: path.join('bin', 'x64', 'plugins', 'cyber_engine_tweaks.asi'),
  },
  {
    key: 'redscript',
    name: 'redscript',
    repo: 'jac3km4/redscript',
    asset: /^redscript-v[\d.]+-windows\.zip$/i,
    check: path.join('engine', 'tools', 'scc.exe'),
  },
];

// Only these top-level folders may be written into the game folder
const ALLOWED_ROOTS = ['bin', 'engine', 'r6', 'red4ext'];

async function fetchJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'NeuralLink', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'NeuralLink' } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// Extract a mod zip into the game folder, refusing anything outside the allowed folders
function extractInto(zipBuffer, gameFolder) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  let written = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const rel = entry.entryName.replace(/\\/g, '/');
    const parts = rel.split('/');
    if (!ALLOWED_ROOTS.includes(parts[0]) || parts.includes('..') || path.isAbsolute(rel)) continue;
    const dest = path.join(gameFolder, ...parts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    written += 1;
  }
  return written;
}

// Install/update one mod from GitHub. Returns { version, source: 'github' | 'already' | 'bundled' }
async function updateMod(mod, gameFolder, installed, bundledFolder) {
  try {
    const release = await fetchJson(`https://api.github.com/repos/${mod.repo}/releases/latest`);
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (installed[mod.key] === version && fs.existsSync(path.join(gameFolder, mod.check))) {
      return { version, source: 'already' };
    }
    const asset = (release.assets || []).find((a) => mod.asset.test(a.name));
    if (!asset) throw new Error('no matching download in the latest release');
    const data = await fetchBuffer(asset.browser_download_url);
    const written = extractInto(data, gameFolder);
    if (!written || !fs.existsSync(path.join(gameFolder, mod.check))) {
      throw new Error('the download had an unexpected layout');
    }
    return { version, source: 'github' };
  } catch (err) {
    // Offline or GitHub problem: use the copy built into NeuralLink
    if (fs.existsSync(bundledFolder)) {
      fs.cpSync(bundledFolder, gameFolder, { recursive: true, force: true });
      return { version: installed[mod.key] || 'built-in', source: 'bundled', error: err.message };
    }
    throw err;
  }
}

async function updateGameMods(gameFolder, installed, bundledFolder, onProgress) {
  const results = {};
  for (const mod of MODS) {
    onProgress?.(`Updating ${mod.name}…`);
    results[mod.key] = await updateMod(mod, gameFolder, installed, bundledFolder);
  }
  return results;
}

// ---------------------------------------------------------------------------
// App self-update (electron-updater, GitHub releases of Leymo0/NeuralLink)
// ---------------------------------------------------------------------------

let autoUpdater = null;
function getAutoUpdater() {
  if (!autoUpdater) {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
  }
  return autoUpdater;
}

// Resolves to { available: false } or { available: true, version }
async function checkAppUpdate() {
  if (!app.isPackaged) return { available: false, dev: true };
  const updater = getAutoUpdater();
  const result = await updater.checkForUpdates();
  const latest = result?.updateInfo?.version;
  const available = !!latest && latest !== app.getVersion() && isNewer(latest, app.getVersion());
  return { available, version: latest };
}

function downloadAppUpdate(onProgress) {
  const updater = getAutoUpdater();
  return new Promise((resolve, reject) => {
    const progress = (p) => onProgress?.(`Downloading NeuralLink update… ${Math.floor(p.percent || 0)}%`);
    updater.on('download-progress', progress);
    updater.once('update-downloaded', () => { updater.off('download-progress', progress); resolve(); });
    updater.once('error', (err) => { updater.off('download-progress', progress); reject(err); });
    updater.downloadUpdate().catch(reject);
  });
}

function installAppUpdateAndRestart() {
  // silent install, then start the new version
  getAutoUpdater().quitAndInstall(true, true);
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

module.exports = { updateGameMods, checkAppUpdate, downloadAppUpdate, installAppUpdateAndRestart, extractInto };
