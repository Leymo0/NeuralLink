// NeuralLink — one app for both players.
//   HOST  (plays the game): streams his screen + game audio, writes the Operator's
//                           commands into inbox.txt for the CoopOperator CET mod.
//   GUEST (the Operator):   joins with a room code, watches, hacks, pings, types.

const { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog } = require('electron');
const fs = require('fs');
const updater = require('./updater');
const path = require('path');

const MOD_SUBPATH = path.join('bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'CoopOperator');
// Installed app: bundled files sit next to the app in "resources"; during development, in this folder
const RES = app.isPackaged ? process.resourcesPath : __dirname;
const BUNDLED_MOD = path.join(RES, 'mod', 'CoopOperator');
const BUNDLED_THIRDPARTY = path.join(RES, 'thirdparty', 'game');   // Cyber Engine Tweaks + redscript
const REDS_SUBPATH = path.join('r6', 'scripts', 'PeriLink');
const BUNDLED_REDS = path.join(RES, 'mod', 'r6', 'scripts', 'PeriLink');
const MAX_SLOTS = 8;

const COMMON_GAME_FOLDERS = [
  'C:/Program Files (x86)/Steam/steamapps/common/Cyberpunk 2077',
  'C:/Program Files/Steam/steamapps/common/Cyberpunk 2077',
  'D:/SteamLibrary/steamapps/common/Cyberpunk 2077',
  'E:/SteamLibrary/steamapps/common/Cyberpunk 2077',
  'C:/Program Files (x86)/GOG Galaxy/Games/Cyberpunk 2077',
  'C:/GOG Games/Cyberpunk 2077',
  'C:/Program Files/Epic Games/Cyberpunk2077',
];

let win;

// ---------------------------------------------------------------------------
// Settings (saved in the app's user data folder)
// ---------------------------------------------------------------------------

const OPERATOR_ICONS = ['peri1', 'peri2', 'peri3'];

const DEFAULT_SETTINGS = {
  keybindsVersion: 2,
  operatorName: 'PeriBot',
  operatorIcon: 'peri2',
  gameFolder: null,
  hostCanHack: false,   // false = only Peri can hack ("Only Peri can hack" ticked)
  virtualDeck: false,   // EXPERIMENTAL: Peri's own cyberdeck when he isn't wearing one
  captureSourceId: null,
  shareAudio: true,
  maxBitrateMbps: 8,
  frameRate: 60,
  // Extra relay servers, only needed if the direct connection fails on your internet.
  // Example: [{ "urls": "turn:your.server:3478", "username": "u", "credential": "p" }]
  turnServers: [],
  keybinds: {
    slot1: '1', slot2: '2', slot3: '3', slot4: '4',
    slot5: '5', slot6: '6', slot7: '7', slot8: '8',
    focus: ' ',       // Space (hold): slow everything while aiming a hack
    ping: 'q',        // "look here" marker (also middle mouse button)
    ult: 'f',         // ULTIMATE: OVERRIDE
    chat: 'Enter',
    fullscreen: 'F11',
  },
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const KEYBINDS_VERSION = 2;   // v2: Space = focus, Q = ping, right-click = scan, no slow-mo

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    let keybinds = { ...DEFAULT_SETTINGS.keybinds, ...(saved.keybinds || {}) };
    if ((saved.keybindsVersion || 1) < KEYBINDS_VERSION) {
      // Older saves had focus on Shift, scan on Q and slow-mo on Space: move to the new layout
      keybinds.focus = DEFAULT_SETTINGS.keybinds.focus;
      keybinds.ping = DEFAULT_SETTINGS.keybinds.ping;
      delete keybinds.slow;
      delete keybinds.scan;
      saved.keybindsVersion = KEYBINDS_VERSION;
      saved.keybinds = keybinds;
      try { fs.writeFileSync(settingsFile(), JSON.stringify(saved, null, 2)); } catch { /* read-only is fine */ }
    }
    return { ...DEFAULT_SETTINGS, ...saved, keybinds };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// Game folder + mod install
// ---------------------------------------------------------------------------

const isGameFolder = (dir) => !!dir && fs.existsSync(path.join(dir, 'bin', 'x64', 'Cyberpunk2077.exe'));
const hasCET = (dir) => fs.existsSync(path.join(dir, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks'));
const modFolder = (dir) => path.join(dir, MOD_SUBPATH);
// redscript has shipped in a few layouts over the years — any of these means it's there (VERIFY)
const hasRedscript = (dir) => [
  path.join(dir, 'engine', 'tools', 'scc.exe'),
  path.join(dir, 'engine', 'tools', 'scc_lib.dll'),
  path.join(dir, 'red4ext', 'plugins', 'redscript'),
].some((p) => fs.existsSync(p));

function gameStatus() {
  const { gameFolder } = loadSettings();
  if (!isGameFolder(gameFolder)) return { gameFolder: null };
  const mod = modFolder(gameFolder);
  return {
    gameFolder,
    cetInstalled: hasCET(gameFolder),
    redscriptInstalled: hasRedscript(gameFolder),
    modInstalled: fs.existsSync(path.join(mod, 'init.lua'))
      && fs.existsSync(path.join(gameFolder, REDS_SUBPATH, 'PeriLink.reds')),
  };
}

function autoDetectGameFolder() {
  if (isGameFolder(loadSettings().gameFolder)) return;
  const found = COMMON_GAME_FOLDERS.find(isGameFolder);
  if (found) saveSettings({ gameFolder: found });
}

// ---------------------------------------------------------------------------
// Inbox — how commands reach the mod. Each line: <id>|<command>|<argument>
// ---------------------------------------------------------------------------

const recent = [];
let lastId = 0;

function writeToGame(cmd, arg = '') {
  const { gameFolder } = loadSettings();
  if (!isGameFolder(gameFolder)) return false;

  const inbox = path.join(modFolder(gameFolder), 'inbox.txt');
  lastId = Math.max(Date.now(), lastId + 1);
  const clean = String(arg).replace(/[\r\n]+/g, ' ').slice(0, 220);
  recent.push(`${lastId}|${cmd}|${clean}`);
  while (recent.length > 30) recent.shift();

  const data = recent.join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    const tmp = inbox + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, inbox);          // swap in whole, so the game never reads half a line
  } catch {
    try { fs.writeFileSync(inbox, data, 'utf8'); } catch { return false; }
  }
  return true;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:save', (_e, patch) => saveSettings(patch));

ipcMain.handle('game:status', () => gameStatus());

ipcMain.handle('game:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select your Cyberpunk 2077 folder (the one that contains "bin")',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return gameStatus();
  const dir = res.filePaths[0];
  if (!isGameFolder(dir)) {
    dialog.showErrorBox('Not the game folder', 'Pick the folder that contains bin\\x64\\Cyberpunk2077.exe.');
    return gameStatus();
  }
  saveSettings({ gameFolder: dir });
  return gameStatus();
});

// Install / update everything in the game folder: Cyber Engine Tweaks + redscript (latest from
// GitHub, built-in copies if offline) and our mod. CET settings (keybind etc.) are kept.
async function installGame(progress) {
  const settings = loadSettings();
  const { gameFolder } = settings;
  if (!isGameFolder(gameFolder)) return { ok: false, error: 'Game folder not set' };
  try {
    const mods = await updater.updateGameMods(gameFolder, settings.installedMods || {}, BUNDLED_THIRDPARTY, progress);
    progress?.('Installing NeuralLink mod…');
    fs.cpSync(BUNDLED_MOD, modFolder(gameFolder), { recursive: true, force: true });
    fs.cpSync(BUNDLED_REDS, path.join(gameFolder, REDS_SUBPATH), { recursive: true, force: true });

    const installedMods = { ...(settings.installedMods || {}) };
    for (const [key, r] of Object.entries(mods)) {
      if (r.source !== 'bundled') installedMods[key] = r.version;
    }
    saveSettings({ installedMods, modVersion: app.getVersion() });
    return { ok: true, mods, ...gameStatus() };
  } catch (err) {
    const busy = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
    return { ok: false, error: busy ? 'Close Cyberpunk first, then try again' : err.message };
  }
}

// Only one update at a time: a second click waits for (and shares) the running one
let updateRunning = null;
function exclusive(job) {
  if (updateRunning) return updateRunning;
  updateRunning = job().finally(() => { updateRunning = null; });
  return updateRunning;
}

// The one button: update the app if there's a newer release, then the game files.
// includeGame: true on the Host screen (his PC), false for Peri (app only).
ipcMain.handle('update:run', (_e, { includeGame }) => exclusive(() => runUpdate(includeGame)));

async function runUpdate(includeGame) {
  const progress = (text) => win?.webContents.send('update:progress', text);
  try {
    progress('Checking for a new NeuralLink version…');
    const check = await updater.checkAppUpdate();
    if (check.available) {
      await updater.downloadAppUpdate(progress);
      saveSettings({ pendingAfterUpdate: { installGame: !!includeGame, from: app.getVersion(), to: check.version } });
      progress(`Installing NeuralLink ${check.version}… it will reopen by itself`);
      setTimeout(() => {
        // Close everything first so the installer can replace our files
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
        updater.installAppUpdateAndRestart();
      }, 1200);
      return { ok: true, restarting: true, version: check.version };
    }
  } catch (err) {
    // No internet / no release yet: carry on with what we have
    progress(`Couldn't check for app updates (${err.message}) — continuing`);
  }
  if (!includeGame) return { ok: true, app: app.getVersion(), appOnly: true };
  const game = await installGame(progress);
  return { ...game, app: app.getVersion() };
}

// After an app update restarted us: finish the job (install the new mod into the game)
ipcMain.handle('update:pending', () => exclusive(finishPendingUpdate));

async function finishPendingUpdate() {
  const { pendingAfterUpdate } = loadSettings();
  if (!pendingAfterUpdate) return null;
  saveSettings({ pendingAfterUpdate: null });
  const progress = (text) => win?.webContents.send('update:progress', text);
  const game = pendingAfterUpdate.installGame ? await installGame(progress) : { ok: true, appOnly: true };
  return { ...game, app: app.getVersion(), from: pendingAfterUpdate.from };
}

ipcMain.handle('app:version', () => app.getVersion());

// Command from the Operator, already validated in the renderer
ipcMain.handle('game:command', (_e, c) => {
  const pt = (typeof c.x === 'number' && typeof c.y === 'number')
    ? `${Math.min(1, Math.max(0, c.x)).toFixed(4)} ${Math.min(1, Math.max(0, c.y)).toFixed(4)}`
    : '';
  switch (c.cmd) {
    case 'say': {
      const icon = OPERATOR_ICONS.includes(c.icon) ? c.icon : OPERATOR_ICONS[0];
      const name = String(c.name || 'PeriBot').replace(/[|\r\n]/g, '').trim().slice(0, 20) || 'PeriBot';
      return writeToGame('say', `${icon}|${name}|${String(c.text || '')}`);
    }
    case 'ping':  return pt ? writeToGame('ping', pt) : false;
    case 'hack': {
      const slot = Number(c.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS || !pt) return false;
      return writeToGame('hack', `${slot} ${pt}`);
    }
    case 'lock':  return writeToGame('lock', c.allowed ? '1' : '0');
    case 'virtual': return writeToGame('virtual', c.on ? '1' : '0');
    case 'ult':   return writeToGame('ult');
    case 'aim':   return writeToGame('aim', pt);   // empty = nothing under the mouse
    case 'aimid': {
      const id = String(c.id || '');
      return /^[\w-]{1,40}$/.test(id) ? writeToGame('aimid', id) : false;
    }
    case 'ulthack': {
      const id = String(c.id || ''), slot = Number(c.slot);
      if (!/^[\w-]{1,40}$/.test(id) || !Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return false;
      return writeToGame('ulthack', `${id} ${slot}`);
    }
    case 'ultmenu': {
      const id = String(c.id || '');
      if (!/^[\w-]{1,40}$/.test(id)) return false;
      return writeToGame('ultmenu', id);
    }
    case 'menu':  return pt ? writeToGame('menu', pt) : false;
    case 'menuclose': return writeToGame('menuclose');
    case 'focus': return writeToGame('focus', c.on ? '1' : '0');
    case 'pick': {
      const seq = Number(c.seq), index = Number(c.index);
      if (!Number.isInteger(seq) || !Number.isInteger(index) || index < 0 || index > 31) return false;
      const title = String(c.title || '').replace(/[\r\n|]/g, ' ').slice(0, 60);
      return writeToGame('pick', `${seq} ${index} ${title}`);
    }
    default:      return false;
  }
});

// What the mod reports: his deck, RAM, recent hack results
ipcMain.handle('game:state', () => {
  const { gameFolder } = loadSettings();
  if (!isGameFolder(gameFolder)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(modFolder(gameFolder), 'state.json'), 'utf8'));
  } catch {
    return null;
  }
});

// Screens and windows the host can share
ipcMain.handle('capture:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.on('window:fullscreen', () => win.setFullScreen(!win.isFullScreen()));

// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#07040a',
    title: 'NeuralLink',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// Only one NeuralLink at a time. Opening it again brings the existing window forward
// (or recreates it if a background copy lost its window).
const isSelfTest = !!process.env.NEURALLINK_SELFTEST_GAME;
const gotLock = isSelfTest || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  updater.updateLog(`start ${app.getVersion()}`);
  // Self-test used when building the installer: install into a given game folder and quit
  if (process.env.NEURALLINK_SELFTEST_GAME) {
    saveSettings({ gameFolder: process.env.NEURALLINK_SELFTEST_GAME });
    installGame((t) => console.log('PROGRESS', t)).then((res) => {
      console.log('SELFTEST', app.isPackaged ? 'packaged' : 'dev', JSON.stringify(res));
      app.quit();
    });
    return;
  }
  autoDetectGameFolder();

  // When the host page asks to share its screen, hand it the source picked in the app,
  // plus system audio (Windows) so the Operator hears cutscenes.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const settings = loadSettings();
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    // Window IDs change every time a program restarts, so fall back to a Cyberpunk window, then the first screen
    const source = sources.find((s) => s.id === settings.captureSourceId)
                || (settings.captureSourceId?.startsWith('window:') && sources.find((s) => /cyberpunk/i.test(s.name)))
                || sources.find((s) => s.id.startsWith('screen:'));
    callback({ video: source, audio: settings.shareAudio ? 'loopback' : undefined });
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
