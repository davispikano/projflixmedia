const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
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
        const looksLikeSeason = detectSeasonNumber(e.name) !== null;
        if (videos.length === 1 && !looksLikeSeason) {
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

    // Apply meta cache override if present
    const meta = metaCache[groupKeyFromName(s.title) || s.id];
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
            const tmdbName = epMap[ep.index];
            if (tmdbName) ep.title = tmdbName;
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
  const detailUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${config.tmdbKey}&language=${lang}`;
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
    fetchedAt: Date.now(),
    episodes: {}, // { [seasonNumber]: { [episodeNumber]: name } }
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
          if (ep.episode_number != null && ep.name) map[ep.episode_number] = ep.name;
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
    if (metaCache[key] && metaCache[key].banner) continue; // already have
    try {
      const result = await tmdbLookup(it.title, it.type === 'series' ? 'tv' : 'movie');
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
ipcMain.handle('meta:apply', async (_e, itemTitle, itemType, tmdbId, mediaType) => {
  if (!config.tmdbKey) return { ok: false, error: 'Sem chave TMDB configurada.' };
  const kind = mediaType === 'tv' || itemType === 'series' ? 'tv' : 'movie';
  try {
    const result = await buildMetaFromTmdbId(tmdbId, kind);
    const key = groupKeyFromName(itemTitle) || itemTitle.toLowerCase();
    metaCache[key] = result;
    saveMetaCache();
    return { ok: true, library: scanLibrary() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
