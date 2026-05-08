const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

// Registra o scheme custom pra reproduzir vídeos locais de qualquer pasta
protocol.registerSchemesAsPrivileged([
  { scheme: 'mediaflix-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

const {
  cleanTitle,
  cleanEpisodeTitle,
  detectSeasonNumber,
  detectSeasonAndEpisode,
  groupKeyFromName,
  isTrivialTitle,
} = require('./titleParser');

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

let config = readJson(configPath, { folders: [], vlcPath: '', vlcPort: 9090, vlcPassword: 'mediaflix', tmdbKey: '', tmdbLang: 'pt-BR' });
// Migração — defaults novos pra instalações antigas
if (config.embeddedPlayer === undefined) config.embeddedPlayer = true;
if (config.autoNext === undefined) config.autoNext = true;
if (config.autoNextSeconds === undefined) config.autoNextSeconds = 8;
if (config.autoRescan === undefined) config.autoRescan = false;
if (config.skipIntro === undefined) config.skipIntro = false;
let progress = readJson(progressPath, {}); // { [filePath]: { time, length, updatedAt } }
let metaCache = readJson(path.join(userDir, 'meta-cache.json'), {}); // { [groupKey]: { title, banner, poster, overview, year, fetchedAt } }
const historyPath = path.join(userDir, 'history.json');
let history = readJson(historyPath, {}); // { [filePath]: { openedAt, closedAt, openCount } }

function saveConfig() { writeJson(configPath, config); }
function saveProgress() { writeJson(progressPath, progress); }
function saveMetaCache() { writeJson(path.join(userDir, 'meta-cache.json'), metaCache); }
function saveHistory() { writeJson(historyPath, history); }

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

// Pick the best name to use as the show title given a folder. If the folder
// name itself is trivial (e.g. "1080p"), walk up the path until a meaningful
// ancestor is found, or fall back to the watched folder root name.
function pickMeaningfulName(folder, watchedRoot) {
  let cur = folder;
  for (let i = 0; i < 6; i++) {
    const name = path.basename(cur);
    if (!isTrivialTitle(cleanTitle(name))) return name;
    if (cur === watchedRoot) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Last resort: the watched root or the original folder name
  const rootName = path.basename(watchedRoot);
  if (!isTrivialTitle(cleanTitle(rootName))) return rootName;
  return path.basename(folder);
}

function scanLibrary() {
  // Prune monitored folders that no longer exist on disk
  const before = config.folders.length;
  config.folders = config.folders.filter((f) => {
    try { return fs.statSync(f).isDirectory(); } catch { return false; }
  });
  if (config.folders.length !== before) saveConfig();

  // First, gather raw entries: each top-level child of every monitored folder
  // becomes either a season-folder (groupable into a series) or a movie file.
  const seriesByKey = new Map(); // groupKey -> aggregated series object
  const movies = [];

  for (const folder of config.folders) {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      const full = path.join(folder, e.name);
      if (e.isDirectory()) {
        const videos = listVideosRecursive(full);
        if (!videos.length) continue;
        const banner = findBanner(full);
        videos.sort(naturalSort);

        // Single-video folder: treat as movie unless folder name explicitly looks like a season
        // OR the file itself looks like an episode (e.g. "The.Boys.S05E05....mkv")
        const looksLikeSeason = detectSeasonNumber(e.name) !== null;
        const singleFileLooksLikeEpisode = videos.length === 1 && (() => {
          const det = detectSeasonAndEpisode(path.basename(videos[0]));
          return det.season != null || det.episode != null;
        })();
        if (videos.length === 1 && !looksLikeSeason && !singleFileLooksLikeEpisode) {
          movies.push({
            id: full,
            type: 'movie',
            title: cleanTitle(e.name),
            rawTitle: e.name,
            path: videos[0],
            banner,
            folder: full,
          });
          continue;
        }

        // Multi-video folder OR season-named folder => part of a series
        const showName = pickMeaningfulName(full, folder);
        const key = groupKeyFromName(showName) || showName.toLowerCase();
        const seasonNum = detectSeasonNumber(e.name);

        // Determine episode list for THIS folder, possibly split by per-file season info
        // Some folders mix multiple seasons inside (rare); group by per-file season
        const perSeason = new Map(); // seasonNum -> episodes[]
        for (const v of videos) {
          const base = path.basename(v);
          const det = detectSeasonAndEpisode(base);
          const s = det.season || seasonNum || 1;
          if (!perSeason.has(s)) perSeason.set(s, []);
          perSeason.get(s).push({
            path: v,
            file: base,
            episodeNum: det.episode,
          });
        }

        // Get-or-create the series aggregate
        let series = seriesByKey.get(key);
        if (!series) {
          series = {
            id: 'series:' + key,
            type: 'series',
            title: cleanTitle(showName) || showName,
            rawTitle: showName,
            banner,
            folder: full,
            folders: [],
            seasons: new Map(), // season number -> { number, folder, episodes: [] }
          };
          seriesByKey.set(key, series);
        }
        series.folders.push(full);
        if (!series.banner && banner) series.banner = banner;

        for (const [sNum, eps] of perSeason.entries()) {
          let season = series.seasons.get(sNum);
          if (!season) {
            season = { number: sNum, folder: full, episodes: [] };
            series.seasons.set(sNum, season);
          }
          for (const ep of eps) season.episodes.push(ep);
        }
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXT.has(ext)) continue;

        // If the file looks like an episode (has SxxExx or similar), group it
        // as a series using the parent watched folder name as the show title.
        const det = detectSeasonAndEpisode(e.name);
        const isEpisode = det.season != null || det.episode != null;

        if (isEpisode) {
          const parentName = path.basename(folder);
          const key = groupKeyFromName(parentName) || parentName.toLowerCase();
          const banner = findBanner(folder);
          let series = seriesByKey.get(key);
          if (!series) {
            series = {
              id: 'series:' + key,
              type: 'series',
              title: cleanTitle(parentName) || parentName,
              rawTitle: parentName,
              banner,
              folder,
              folders: [folder],
              seasons: new Map(),
            };
            seriesByKey.set(key, series);
          } else if (!series.banner && banner) {
            series.banner = banner;
          }
          const sNum = det.season || 1;
          let season = series.seasons.get(sNum);
          if (!season) {
            season = { number: sNum, folder, episodes: [] };
            series.seasons.set(sNum, season);
          }
          season.episodes.push({
            path: full,
            file: e.name,
            episodeNum: det.episode,
          });
        } else {
          movies.push({
            id: full,
            type: 'movie',
            title: cleanTitle(e.name),
            rawTitle: e.name,
            path: full,
            banner: null,
            folder,
          });
        }
      }
    }
  }

  // Finalize series: convert seasons map to array, sort, assign episode indices
  const series = Array.from(seriesByKey.values()).map((s) => {
    const seasons = Array.from(s.seasons.values())
      .sort((a, b) => a.number - b.number)
      .map((season) => {
        season.episodes.sort((a, b) => {
          if (a.episodeNum != null && b.episodeNum != null) return a.episodeNum - b.episodeNum;
          return naturalSort(a.file, b.file);
        });
        season.episodes = season.episodes.map((ep, i) => ({
          id: ep.path,
          path: ep.path,
          index: ep.episodeNum != null ? ep.episodeNum : i + 1,
          title: cleanEpisodeTitle(ep.file),
        }));
        return season;
      });

    // Use the earliest folder name as canonical base for title (already cleaned)
    // Try harder: the cleanest title from the group of folder names, ignoring trivial ones
    const candidateTitles = s.folders.map((f) => cleanTitle(path.basename(f).replace(/[._\s-]*(season|temporada)[._\s-]*\d+.*$/i, '')))
      .filter((t) => t && !isTrivialTitle(t));
    const best = candidateTitles.sort((a, b) => a.length - b.length)[0];
    if (best) s.title = best;

    // Apply meta cache override if present. Look up by both the raw cleaned
    // title and (after applying the override title) by the localized title,
    // because previous versions may have stored entries under different keys
    // (e.g. "how i met your mother" without episode names AND
    // "como eu conheci sua m e" with episode names).
    const tryKeys = new Set();
    tryKeys.add(groupKeyFromName(s.title) || s.id);
    let meta = metaCache[groupKeyFromName(s.title) || s.id];
    if (meta && meta.title) {
      const altKey = groupKeyFromName(meta.title);
      if (altKey && metaCache[altKey]) {
        const alt = metaCache[altKey];
        // Prefer the entry that has episode names
        if ((!meta.episodes || !Object.keys(meta.episodes).length) && alt.episodes) {
          meta = { ...meta, ...alt, episodes: { ...(meta.episodes || {}), ...(alt.episodes || {}) } };
        } else {
          meta = { ...alt, ...meta, episodes: { ...(alt.episodes || {}), ...(meta.episodes || {}) } };
        }
      }
    }
    if (meta) {
      if (meta.title) s.title = meta.title;
      if (meta.banner) s.banner = meta.banner;
      s.overview = meta.overview;
      s.year = meta.year;
      // Override episode titles with TMDB names when available
      if (meta.episodes) {
        for (const season of seasons) {
          const epMap = meta.episodes[season.number];
          if (!epMap) continue;
          for (const ep of season.episodes) {
            const entry = epMap[ep.index];
            if (!entry) continue;
            if (typeof entry === 'string') {
              if (entry) ep.title = entry;
            } else {
              if (entry.name) ep.title = entry.name;
              if (entry.overview) ep.overview = entry.overview;
              if (entry.airDate) ep.airDate = entry.airDate;
            }
          }
        }
      }
      // Per-episode IMDb rating from cached imdb data
      if (meta.imdb && meta.imdb.seasons) {
        for (const season of seasons) {
          const rMap = meta.imdb.seasons[season.number];
          if (!rMap) continue;
          for (const ep of season.episodes) {
            const r = rMap[ep.index];
            if (typeof r === 'number') ep.imdbRating = r;
          }
        }
      }
    }

    // Flat episodes for backward-compat / easy "next episode" UI
    const episodes = [];
    let globalIdx = 0;
    for (const season of seasons) {
      for (const ep of season.episodes) {
        episodes.push({ ...ep, season: season.number, globalIndex: ++globalIdx });
      }
    }

    return {
      id: s.id,
      type: 'series',
      title: s.title,
      rawTitle: s.rawTitle,
      banner: s.banner,
      folder: s.folder,
      folders: s.folders,
      seasons,
      episodes,
      overview: s.overview,
      year: s.year,
      imdbId: (metaCache[groupKeyFromName(s.title) || s.id] && metaCache[groupKeyFromName(s.title) || s.id].imdb) ? metaCache[groupKeyFromName(s.title) || s.id].imdb.id : null,
      imdbRating: (metaCache[groupKeyFromName(s.title) || s.id] && metaCache[groupKeyFromName(s.title) || s.id].imdb) ? metaCache[groupKeyFromName(s.title) || s.id].imdb.average : null,
    };
  });

  // Apply meta cache to movies too
  for (const m of movies) {
    const meta = metaCache[groupKeyFromName(m.title) || m.id];
    if (meta) {
      if (meta.title) m.title = meta.title;
      if (meta.banner) m.banner = meta.banner;
      m.overview = meta.overview;
      m.year = meta.year;
      if (meta.imdb) {
        m.imdbId = meta.imdb.id;
        m.imdbRating = meta.imdb.average;
      }
    }
  }

  const items = [...series, ...movies].sort((a, b) => naturalSort(a.title, b.title));
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
  if (config.embeddedPlayer) {
    // Garante que o transmux server esta rodando, depois aponta o <video>
    // pro endpoint /stream que cuida de transmux on-the-fly pra MKV/AVI/etc.
    startTransmuxServer();
    if (!transmuxServer.port) {
      // espera bind
      await new Promise((r) => setTimeout(r, 200));
    }
    const url = `http://127.0.0.1:${transmuxServer.port}/stream?f=${encodeURIComponent(filePath)}`;
    return { ok: true, embedded: true, url, ext: path.extname(filePath).toLowerCase() };
  }
  return playFileVlc(filePath, null);
}

async function playFileVlc(filePath, embeddedFallbackMsg) {
  const vlc = findVlcPath();
  if (!vlc) {
    return { ok: false, error: 'VLC nao encontrado. Instale o VLC para tocar este formato.' };
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

  // Log open event immediately on click — even if VLC fails to send progress
  const entry = history[filePath] || { openCount: 0 };
  entry.openedAt = Date.now();
  entry.openCount = (entry.openCount || 0) + 1;
  entry.closedAt = null;
  history[filePath] = entry;
  saveHistory();

  vlcProcess.on('exit', () => {
    stopPolling();
    vlcProcess = null;
    currentPlayingPath = null;
    // Log close timestamp
    if (history[filePath]) {
      history[filePath].closedAt = Date.now();
      saveHistory();
    }
  });

  // Give VLC a moment to bind the HTTP port, then start polling
  setTimeout(() => startPolling(filePath), 2500);

  return { ok: true, fallbackMsg: embeddedFallbackMsg || null };
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
ipcMain.handle('history:get', () => history);
ipcMain.handle('history:clear', () => { history = {}; saveHistory(); return { ok: true }; });
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

ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

// ---------- Discover (trending) ----------
ipcMain.handle('discover:trending', async () => {
  if (!config.tmdbKey) return { ok: false, error: 'Configure a chave TMDB primeiro.' };
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
  // Try to ensure the IMDb title index is loaded (best-effort, used to enrich
  // each trending item with a rating).
  try { await getImdbTitleIndex(); } catch {}
  const fetchTrending = async (kind /* 'tv' | 'movie' */) => {
    const url = `https://api.themoviedb.org/3/trending/${kind}/week?api_key=${config.tmdbKey}&language=${lang}`;
    const json = await httpsGetJson(url);
    return (json.results || []).slice(0, 12).map((r) => ({
      tmdbId: r.id,
      kind,
      title: r.name || r.title || 'Sem título',
      year: (r.first_air_date || r.release_date || '').slice(0, 4),
      overview: r.overview || '',
      backdropPath: r.backdrop_path,
      tmdbRating: typeof r.vote_average === 'number' ? +r.vote_average.toFixed(1) : null,
    }));
  };
  let tv = [], movie = [];
  try { tv = await fetchTrending('tv'); } catch {}
  try { movie = await fetchTrending('movie'); } catch {}
  const items = [...tv, ...movie];
  // Download backdrops to local cache + attach IMDb id/rating when known
  for (const it of items) {
    if (it.backdropPath) {
      try {
        const ext = path.extname(it.backdropPath) || '.jpg';
        const fname = 'tr_' + Buffer.from(it.backdropPath).toString('base64url') + ext;
        it.banner = await downloadToCache(`https://image.tmdb.org/t/p/w780${it.backdropPath}`, fname);
      } catch {}
    }
    // Resolve IMDb id reliably via TMDB external_ids (works for any localized
    // title), then fall back to title-based lookup against mokronos.
    let imdbId = null;
    try {
      const ext = await httpsGetJson(`https://api.themoviedb.org/3/${it.kind}/${it.tmdbId}/external_ids?api_key=${config.tmdbKey}`);
      if (ext && ext.imdb_id) imdbId = ext.imdb_id;
    } catch {}
    if (!imdbId) imdbId = findImdbIdForTitle(it.title, it.year);
    if (imdbId) {
      it.imdbId = imdbId;
      it.imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
      // Try to grab the average rating from the heatmap dataset (cheap; one
      // tiny JSON per show). This makes the discover row show IMDb numbers.
      try {
        const data = await fetchImdbRatings(imdbId);
        if (data && data.average != null) it.imdbRating = data.average;
      } catch {}
    }
  }
  // Interleave tv and movie so the row mixes both, but cap at 16 total
  const mixed = [];
  for (let i = 0; i < Math.max(tv.length, movie.length); i++) {
    if (i < tv.length) mixed.push(items.find((x) => x.kind === 'tv' && x.tmdbId === tv[i].tmdbId));
    if (i < movie.length) mixed.push(items.find((x) => x.kind === 'movie' && x.tmdbId === movie[i].tmdbId));
  }
  return { ok: true, items: mixed.filter(Boolean).slice(0, 16) };
});

// ---------- TMDB integration (optional) ----------
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'Mediaflix/0.2' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function downloadToCache(url, fileName) {
  const cacheDir = path.join(userDir, 'banners');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) return dest;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        file.close(); fs.unlink(dest, () => {});
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => {
      file.close(); fs.unlink(dest, () => {}); reject(err);
    });
  });
}

async function tmdbLookup(title, type /* 'tv' | 'movie' */) {
  if (!config.tmdbKey) throw new Error('Sem chave TMDB. Configure em Pastas → TMDB API Key.');
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');

  // Build a list of search variations to try until we get a hit
  const variations = [];
  const t = String(title).trim();
  variations.push(t);
  // Strip everything after a colon or dash subtitle
  const colon = t.split(/\s[:\-–]\s|:\s/)[0].trim();
  if (colon && colon !== t && colon.length > 2) variations.push(colon);
  // Heuristic: keep just the first 4-5 significant words
  const short = t.split(/\s+/).slice(0, 5).join(' ');
  if (short && !variations.includes(short)) variations.push(short);

  let first = null;
  for (const variant of variations) {
    const q = encodeURIComponent(variant);
    // Try in user's language first, then en-US as fallback
    for (const l of [lang, 'en-US']) {
      const url = `https://api.themoviedb.org/3/search/${type}?api_key=${config.tmdbKey}&language=${l}&query=${q}&include_adult=false`;
      try {
        const json = await httpsGetJson(url);
        if (json.results && json.results.length) { first = json.results[0]; break; }
      } catch {}
    }
    if (first) break;
  }
  if (!first) return null;
  return await buildMetaFromTmdbId(first.id, type);
}

// Fetch full meta (with optional season episode names) for a chosen TMDB id
async function buildMetaFromTmdbId(tmdbId, type /* 'tv' | 'movie' */, neededSeasons /* number[] | null */) {
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
  const detailUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${config.tmdbKey}&language=${lang}&append_to_response=external_ids`;
  const json = await httpsGetJson(detailUrl);
  const name = json.name || json.title;
  const year = (json.first_air_date || json.release_date || '').slice(0, 4);
  const result = {
    tmdbId,
    type,
    title: name,
    year: year || null,
    overview: json.overview || '',
    posterPath: json.poster_path,
    backdropPath: json.backdrop_path,
    imdbId: (json.external_ids && json.external_ids.imdb_id) || null,
    fetchedAt: Date.now(),
    episodes: {},
  };
  if (json.backdrop_path) {
    try {
      const ext = path.extname(json.backdrop_path) || '.jpg';
      const fname = 'bd_' + Buffer.from(json.backdrop_path).toString('base64url') + ext;
      result.banner = await downloadToCache(`https://image.tmdb.org/t/p/w1280${json.backdrop_path}`, fname);
    } catch {}
  }
  if (json.poster_path) {
    try {
      const ext = path.extname(json.poster_path) || '.jpg';
      const fname = 'p_' + Buffer.from(json.poster_path).toString('base64url') + ext;
      result.poster = await downloadToCache(`https://image.tmdb.org/t/p/w500${json.poster_path}`, fname);
    } catch {}
  }
  // For TV: fetch episode names per season
  if (type === 'tv' && Array.isArray(json.seasons)) {
    const seasonsToFetch = json.seasons
      .map((s) => s.season_number)
      .filter((n) => n != null && n > 0)
      .filter((n) => !neededSeasons || neededSeasons.includes(n));
    for (const sn of seasonsToFetch) {
      try {
        const sUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${sn}?api_key=${config.tmdbKey}&language=${lang}`;
        const sjson = await httpsGetJson(sUrl);
        const map = {};
        for (const ep of sjson.episodes || []) {
          if (ep.episode_number == null) continue;
          // Store as object so we can include overview, air date, etc.
          // The renderer accepts both strings (legacy) and objects.
          map[ep.episode_number] = {
            name: ep.name || null,
            overview: ep.overview || null,
            airDate: ep.air_date || null,
            stillPath: ep.still_path || null,
          };
        }
        result.episodes[sn] = map;
        await new Promise((r) => setTimeout(r, 150));
      } catch {}
    }
  }
  return result;
}

ipcMain.handle('config:setTmdbKey', (_e, key) => {
  config.tmdbKey = (key || '').trim();
  saveConfig();
  return { ok: true };
});

ipcMain.handle('meta:fetchAll', async (event) => {
  if (!config.tmdbKey) return { ok: false, error: 'Sem chave TMDB configurada.' };
  const items = scanLibrary();
  let updated = 0, failed = 0;
  for (const it of items) {
    const key = groupKeyFromName(it.title) || it.id;
    const cached = metaCache[key];
    // For series, find which seasons are on disk but missing from the cache
    const onDiskSeasons = it.type === 'series' && Array.isArray(it.seasons)
      ? it.seasons.map((s) => s.number).filter((n) => n != null)
      : [];
    const missingSeasons = onDiskSeasons.filter((sn) => {
      if (!cached || !cached.episodes) return true;
      const m = cached.episodes[sn];
      return !m || !Object.keys(m).length;
    });
    const hasBanner = cached && cached.banner;
    // Skip only when banner is present AND no seasons are missing
    if (hasBanner && missingSeasons.length === 0) continue;
    try {
      let result = null;
      if (cached && cached.tmdbId && missingSeasons.length && hasBanner) {
        // Already identified: just backfill missing seasons via known TMDB id
        const kindCached = cached.type || (it.type === 'series' ? 'tv' : 'movie');
        result = await buildMetaFromTmdbId(cached.tmdbId, kindCached, missingSeasons);
        if (result) {
          // Preserve already-cached seasons and merge in the new ones
          result.episodes = { ...(cached.episodes || {}), ...(result.episodes || {}) };
        }
      } else {
        result = await tmdbLookup(it.title, it.type === 'series' ? 'tv' : 'movie');
      }
      if (result) {
        metaCache[key] = result;
        updated++;
        event.sender.send('meta:progress', { title: it.title, ok: true });
      } else {
        failed++;
        event.sender.send('meta:progress', { title: it.title, ok: false });
      }
    } catch (e) {
      failed++;
      event.sender.send('meta:progress', { title: it.title, ok: false, error: e.message });
    }
    // gentle pacing for TMDB rate limit
    await new Promise((r) => setTimeout(r, 250));
  }
  saveMetaCache();
  return { ok: true, updated, failed, library: scanLibrary() };
});

ipcMain.handle('meta:clear', () => {
  metaCache = {};
  saveMetaCache();
  return { ok: true, library: scanLibrary() };
});

// Search TMDB by free-text query and return up to 10 candidates
ipcMain.handle('meta:search', async (_e, query, type) => {
  if (!config.tmdbKey) return { ok: false, error: 'Sem chave TMDB configurada.' };
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
  const q = encodeURIComponent(query);
  const kind = type === 'series' ? 'tv' : type === 'movie' ? 'movie' : 'multi';
  try {
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${config.tmdbKey}&language=${lang}&query=${q}&include_adult=false`;
    const json = await httpsGetJson(url);
    const results = (json.results || []).slice(0, 10).map((r) => ({
      id: r.id,
      mediaType: r.media_type || (kind === 'multi' ? null : kind),
      title: r.name || r.title || 'Sem título',
      year: (r.first_air_date || r.release_date || '').slice(0, 4),
      overview: r.overview || '',
      posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w200${r.poster_path}` : null,
    }));
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Apply a chosen TMDB result to a specific library item
ipcMain.handle('meta:apply', async (_e, itemTitle, itemType, tmdbId, mediaType, rawTitle, folder) => {
  if (!config.tmdbKey) return { ok: false, error: 'Sem chave TMDB configurada.' };
  const kind = mediaType === 'tv' || itemType === 'series' ? 'tv' : 'movie';
  try {
    const result = await buildMetaFromTmdbId(tmdbId, kind);

    // Purge ALL stale cache keys that could still apply to this item:
    //  - the displayed title (which may itself be a previous TMDB override)
    //  - the raw folder title
    //  - the new TMDB-returned title
    //  - any key whose meta currently points to a DIFFERENT tmdbId but matches
    //    one of the titles above (this catches the case where the wrong show
    //    was auto-identified earlier).
    const candidateTitles = [itemTitle, rawTitle, result.title].filter(Boolean);
    const keysToReplace = new Set();
    for (const t of candidateTitles) {
      const k = groupKeyFromName(t);
      if (k) keysToReplace.add(k);
    }
    for (const k of Array.from(keysToReplace)) {
      delete metaCache[k];
    }
    // Also drop any other entry that was written under a key that loosely
    // matches one of our titles (handles accents/punctuation drift).
    for (const k of Object.keys(metaCache)) {
      const e = metaCache[k];
      if (!e) continue;
      if (e.tmdbId && e.tmdbId !== tmdbId) {
        for (const t of candidateTitles) {
          if (groupKeyFromName(e.title || '') === groupKeyFromName(t)) {
            delete metaCache[k];
            break;
          }
        }
      }
    }

    // Write the fresh meta under EVERY plausible key so the next scanLibrary()
    // call hits it no matter how the title is normalized.
    for (const k of keysToReplace) metaCache[k] = result;

    saveMetaCache();
    return { ok: true, library: scanLibrary() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- IMDb ratings (via mokronos/imdb-heatmap dataset on jsDelivr) ----------
const IMDB_DATA_BASE = 'https://cdn.jsdelivr.net/gh/mokronos/imdb-heatmap@main/data';
const imdbTitlesPath = path.join(userDir, 'imdb-titles.json');

function imdbNormalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

let imdbTitleIndex = null;
async function getImdbTitleIndex() {
  const cached = readJson(imdbTitlesPath, null);
  const now = Date.now();
  if (cached && cached.fetchedAt && now - cached.fetchedAt < 7 * 24 * 3600 * 1000 && cached.map) {
    if (!imdbTitleIndex) imdbTitleIndex = new Map(Object.entries(cached.map));
    return imdbTitleIndex;
  }
  const json = await httpsGetJson(`${IMDB_DATA_BASE}/titleId.json`);
  const map = {};
  if (Array.isArray(json)) {
    for (const r of json) {
      if (!r || !r.title || !r.id) continue;
      const k = imdbNormalize(r.title);
      if (k && !map[k]) map[k] = r.id;
    }
  } else if (json && typeof json === 'object') {
    for (const [t, id] of Object.entries(json)) {
      const k = imdbNormalize(t);
      if (k && !map[k]) map[k] = id;
    }
  }
  writeJson(imdbTitlesPath, { fetchedAt: now, map });
  imdbTitleIndex = new Map(Object.entries(map));
  return imdbTitleIndex;
}

function findImdbIdForTitle(title, year) {
  if (!imdbTitleIndex) return null;
  const variants = [title];
  if (year) variants.push(`${title} ${year}`);
  for (const v of variants) {
    const id = imdbTitleIndex.get(imdbNormalize(v));
    if (id) return id;
  }
  return null;
}

async function fetchImdbRatings(imdbId) {
  const url = `${IMDB_DATA_BASE}/${imdbId}.json`;
  let seasons;
  try {
    seasons = await httpsGetJson(url);
  } catch (e) {
    // 404 / not in dataset → return empty so caller can fall back gracefully
    return { id: imdbId, average: null, seasons: {} };
  }
  const seasonMap = {};
  let total = 0, count = 0;
  if (Array.isArray(seasons)) {
    seasons.forEach((eps, sIdx) => {
      const sNum = sIdx + 1;
      const epMap = {};
      (eps || []).forEach((ep, eIdx) => {
        if (ep && typeof ep.rating === 'number') {
          epMap[eIdx + 1] = ep.rating;
          total += ep.rating;
          count++;
        }
      });
      if (Object.keys(epMap).length) seasonMap[sNum] = epMap;
    });
  }
  return {
    id: imdbId,
    average: count ? +(total / count).toFixed(2) : null,
    seasons: seasonMap,
  };
}

ipcMain.handle('imdb:fetchAll', async (event) => {
  try {
    await getImdbTitleIndex();
  } catch (e) {
    return { ok: false, error: 'Falha ao baixar índice IMDb: ' + e.message };
  }
  const items = scanLibrary();
  let updated = 0, missing = 0;
  for (const it of items) {
    const key = groupKeyFromName(it.title) || it.id;
    const cached = metaCache[key] || {};
    if (cached.imdb && cached.imdb.average != null) continue;
    // 1) Prefer the IMDb id we got from TMDB external_ids (works for any
    //    localized title — Como Eu Conheci Sua Mãe, Histórias de 85, etc.)
    let id = cached.imdbId || null;

    // 2) If no TMDB-derived id, try to discover one via TMDB now
    if (!id && config.tmdbKey && cached.tmdbId) {
      try {
        const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
        const kindCached = cached.type || (it.type === 'series' ? 'tv' : 'movie');
        const ext = await httpsGetJson(`https://api.themoviedb.org/3/${kindCached}/${cached.tmdbId}/external_ids?api_key=${config.tmdbKey}&language=${lang}`);
        if (ext && ext.imdb_id) {
          id = ext.imdb_id;
          metaCache[key] = { ...cached, imdbId: id };
        }
      } catch {}
    }

    // 3) Last resort: title-based lookup against mokronos index
    if (!id) id = findImdbIdForTitle(it.title, it.year);

    if (!id) {
      missing++;
      event.sender && event.sender.send('imdb:progress', { title: it.title, ok: false });
      continue;
    }
    try {
      const data = await fetchImdbRatings(id);
      // Heatmap dataset may have the title but no usable episode ratings (very
      // new shows, anthologies, etc.). In that case, fall back to TMDB's own
      // vote_average so the user still sees a number.
      if (!data || data.average == null) {
        let tmdbAvg = null;
        try {
          if (config.tmdbKey && cached.tmdbId) {
            const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
            const kindCached = cached.type || (it.type === 'series' ? 'tv' : 'movie');
            const det = await httpsGetJson(`https://api.themoviedb.org/3/${kindCached}/${cached.tmdbId}?api_key=${config.tmdbKey}&language=${lang}`);
            if (typeof det.vote_average === 'number' && det.vote_average > 0) {
              tmdbAvg = +det.vote_average.toFixed(1);
            }
          }
        } catch {}
        if (tmdbAvg != null) {
          metaCache[key] = { ...metaCache[key], imdb: { id, average: tmdbAvg, source: 'tmdb', seasons: {} }, imdbId: id };
          updated++;
          event.sender && event.sender.send('imdb:progress', { title: it.title + ' (TMDB)', ok: true, rating: tmdbAvg });
        } else {
          missing++;
          event.sender && event.sender.send('imdb:progress', { title: it.title, ok: false, error: 'sem rating disponível' });
        }
      } else {
        metaCache[key] = { ...metaCache[key], imdb: { ...data, source: 'imdb' }, imdbId: id };
        updated++;
        event.sender && event.sender.send('imdb:progress', { title: it.title, ok: true, rating: data.average });
      }
    } catch (e) {
      missing++;
      event.sender && event.sender.send('imdb:progress', { title: it.title, ok: false, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  saveMetaCache();
  return { ok: true, updated, missing, library: scanLibrary() };
});

// Hard reset: clear meta cache + library file + progress for missing files
ipcMain.handle('library:resetCache', () => {
  metaCache = {};
  saveMetaCache();
  try { fs.unlinkSync(libraryPath); } catch {}
  // Drop progress entries for files that no longer exist
  let pruned = 0;
  for (const filePath of Object.keys(progress)) {
    try { fs.statSync(filePath); } catch { delete progress[filePath]; pruned++; }
  }
  if (pruned) saveProgress();
  for (const filePath of Object.keys(history)) {
    try { fs.statSync(filePath); } catch { delete history[filePath]; }
  }
  saveHistory();
  return { ok: true, library: scanLibrary(), prunedProgress: pruned };
});

// ---------- Embedded player support ----------
const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);

// ffmpeg-static: caminho do binario embutido. Em prod (asar), o exe fica em
// resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe.
const ffmpegStaticPath = require('ffmpeg-static');
function getFfmpegPath() {
  if (!ffmpegStaticPath) return null;
  // Quando empacotado, o caminho vem dentro do asar — substitui pra unpacked
  return ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked');
}
let ffprobeStaticPath = null;
try { ffprobeStaticPath = require('ffprobe-static').path; } catch {}
function getFfprobePath() {
  if (!ffprobeStaticPath) return null;
  return ffprobeStaticPath.replace('app.asar', 'app.asar.unpacked');
}

const durationCache = new Map(); // filePath -> seconds
const tracksCache = new Map(); // filePath -> { audio: [{index, lang, title}], duration }

function probeFile(filePath) {
  return new Promise((resolve) => {
    if (tracksCache.has(filePath)) return resolve(tracksCache.get(filePath));
    const ffprobe = getFfprobePath();
    if (!ffprobe) return resolve({ audio: [], duration: 0 });
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout.on('data', (d) => buf += d.toString());
    proc.on('exit', () => {
      try {
        const j = JSON.parse(buf);
        const duration = parseFloat((j.format && j.format.duration) || 0) || 0;
        const audio = (j.streams || [])
          .filter((s) => s.codec_type === 'audio')
          .map((s, i) => ({
            index: i,
            lang: ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase(),
            title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
            codec: s.codec_name,
          }));
        const subs = (j.streams || [])
          .filter((s) => s.codec_type === 'subtitle')
          .map((s, i) => ({
            index: i,
            lang: ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase(),
            title: (s.tags && (s.tags.title || s.tags.TITLE)) || '',
            codec: s.codec_name,
          }));
        const out = { audio, subs, duration };
        tracksCache.set(filePath, out);
        durationCache.set(filePath, duration);
        resolve(out);
      } catch { resolve({ audio: [], subs: [], duration: 0 }); }
    });
    proc.on('error', () => resolve({ audio: [], duration: 0 }));
  });
}

function pickPreferredAudio(audioTracks) {
  if (!audioTracks || !audioTracks.length) return 0;
  // Prioridade: pt-br > por/pt > primeira
  const pt = audioTracks.find((a) => /pt.?br|brazil|brasil/i.test(a.lang) || /pt.?br|brazil|brasil/i.test(a.title));
  if (pt) return pt.index;
  const por = audioTracks.find((a) => /^(por|pt|ptg)/i.test(a.lang));
  if (por) return por.index;
  return 0;
}

ipcMain.handle('player:probe', async (_e, filePath) => {
  const info = await probeFile(filePath);
  const preferred = pickPreferredAudio(info.audio);
  return { duration: info.duration, audio: info.audio, preferred, subs: info.subs || [] };
});

// Extrai uma legenda embutida (por absolute index do stream subtitle) e devolve em VTT
ipcMain.handle('player:extractSub', (_e, filePath, subIdx) => {
  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return resolve({ ok: false, error: 'ffmpeg' });
    const proc = spawn(ffmpeg, [
      '-v', 'error',
      '-i', filePath,
      '-map', `0:s:${subIdx}`,
      '-f', 'webvtt',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => buf += d);
    proc.on('exit', (code) => {
      if (code === 0 && buf.length > 10) resolve({ ok: true, vtt: buf });
      else resolve({ ok: false, error: 'extract failed' });
    });
    proc.on('error', (e) => resolve({ ok: false, error: String(e) }));
  });
});

// HTTP server local que transmuxa qualquer arquivo (MKV/AVI/etc) pra fMP4
// streamado, pra <video> tocar nativamente. Tambem serve arquivos suportados
// como progressive download.
const transmuxServer = { port: 0, server: null, processes: new Map() };

function startTransmuxServer() {
  if (transmuxServer.server) return;
  transmuxServer.server = http.createServer((req, res) => {
    // CORS aberto pra origin file:// do Electron poder consumir
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/stream') { res.writeHead(404); res.end(); return; }
      const filePath = decodeURIComponent(u.searchParams.get('f') || '');
      if (!filePath || !fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const NATIVE = new Set(['.mp4', '.webm', '.m4v', '.mov']);
      if (NATIVE.has(ext)) {
        // Stream direto com Range support
        const stat = fs.statSync(filePath);
        const range = req.headers.range;
        const mime = ext === '.webm' ? 'video/webm' : 'video/mp4';
        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/);
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': mime,
          });
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      }
      // Transmux com ffmpeg para fMP4. Reencode sempre pra H.264+AAC porque
      // <video> do Chromium nao suporta HEVC/AV1/MPEG2/etc. ultrafast preset
      // mantem CPU razoavel.
      const ffmpeg = getFfmpegPath();
      if (!ffmpeg) { res.writeHead(500); res.end('ffmpeg not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });
      const ss = u.searchParams.get('ss'); // seek seconds
      const audioIdx = parseInt(u.searchParams.get('a') || '0', 10);
      const args = [];
      if (ss) { args.push('-ss', ss); }
      args.push(
        '-i', filePath,
        '-map', '0:v:0',
        '-map', `0:a:${audioIdx}?`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '1000000',
        '-f', 'mp4',
        'pipe:1',
      );
      console.log('[transmux]', path.basename(filePath), 'audio=', audioIdx);
      const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      transmuxServer.processes.set(proc.pid, proc);
      proc.stdout.pipe(res);
      let stderrBuf = '';
      proc.stderr.on('data', (d) => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
      });
      const cleanup = () => {
        try { proc.kill('SIGKILL'); } catch {}
        transmuxServer.processes.delete(proc.pid);
      };
      req.on('close', cleanup);
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error('[transmux] ffmpeg exit', code, '\n', stderrBuf.slice(-1000));
        }
        transmuxServer.processes.delete(proc.pid);
      });
    } catch (e) {
      try { res.writeHead(500); res.end(String(e)); } catch {}
    }
  });
  transmuxServer.server.listen(0, '127.0.0.1', () => {
    transmuxServer.port = transmuxServer.server.address().port;
    console.log('transmux server on', transmuxServer.port);
  });
}

function killAllTransmux() {
  for (const p of transmuxServer.processes.values()) { try { p.kill('SIGKILL'); } catch {} }
  transmuxServer.processes.clear();
}

function detectSubLang(name) {
  // common patterns: video.pt-BR.srt / video.en.srt / video.por.srt
  const m = name.match(/\.([a-z]{2,3}(?:-[a-z]{2})?)\.[a-z]+$/i);
  if (m) return m[1].toLowerCase();
  if (/portug|\bpt\b|\bbr\b|\bpor\b/i.test(name)) return 'pt';
  if (/english|\beng\b|\ben\b/i.test(name)) return 'en';
  if (/spanish|\bspa\b|\bes\b/i.test(name)) return 'es';
  return '';
}

function langLabel(code) {
  const map = { 'pt': 'Português', 'pt-br': 'Português (BR)', 'por': 'Português',
                'en': 'English', 'eng': 'English', 'es': 'Español', 'spa': 'Español',
                'fr': 'Français', 'de': 'Deutsch', 'it': 'Italiano', 'ja': '日本語' };
  return map[code] || code.toUpperCase() || 'Legenda';
}

ipcMain.handle('player:sidecars', (_e, filePath) => {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const entries = fs.readdirSync(dir);
    const subs = [];
    for (const name of entries) {
      const ext = path.extname(name).toLowerCase();
      if (!SUBTITLE_EXT.has(ext)) continue;
      const lower = name.toLowerCase();
      const noExt = path.basename(lower, ext);
      // Match: same basename, or basename.lang
      if (noExt === base || noExt.startsWith(base + '.') || noExt.startsWith(base + '_')) {
        try {
          const full = path.join(dir, name);
          let raw = fs.readFileSync(full);
          // Try utf8, fall back to latin1
          let content = raw.toString('utf8');
          if (content.includes('\uFFFD')) content = raw.toString('latin1');
          subs.push({
            file: full,
            name,
            ext: ext.slice(1),
            lang: detectSubLang(name),
            label: langLabel(detectSubLang(name)),
            content,
          });
        } catch {}
      }
    }
    // Also any subtitle in dir if none matched (single video folder)
    if (subs.length === 0) {
      for (const name of entries) {
        const ext = path.extname(name).toLowerCase();
        if (!SUBTITLE_EXT.has(ext)) continue;
        try {
          const full = path.join(dir, name);
          let raw = fs.readFileSync(full);
          let content = raw.toString('utf8');
          if (content.includes('\uFFFD')) content = raw.toString('latin1');
          subs.push({
            file: full,
            name,
            ext: ext.slice(1),
            lang: detectSubLang(name),
            label: langLabel(detectSubLang(name)),
            content,
          });
        } catch {}
      }
    }
    return { ok: true, subs };
  } catch (e) {
    return { ok: false, error: String(e), subs: [] };
  }
});

ipcMain.handle('progress:save', (_e, filePath, time, length) => {
  if (!filePath || typeof time !== 'number' || typeof length !== 'number' || length <= 0) return { ok: false };
  progress[filePath] = { time, length, updatedAt: Date.now() };
  saveProgress();
  return { ok: true };
});

ipcMain.handle('history:logOpen', (_e, filePath) => {
  const entry = history[filePath] || { openCount: 0 };
  entry.openedAt = Date.now();
  entry.openCount = (entry.openCount || 0) + 1;
  entry.closedAt = null;
  history[filePath] = entry;
  saveHistory();
  return { ok: true };
});

ipcMain.handle('history:logClose', (_e, filePath) => {
  if (history[filePath]) {
    history[filePath].closedAt = Date.now();
    saveHistory();
  }
  return { ok: true };
});

ipcMain.handle('config:setEmbeddedPlayer', (_e, enabled) => {
  config.embeddedPlayer = !!enabled;
  saveConfig();
  return { ok: true, embeddedPlayer: config.embeddedPlayer };
});

ipcMain.handle('config:setToggle', (_e, key, value) => {
  const allowed = ['embeddedPlayer', 'autoNext', 'autoRescan', 'skipIntro'];
  if (!allowed.includes(key)) return { ok: false };
  config[key] = !!value;
  saveConfig();
  return { ok: true, key, value: config[key] };
});

ipcMain.handle('config:setNumber', (_e, key, value) => {
  const allowed = { autoNextSeconds: { min: 3, max: 30 } };
  if (!allowed[key]) return { ok: false };
  const n = Number(value);
  if (!Number.isFinite(n)) return { ok: false };
  config[key] = Math.max(allowed[key].min, Math.min(allowed[key].max, Math.round(n)));
  saveConfig();
  return { ok: true, key, value: config[key] };
});

ipcMain.handle('app:version', () => {
  return { version: app.getVersion(), name: app.getName() };
});

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

ipcMain.handle('app:checkUpdate', async () => {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.github.com',
      path: '/repos/davispikano/projflixmedia/releases/latest',
      method: 'GET',
      headers: { 'User-Agent': 'mediaflix-app', 'Accept': 'application/vnd.github+json' },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const latest = j.tag_name || j.name || '';
          const current = app.getVersion();
          const newer = compareSemver(latest, current) > 0;
          const asset = (j.assets || []).find((a) => /\.exe$/i.test(a.name));
          resolve({
            ok: true,
            current,
            latest,
            newer,
            url: j.html_url,
            downloadUrl: asset ? asset.browser_download_url : (j.html_url || null),
            notes: j.body || '',
          });
        } catch (e) { resolve({ ok: false, error: 'parse' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
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
  // Espelha console do renderer pro terminal (silencioso, util pra reportar bugs)
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer] ${message}`);
  });
  // Toggle DevTools com Ctrl+Shift+I (util pra debug do player)
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.control && input.shift && (input.key === 'I' || input.key === 'i')) {
      win.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  // Custom protocol pra streamar arquivos de vídeo locais de qualquer pasta
  // sem precisar baixar tudo pra memória nem expor file://.
  try {
    protocol.handle('mediaflix-file', (request) => {
      const url = decodeURIComponent(request.url.replace(/^mediaflix-file:\/\//, ''));
      // pode vir como /C:/path ou C:/path
      const cleaned = url.replace(/^\//, '');
      return net.fetch('file:///' + cleaned);
    });
  } catch (e) {
    console.error('protocol register fail', e);
  }
  createWindow();
});
app.on('window-all-closed', () => {
  stopPolling();
  killAllTransmux();
  if (vlcProcess) { try { vlcProcess.kill(); } catch {} }
  if (process.platform !== 'darwin') app.quit();
});
