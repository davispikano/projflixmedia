const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

// ---------- Storage ----------
const userDir = app.getPath('userData');
const configPath = path.join(userDir, 'config.json');
const libraryPath = path.join(userDir, 'library.json');
const progressPath = path.join(userDir, 'progress.json');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.flv', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, data) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); } catch (e) { console.error(e); }
}

let config = readJson(configPath, { folders: [], vlcPath: '', vlcPort: 9090, vlcPassword: 'mediaflix' });
let progress = readJson(progressPath, {}); // { [filePath]: { time, length, updatedAt } }

function saveConfig() { writeJson(configPath, config); }
function saveProgress() { writeJson(progressPath, progress); }

// ---------- Library scanning ----------
function findBanner(dir) {
  try {
    const entries = fs.readdirSync(dir);
    const candidates = ['banner', 'fanart', 'backdrop', 'poster', 'cover', 'folder'];
    for (const name of candidates) {
      for (const e of entries) {
        const lower = e.toLowerCase();
        const ext = path.extname(lower);
        if (IMAGE_EXT.has(ext) && lower.startsWith(name)) {
          return path.join(dir, e);
        }
      }
    }
    // any image
    for (const e of entries) {
      const ext = path.extname(e).toLowerCase();
      if (IMAGE_EXT.has(ext)) return path.join(dir, e);
    }
  } catch {}
  return null;
}

function listVideosRecursive(dir, depth = 0, max = 4) {
  const out = [];
  if (depth > max) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listVideosRecursive(full, depth + 1, max));
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (VIDEO_EXT.has(ext)) out.push(full);
    }
  }
  return out;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function scanLibrary() {
  const items = [];
  for (const folder of config.folders) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      const full = path.join(folder, e.name);
      if (e.isDirectory()) {
        const videos = listVideosRecursive(full);
        if (!videos.length) continue;
        const banner = findBanner(full);
        if (videos.length === 1) {
          items.push({
            id: full,
            type: 'movie',
            title: e.name,
            path: videos[0],
            banner,
            folder: full,
          });
        } else {
          videos.sort(naturalSort);
          items.push({
            id: full,
            type: 'series',
            title: e.name,
            banner,
            folder: full,
            episodes: videos.map((v, i) => ({
              id: v,
              title: path.basename(v, path.extname(v)),
              path: v,
              index: i + 1,
            })),
          });
        }
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (VIDEO_EXT.has(ext)) {
          items.push({
            id: full,
            type: 'movie',
            title: path.basename(e.name, ext),
            path: full,
            banner: null,
            folder,
          });
        }
      }
    }
  }
  items.sort((a, b) => naturalSort(a.title, b.title));
  writeJson(libraryPath, items);
  return items;
}

// ---------- VLC ----------
function findVlcPath() {
  if (config.vlcPath && fs.existsSync(config.vlcPath)) return config.vlcPath;
  const candidates = [
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

let vlcProcess = null;
let vlcPollTimer = null;
let currentPlayingPath = null;

function vlcStatusRequest() {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`:${config.vlcPassword}`).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: config.vlcPort,
      path: '/requests/status.json',
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
      timeout: 1500,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function startPolling(filePath) {
  stopPolling();
  currentPlayingPath = filePath;
  vlcPollTimer = setInterval(async () => {
    try {
      const s = await vlcStatusRequest();
      if (typeof s.time === 'number' && typeof s.length === 'number' && s.length > 0) {
        progress[filePath] = {
          time: s.time,
          length: s.length,
          updatedAt: Date.now(),
        };
        saveProgress();
      }
    } catch {
      // VLC may have closed
    }
  }, 4000);
}

function stopPolling() {
  if (vlcPollTimer) { clearInterval(vlcPollTimer); vlcPollTimer = null; }
}

async function playFile(filePath) {
  const vlc = findVlcPath();
  if (!vlc) {
    return { ok: false, error: 'VLC não encontrado. Instale o VLC ou configure o caminho manualmente.' };
  }

  const saved = progress[filePath];
  let startTime = 0;
  if (saved && saved.length && saved.time && saved.time / saved.length < 0.95) {
    startTime = Math.max(0, Math.floor(saved.time) - 3);
  }

  // Always launch a fresh VLC so the HTTP port is bound to our instance
  if (vlcProcess) {
    try { vlcProcess.kill(); } catch {}
    vlcProcess = null;
  }
  stopPolling();

  const args = [
    filePath,
    '--extraintf=http',
    `--http-host=127.0.0.1`,
    `--http-port=${config.vlcPort}`,
    `--http-password=${config.vlcPassword}`,
    '--no-qt-privacy-ask',
  ];
  if (startTime > 0) args.push(`--start-time=${startTime}`);

  vlcProcess = spawn(vlc, args, { detached: false, stdio: 'ignore' });
  vlcProcess.on('exit', () => {
    stopPolling();
    vlcProcess = null;
    currentPlayingPath = null;
  });

  // Give VLC a moment to bind the HTTP port, then start polling
  setTimeout(() => startPolling(filePath), 2500);

  return { ok: true };
}

// ---------- IPC ----------
ipcMain.handle('library:get', () => scanLibrary());
ipcMain.handle('library:rescan', () => scanLibrary());

ipcMain.handle('library:addFolder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const folder = res.filePaths[0];
  if (!config.folders.includes(folder)) {
    config.folders.push(folder);
    saveConfig();
  }
  return { ok: true, folder, library: scanLibrary() };
});

ipcMain.handle('library:removeFolder', (_e, folder) => {
  config.folders = config.folders.filter((f) => f !== folder);
  saveConfig();
  return { ok: true, library: scanLibrary() };
});

ipcMain.handle('config:get', () => ({ ...config }));

ipcMain.handle('config:setVlcPath', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'VLC', extensions: ['exe'] }],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  config.vlcPath = res.filePaths[0];
  saveConfig();
  return { ok: true, vlcPath: config.vlcPath };
});

ipcMain.handle('progress:get', () => progress);
ipcMain.handle('progress:clear', (_e, filePath) => {
  delete progress[filePath];
  saveProgress();
  return { ok: true };
});

ipcMain.handle('play', (_e, filePath) => playFile(filePath));

ipcMain.handle('shell:openFolder', (_e, folder) => {
  shell.openPath(folder);
  return { ok: true };
});

// Expose local image files to the renderer via file:// — but we need to read them as data URLs because Electron with sandbox blocks file:// from custom origins. Easier: read as base64.
ipcMain.handle('image:read', (_e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

// ---------- Window ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0a0b',
    autoHideMenuBar: true,
    title: 'Mediaflix',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  stopPolling();
  if (vlcProcess) { try { vlcProcess.kill(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});
