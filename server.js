const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Busboy = require('busboy');
const { randomUUID, randomBytes } = require('crypto');
let MongoClient = null;
try { ({ MongoClient } = require('mongodb')); } catch {}

const {
  cleanTitle,
  cleanEpisodeTitle,
  parseFile,
  detectSeasonNumber,
  detectSeasonAndEpisode,
  groupKeyFromName,
  isTrivialTitle,
} = require('./titleParser');

const PORT = Number(process.env.PORT || 3088);
const HOST = process.env.HOST || '0.0.0.0';
const dataDir = process.env.MEDIAFLIX_DATA_DIR || path.join(__dirname, '.mediaflix-data');
const configPath = path.join(dataDir, 'config.json');
const progressPath = path.join(dataDir, 'progress.json');
const historyPath = path.join(dataDir, 'history.json');
const profilesPath = path.join(dataDir, 'profiles.json');
const metaCachePath = path.join(dataDir, 'meta-cache.json');
const probeCachePath = path.join(dataDir, 'probe-cache.json');
const imdbTitlesPath = path.join(dataDir, 'imdb-titles.json');
const bannersDir = path.join(dataDir, 'banners');
const thumbsDir = path.join(dataDir, 'thumbnails');
try { fs.mkdirSync(bannersDir, { recursive: true }); } catch {}
try { fs.mkdirSync(thumbsDir, { recursive: true }); } catch {}

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.flv', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUBTITLE_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const NATIVE_VIDEO = new Set(['.mp4', '.webm', '.m4v', '.mov']);
const ALLOWED_UPLOAD_EXT = new Set([
  ...VIDEO_EXT,
  ...IMAGE_EXT,
  ...SUBTITLE_EXT,
]);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let config = readJson(configPath, {
  folders: (process.env.MEDIAFLIX_FOLDERS || '').split(path.delimiter).map((s) => s.trim()).filter(Boolean),
  tmdbKey: process.env.TMDB_KEY || '',
  tmdbLang: 'pt-BR',
  embeddedPlayer: true,
  autoNext: true,
  autoNextSeconds: 8,
  doubleTapSeconds: 5,
  autoRescan: false,
  autoDeleteWatched: false,
  skipIntro: true,
  autoSkipIntro: true,
  autoSkipIntroSeconds: 3,
  preferredAudioLang: 'pt',
  preferredSubLang: 'off',
  uploadToken: randomBytes(9).toString('hex'),
});
// Backfill defaults para configs antigos (preserva valores existentes)
if (config.autoDeleteWatched === undefined) config.autoDeleteWatched = false;
if (config.skipIntro === undefined) config.skipIntro = true;
if (config.autoSkipIntro === undefined) config.autoSkipIntro = true;
if (!Number.isFinite(config.autoSkipIntroSeconds)) config.autoSkipIntroSeconds = 3;
if (!config.doubleTapSeconds) config.doubleTapSeconds = 5;
if (!config.preferredAudioLang) config.preferredAudioLang = 'pt';
if (!config.preferredSubLang) config.preferredSubLang = 'off';
if (!config.uploadToken) { config.uploadToken = randomBytes(9).toString('hex'); writeJson(configPath, config); }
if (process.env.MEDIAFLIX_FOLDERS && !readJson(configPath, null)) writeJson(configPath, config);
let progress = readJson(progressPath, {});
let metaCache = readJson(metaCachePath, {});
function saveMetaCache() { writeJson(metaCachePath, metaCache); }
// Cache de probe (chapters/duration/audio/subs) por arquivo. Indexado por
// caminho ABSOLUTO. Quando convertemos MKV→MP4, guardamos chapters do MKV
// sob a chave do MP4 final tambem — assim o player sempre tem chapters
// mesmo se o MP4 perder metadados no remux.
let probeCache = readJson(probeCachePath, {});
function saveProbeCache() {
  try { writeJson(probeCachePath, probeCache); } catch (e) { console.error('probe cache save', e); }
}
let history = readJson(historyPath, {});
let profiles = readJson(profilesPath, []);
let libraryCache = null;

const mongo = { client: null, db: null, failed: false };
async function getDb() {
  if (!MongoClient || mongo.failed) return null;
  if (mongo.db) return mongo.db;
  try {
    const url = process.env.MEDIAFLIX_MONGODB_URL || 'mongodb://127.0.0.1:27017';
    mongo.client = new MongoClient(url, { serverSelectionTimeoutMS: 900 });
    await mongo.client.connect();
    mongo.db = mongo.client.db(process.env.MEDIAFLIX_MONGODB_DB || 'mediaflix');
    await Promise.all([
      mongo.db.collection('profiles').createIndex({ createdAt: 1 }),
      mongo.db.collection('watch_progress').createIndex({ profileId: 1, path: 1 }, { unique: true }),
      mongo.db.collection('watch_history').createIndex({ profileId: 1, path: 1 }, { unique: true }),
    ]);
    return mongo.db;
  } catch (e) {
    mongo.failed = true;
    console.warn('[mongo] usando fallback JSON:', e.message);
    return null;
  }
}

function saveConfig() { writeJson(configPath, config); }
function saveProgress() { writeJson(progressPath, progress); }
function saveHistory() { writeJson(historyPath, history); }
function saveProfiles() { writeJson(profilesPath, profiles); }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function text(res, status, body) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(body); }
function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => raw += d);
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
function normalize(p) { return path.resolve(String(p || '')); }
function isInside(child, parent) {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function isAllowedFile(filePath) {
  return config.folders.some((folder) => isInside(filePath, folder));
}
function safeExistingFile(filePath) {
  const p = normalize(filePath);
  if (!isAllowedFile(p) && !isInside(p, bannersDir)) return null;
  try { if (fs.statSync(p).isFile()) return p; } catch {}
  return null;
}

function naturalSort(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function findBanner(dir) {
  try {
    const entries = fs.readdirSync(dir);
    const candidates = ['banner', 'fanart', 'backdrop', 'poster', 'cover', 'folder'];
    for (const name of candidates) {
      for (const e of entries) {
        const lower = e.toLowerCase();
        if (IMAGE_EXT.has(path.extname(lower)) && lower.startsWith(name)) return path.join(dir, e);
      }
    }
    for (const e of entries) if (IMAGE_EXT.has(path.extname(e).toLowerCase())) return path.join(dir, e);
  } catch {}
  return null;
}
function listVideosRecursive(dir, depth = 0, max = 4) {
  const out = [];
  if (depth > max) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listVideosRecursive(full, depth + 1, max));
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !/\.transcoding\.mp4$/i.test(e.name)) out.push(full);
  }
  return out;
}
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
  const rootName = path.basename(watchedRoot);
  return !isTrivialTitle(cleanTitle(rootName)) ? rootName : path.basename(folder);
}

function preferEpisodeFile(a, b) {
  const score = (ep) => {
    const file = String(ep.file || ep.path || '').toLowerCase();
    let n = 0;
    if (!/\.transcoding\.mp4$/i.test(file)) n += 1000;
    if (/\.mp4$/i.test(file)) n += 120;
    if (/\.m4v$/i.test(file)) n += 100;
    if (/\.webm$/i.test(file)) n += 80;
    if (/\.mkv$/i.test(file)) n += 40;
    if (!/sample|trailer|preview/i.test(file)) n += 20;
    try { n += Math.min(10, fs.statSync(ep.path).size / (1024 * 1024 * 1024)); } catch {}
    return n;
  };
  return score(b) > score(a) ? b : a;
}
function dedupeSeasonEpisodes(episodes) {
  const byKey = new Map();
  const noNumber = [];
  for (const ep of episodes || []) {
    if (/\.transcoding\.mp4$/i.test(ep.file || ep.path || '')) continue;
    const n = Number(ep.episodeNum);
    if (Number.isFinite(n) && n > 0) {
      const key = String(n);
      byKey.set(key, byKey.has(key) ? preferEpisodeFile(byKey.get(key), ep) : ep);
    } else {
      const key = String(ep.path || ep.file || '');
      if (!byKey.has('path:' + key)) noNumber.push(ep);
      byKey.set('path:' + key, ep);
    }
  }
  const numbered = Array.from(byKey.entries()).filter(([k]) => !k.startsWith('path:')).map(([, ep]) => ep);
  return [...numbered, ...noNumber];
}

function scanLibrary() {
  const seriesByKey = new Map();
  const movies = [];
  config.folders = config.folders.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });
  for (const folder of config.folders) {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(folder, e.name);
      if (e.isDirectory()) {
        const videos = listVideosRecursive(full).sort(naturalSort);
        if (!videos.length) continue;
        const banner = findBanner(full);
        const looksLikeSeason = detectSeasonNumber(e.name) !== null;
        const singleFileLooksLikeEpisode = videos.length === 1 && (() => {
          const det = detectSeasonAndEpisode(path.basename(videos[0]));
          return det.season != null || det.episode != null;
        })();
        if (videos.length === 1 && !looksLikeSeason && !singleFileLooksLikeEpisode) {
          movies.push({ id: full, type: 'movie', title: cleanTitle(e.name), rawTitle: e.name, path: videos[0], banner, folder: full });
          continue;
        }
        const folderName = pickMeaningfulName(full, folder);
        // Se o nome derivado da pasta ainda for trivial (ex.: "s7", "media",
        // "season 01"), tenta extrair o titulo da serie pelo nome do primeiro
        // video — evita criar uma serie duplicada quando o usuario faz upload
        // pra uma pasta com nome generico.
        let showName = folderName;
        if (isTrivialTitle(cleanTitle(folderName))) {
          for (const v of videos) {
            const parsed = parseFile(path.basename(v)) || {};
            if (parsed.title && !isTrivialTitle(parsed.title)) { showName = parsed.title; break; }
          }
        }
        const key = groupKeyFromName(showName) || showName.toLowerCase();
        let series = seriesByKey.get(key);
        if (!series) {
          series = { id: 'series:' + key, type: 'series', title: cleanTitle(showName) || showName, rawTitle: showName, banner, folder: full, folders: [], seasons: new Map() };
          seriesByKey.set(key, series);
        }
        series.folders.push(full);
        if (!series.banner && banner) series.banner = banner;
        const seasonNum = detectSeasonNumber(e.name);
        for (const v of videos) {
          const det = detectSeasonAndEpisode(path.basename(v));
          const sNum = det.season || seasonNum || 1;
          let season = series.seasons.get(sNum);
          if (!season) { season = { number: sNum, folder: full, episodes: [] }; series.seasons.set(sNum, season); }
          season.episodes.push({ path: v, file: path.basename(v), episodeNum: det.episode });
        }
      } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !/\.transcoding\.mp4$/i.test(e.name)) {
        const det = detectSeasonAndEpisode(e.name);
        if (det.season != null || det.episode != null) {
          const parsed = parseFile(e.name) || {};
          const parentName = path.basename(folder);
          // If the episode is loose in the watched root (/media), infer the show
          // name from the filename instead of creating a fake "Media" series.
          const parsedTitle = parsed.title && !isTrivialTitle(parsed.title) ? parsed.title : '';
          const showName = (config.folders.includes(folder) && parsedTitle) ? parsedTitle : parentName;
          const key = groupKeyFromName(showName) || showName.toLowerCase();
          let series = seriesByKey.get(key);
          if (!series) { series = { id: 'series:' + key, type: 'series', title: cleanTitle(showName) || showName, rawTitle: showName, banner: findBanner(folder), folder, folders: [folder], seasons: new Map() }; seriesByKey.set(key, series); }
          const sNum = det.season || 1;
          let season = series.seasons.get(sNum);
          if (!season) { season = { number: sNum, folder, episodes: [] }; series.seasons.set(sNum, season); }
          season.episodes.push({ path: full, file: e.name, episodeNum: det.episode, title: cleanEpisodeTitle(e.name) });
        } else movies.push({ id: full, type: 'movie', title: cleanTitle(e.name), rawTitle: e.name, path: full, banner: null, folder });
      }
    }
  }
  const series = Array.from(seriesByKey.values()).map((s) => {
    const seasons = Array.from(s.seasons.values()).sort((a, b) => a.number - b.number).map((season) => {
      season.episodes = dedupeSeasonEpisodes(season.episodes);
      season.episodes.sort((a, b) => (a.episodeNum || 9999) - (b.episodeNum || 9999) || naturalSort(a.file, b.file));
      season.episodes = season.episodes.map((ep, i) => ({ ...ep, season: season.number, episode: ep.episodeNum || i + 1, index: i + 1, title: ep.title || cleanEpisodeTitle(ep.file) || cleanTitle(ep.file) }));
      return season;
    });
    // Merge TMDB meta cache
    const primaryKey = groupKeyFromName(s.title) || s.id;
    let meta = metaCache[primaryKey];
    if (meta && meta.title) {
      const altKey = groupKeyFromName(meta.title);
      if (altKey && altKey !== primaryKey && metaCache[altKey]) {
        const alt = metaCache[altKey];
        if ((!meta.episodes || !Object.keys(meta.episodes).length) && alt.episodes) {
          meta = { ...meta, ...alt, episodes: { ...(meta.episodes || {}), ...(alt.episodes || {}) } };
        } else {
          meta = { ...alt, ...meta, episodes: { ...(alt.episodes || {}), ...(meta.episodes || {}) } };
        }
      }
    }
    let extra = {};
    if (meta) {
      if (meta.title) s.title = meta.title;
      if (meta.banner) s.banner = meta.banner;
      else if (meta.poster && !s.banner) s.banner = meta.poster;
      extra.poster = meta.poster || null;
      extra.overview = meta.overview || null;
      extra.year = meta.year || null;
      extra.imdbId = meta.imdbId || (meta.imdb && meta.imdb.id) || null;
      if (meta.episodes) {
        for (const season of seasons) {
          const epMap = meta.episodes[season.number];
          if (!epMap) continue;
          for (const ep of season.episodes) {
            // TMDB usa episode_number real (1-N) como chave, NUNCA index posicional.
            // Usar ep.index aqui bagunça tudo quando faltam eps no inicio da temporada.
            const entry = epMap[ep.episode] || epMap[String(ep.episode)];
            if (!entry) continue;
            if (typeof entry === 'string') { if (entry) ep.title = entry; }
            else {
              if (entry.name) ep.title = entry.name;
              if (entry.overview) ep.overview = entry.overview;
              if (entry.airDate) ep.airDate = entry.airDate;
              if (entry.stillPath) ep.stillPath = entry.stillPath;
            }
          }
          // Preenche EPISODIOS faltantes da temporada (que existem no TMDB
          // mas nao no disco) como placeholders `missing:true` — sem path,
          // pra UI mostrar cinza/indisponivel mas o usuario ja ver o que
          // a serie tem.
          const haveEpNums = new Set(season.episodes.map((e) => Number(e.episode)).filter(Number.isFinite));
          for (const epNumStr of Object.keys(epMap)) {
            const epNum = Number(epNumStr);
            if (!Number.isFinite(epNum) || epNum <= 0) continue;
            if (haveEpNums.has(epNum)) continue;
            const entry = epMap[epNumStr];
            const ph = {
              missing: true,
              season: season.number,
              episode: epNum,
              index: epNum,
              file: null,
              path: null,
              title: (entry && entry.name) || `Episódio ${epNum}`,
              overview: (entry && entry.overview) || '',
              airDate: (entry && entry.airDate) || null,
              stillPath: (entry && entry.stillPath) || null,
            };
            season.episodes.push(ph);
          }
          season.episodes.sort((a, b) => (Number(a.episode) || 9999) - (Number(b.episode) || 9999));
        }
        // Cria TEMPORADAS inteiras que existem no TMDB mas nao temos
        // localmente (ex: usuario so subiu S01 mas ja existem S02, S03 na serie).
        const haveSeasonNums = new Set(seasons.map((s) => Number(s.number)));
        for (const sNumStr of Object.keys(meta.episodes)) {
          const sNum = Number(sNumStr);
          if (!Number.isFinite(sNum) || sNum <= 0) continue;
          if (haveSeasonNums.has(sNum)) continue;
          const epMap = meta.episodes[sNumStr] || {};
          const eps = Object.keys(epMap)
            .map((k) => Number(k))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => a - b)
            .map((epNum) => {
              const entry = epMap[epNum] || epMap[String(epNum)] || {};
              return {
                missing: true,
                season: sNum,
                episode: epNum,
                index: epNum,
                file: null,
                path: null,
                title: entry.name || `Episódio ${epNum}`,
                overview: entry.overview || '',
                airDate: entry.airDate || null,
                stillPath: entry.stillPath || null,
              };
            });
          if (eps.length) seasons.push({ number: sNum, folder: null, episodes: eps, missing: true });
        }
        seasons.sort((a, b) => a.number - b.number);
      }
      if (meta.imdb) {
        extra.imdbId = meta.imdb.id || meta.imdbId || extra.imdbId || null;
        extra.imdbRating = typeof meta.imdb.average === 'number' ? meta.imdb.average : null;
        extra.imdbSource = meta.imdb.source || 'imdb';
        if (meta.imdb.seasons) {
          for (const season of seasons) {
            const rMap = meta.imdb.seasons[season.number] || meta.imdb.seasons[String(season.number)];
            if (!rMap) continue;
            for (const ep of season.episodes) {
              const r = rMap[ep.episode] ?? rMap[String(ep.episode)] ?? rMap[ep.index] ?? rMap[String(ep.index)];
              if (typeof r === 'number') ep.imdbRating = r;
            }
          }
        }
      }
    }
    return { ...s, ...extra, seasons, episodes: seasons.flatMap((x) => x.episodes) };
  });
  for (const m of movies) {
    const meta = metaCache[groupKeyFromName(m.title) || m.id];
    if (!meta) continue;
    if (meta.title) m.title = meta.title;
    if (meta.banner) m.banner = meta.banner;
    else if (meta.poster && !m.banner) m.banner = meta.poster;
    m.poster = meta.poster || null;
    m.overview = meta.overview || null;
    m.year = meta.year || null;
    m.imdbId = meta.imdbId || (meta.imdb && meta.imdb.id) || null;
    if (meta.imdb) { m.imdbRating = typeof meta.imdb.average === 'number' ? meta.imdb.average : null; m.imdbSource = meta.imdb.source || 'imdb'; }
  }
  libraryCache = [...series, ...movies].sort((a, b) => a.title.localeCompare(b.title));
  return libraryCache;
}

let ffmpegStaticPath = null;
let ffprobeStaticPath = null;
try { ffmpegStaticPath = require('ffmpeg-static'); } catch {}
try { ffprobeStaticPath = require('ffprobe-static').path; } catch {}
const getFfmpegPath = () => ffmpegStaticPath;
const getFfprobePath = () => ffprobeStaticPath;
const probeMemCache = new Map();
function probeFile(filePath) {
  return new Promise((resolve) => {
    const p = safeExistingFile(filePath);
    if (!p) return resolve({ audio: [], subs: [], duration: 0, chapters: [] });
    if (probeMemCache.has(p)) return resolve(probeMemCache.get(p));
    const ffprobe = getFfprobePath();
    if (!ffprobe) {
      // Sem ffprobe — tenta cache persistido
      const cached = probeCache[p];
      if (cached) return resolve(cached);
      return resolve({ audio: [], subs: [], duration: 0, chapters: [] });
    }
    const proc = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', p], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout.on('data', (d) => buf += d.toString());
    proc.on('exit', () => {
      try {
        const j = JSON.parse(buf);
        const duration = parseFloat((j.format && j.format.duration) || 0) || 0;
        const audio = (j.streams || []).filter((s) => s.codec_type === 'audio').map((s, i) => ({ index: i, lang: ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase(), title: (s.tags && (s.tags.title || s.tags.TITLE)) || '', codec: s.codec_name }));
        const subs = (j.streams || []).filter((s) => s.codec_type === 'subtitle').map((s, i) => ({ index: i, lang: ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase(), title: (s.tags && (s.tags.title || s.tags.TITLE)) || '', codec: s.codec_name }));
        let chapters = (j.chapters || []).map((c) => ({ start: parseFloat(c.start_time) || 0, end: parseFloat(c.end_time) || 0, title: (c.tags && (c.tags.title || c.tags.TITLE)) || '' }));
        // Fallback: se o arquivo nao tem chapters embedded mas temos cache
        // do MKV original (caso o transcode tenha perdido metadados), usa o cache.
        if (!chapters.length && probeCache[p] && Array.isArray(probeCache[p].chapters)) {
          chapters = probeCache[p].chapters;
        }
        const out = { audio, subs, duration: duration || (probeCache[p] && probeCache[p].duration) || 0, chapters };
        probeMemCache.set(p, out);
        resolve(out);
      } catch {
        const cached = probeCache[p];
        if (cached) return resolve(cached);
        resolve({ audio: [], subs: [], duration: 0, chapters: [] });
      }
    });
    proc.on('error', () => {
      const cached = probeCache[p];
      if (cached) return resolve(cached);
      resolve({ audio: [], subs: [], duration: 0, chapters: [] });
    });
  });
}
// Mapa de idioma -> regex matching para identificar uma faixa (audio/sub).
// Cobre codigos ISO 639-1 e 639-2 + sinonimos em PT/EN.
const LANG_MATCHERS = {
  pt: { re: /^(pt|por|ptg|pob|prt)$/i, alt: /pt.?br|brazil|brasil|portug|portuguese/i },
  en: { re: /^(en|eng|enm)$/i, alt: /english|ingl[eê]s/i },
  es: { re: /^(es|spa|esp)$/i, alt: /spanish|espa[nñ]ol|castellano/i },
  ja: { re: /^(ja|jpn|jap)$/i, alt: /japanese|japon[eê]s/i },
  fr: { re: /^(fr|fra|fre)$/i, alt: /french|franc[eê]s/i },
  it: { re: /^(it|ita)$/i, alt: /italian|italiano/i },
  de: { re: /^(de|deu|ger)$/i, alt: /german|alem[aã]o/i },
  ko: { re: /^(ko|kor)$/i, alt: /korean|coreano/i },
  zh: { re: /^(zh|zho|chi|cmn)$/i, alt: /chinese|chin[eê]s|mandarin/i },
  ru: { re: /^(ru|rus)$/i, alt: /russian|russo/i },
};

function trackMatchesLang(track, langCode) {
  if (!langCode || langCode === 'off') return false;
  const m = LANG_MATCHERS[langCode];
  if (!m) return false;
  const lang = (track.lang || '').toLowerCase();
  const title = (track.title || '').toLowerCase();
  return m.re.test(lang) || m.alt.test(title) || m.alt.test(lang);
}

function pickPreferredAudio(audioTracks, langCode) {
  if (!audioTracks || !audioTracks.length) return 0;
  const target = (langCode || config.preferredAudioLang || 'pt').toLowerCase();
  // 1) Match por lang code exato (ex.: pt-br tem prioridade sobre pt)
  if (target === 'pt') {
    const ptbr = audioTracks.find((a) => /pt.?br|brazil|brasil/i.test(a.lang) || /pt.?br|brazil|brasil/i.test(a.title));
    if (ptbr) return ptbr.index;
  }
  // 2) Match generico via LANG_MATCHERS
  const m = audioTracks.find((a) => trackMatchesLang(a, target));
  if (m) return m.index;
  // 3) Fallback: primeira faixa
  return audioTracks[0].index;
}

// ---------- TMDB ----------
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mediaflix/0.3' } }, (r) => {
      if (r.statusCode && r.statusCode >= 400) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
function downloadToBanners(url, fileName) {
  fs.mkdirSync(bannersDir, { recursive: true });
  const dest = path.join(bannersDir, fileName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve(dest);
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (r) => {
      if (r.statusCode && r.statusCode >= 400) { file.close(); fs.unlink(dest, () => {}); return reject(new Error('HTTP ' + r.statusCode)); }
      r.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (err) => { file.close(); fs.unlink(dest, () => {}); reject(err); });
  });
}
async function buildMetaFromTmdbId(tmdbId, type, neededSeasons) {
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
  const detailUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${config.tmdbKey}&language=${lang}&append_to_response=external_ids`;
  const j = await httpsGetJson(detailUrl);
  const name = j.name || j.title;
  const year = (j.first_air_date || j.release_date || '').slice(0, 4);
  const result = {
    tmdbId, type,
    title: name,
    year: year || null,
    overview: j.overview || '',
    posterPath: j.poster_path,
    backdropPath: j.backdrop_path,
    imdbId: (j.external_ids && j.external_ids.imdb_id) || null,
    fetchedAt: Date.now(),
    episodes: {},
  };
  if (j.backdrop_path) {
    try {
      const ext = path.extname(j.backdrop_path) || '.jpg';
      const fname = 'bd_' + Buffer.from(j.backdrop_path).toString('base64url') + ext;
      result.banner = await downloadToBanners(`https://image.tmdb.org/t/p/w1280${j.backdrop_path}`, fname);
    } catch {}
  }
  if (j.poster_path) {
    try {
      const ext = path.extname(j.poster_path) || '.jpg';
      const fname = 'p_' + Buffer.from(j.poster_path).toString('base64url') + ext;
      result.poster = await downloadToBanners(`https://image.tmdb.org/t/p/w500${j.poster_path}`, fname);
    } catch {}
  }
  if (type === 'tv' && Array.isArray(j.seasons)) {
    const want = j.seasons.map((s) => s.season_number).filter((n) => n != null && n > 0).filter((n) => !neededSeasons || neededSeasons.includes(n));
    for (const sn of want) {
      try {
        const sj = await httpsGetJson(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${sn}?api_key=${config.tmdbKey}&language=${lang}`);
        const map = {};
        for (const ep of sj.episodes || []) {
          if (ep.episode_number == null) continue;
          map[ep.episode_number] = { name: ep.name || null, overview: ep.overview || null, airDate: ep.air_date || null, stillPath: ep.still_path || null };
        }
        result.episodes[sn] = map;
        await new Promise((r) => setTimeout(r, 150));
      } catch {}
    }
  }
  return result;
}
async function tmdbLookup(title, type) {
  if (!config.tmdbKey) throw new Error('Sem chave TMDB.');
  const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
  const variations = [];
  const t = String(title).trim();
  variations.push(t);
  const colon = t.split(/\s[:\-–]\s|:\s/)[0].trim();
  if (colon && colon !== t && colon.length > 2) variations.push(colon);
  const short = t.split(/\s+/).slice(0, 5).join(' ');
  if (short && !variations.includes(short)) variations.push(short);
  let first = null;
  for (const v of variations) {
    const q = encodeURIComponent(v);
    for (const l of [lang, 'en-US']) {
      try {
        const j = await httpsGetJson(`https://api.themoviedb.org/3/search/${type}?api_key=${config.tmdbKey}&language=${l}&query=${q}&include_adult=false`);
        if (j.results && j.results.length) { first = j.results[0]; break; }
      } catch {}
    }
    if (first) break;
  }
  if (!first) return null;
  return await buildMetaFromTmdbId(first.id, type);
}

function streamVideo(req, res, filePath, u) {
  const p = safeExistingFile(filePath);
  if (!p) return text(res, 404, 'not found');
  const ext = path.extname(p).toLowerCase();
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (NATIVE_VIDEO.has(ext)) {
    const stat = fs.statSync(p);
    const range = req.headers.range;
    const mime = ext === '.webm' ? 'video/webm' : 'video/mp4';
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p).pipe(res);
    }
    return;
  }
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) return text(res, 500, 'ffmpeg not found');
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'Transfer-Encoding': 'chunked' });
  const ss = u.searchParams.get('ss');
  const audioIdx = parseInt(u.searchParams.get('a') || '0', 10);
  const args = [];
  if (ss) args.push('-ss', ss);
  args.push('-threads', '2', '-i', p, '-map', '0:v:0', '-map', `0:a:${audioIdx}?`, '-c:v', 'libx264', '-preset', 'superfast', '-tune', 'zerolatency', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2", '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');
  const proc = spawnLowPriority(ffmpeg, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch {} });
}
function detectSubLang(name) {
  const m = name.match(/\.([a-z]{2,3}(?:-[a-z]{2})?)\.[a-z]+$/i);
  if (m) return m[1].toLowerCase();
  if (/portug|\bpt\b|\bbr\b|\bpor\b/i.test(name)) return 'pt';
  if (/english|\beng\b|\ben\b/i.test(name)) return 'en';
  if (/spanish|\bspa\b|\bes\b/i.test(name)) return 'es';
  return '';
}
function langLabel(code) { return ({ pt: 'Português', 'pt-br': 'Português (BR)', por: 'Português', en: 'English', eng: 'English', es: 'Español', spa: 'Español' }[code] || (code ? code.toUpperCase() : 'Legenda')); }

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color || '#e11d48',
    avatar: profile.avatar || 'M',
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
function cleanProfileName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 32) || 'Perfil';
}
function profileInitial(name) {
  return cleanProfileName(name).slice(0, 1).toUpperCase() || 'P';
}
function fallbackProfiles() {
  if (!Array.isArray(profiles)) profiles = [];
  if (!profiles.length) {
    const now = Date.now();
    profiles.push({ id: 'default', name: 'Davi', avatar: 'D', color: '#e11d48', createdAt: now, updatedAt: now });
    saveProfiles();
  }
  return profiles;
}
async function listProfiles() {
  const db = await getDb();
  if (db) {
    const count = await db.collection('profiles').countDocuments();
    if (!count) {
      const now = Date.now();
      await db.collection('profiles').insertOne({ id: 'default', name: 'Davi', avatar: 'D', color: '#e11d48', createdAt: now, updatedAt: now });
    }
    return (await db.collection('profiles').find({}).sort({ createdAt: 1 }).toArray()).map(publicProfile);
  }
  return fallbackProfiles().map(publicProfile);
}

async function deleteProfile(profileId) {
  const id = String(profileId || '').slice(0, 80);
  if (!id) return { ok: false, error: 'Perfil inválido.' };
  const db = await getDb();
  if (db) {
    const total = await db.collection('profiles').countDocuments();
    if (total <= 1) return { ok: false, error: 'Crie outro perfil antes de apagar o último.' };
    const found = await db.collection('profiles').findOne({ id });
    if (!found) return { ok: false, error: 'Perfil não encontrado.' };
    await Promise.all([
      db.collection('profiles').deleteOne({ id }),
      db.collection('watch_progress').deleteMany({ profileId: id }),
      db.collection('watch_history').deleteMany({ profileId: id }),
    ]);
    return { ok: true, deletedId: id, storage: 'mongo' };
  }
  const list = fallbackProfiles();
  if (list.length <= 1) return { ok: false, error: 'Crie outro perfil antes de apagar o último.' };
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, error: 'Perfil não encontrado.' };
  list.splice(idx, 1);
  delete progress[id];
  delete history[id];
  saveProfiles();
  saveProgress();
  saveHistory();
  return { ok: true, deletedId: id, storage: 'json' };
}
async function storageStatus() {
  const db = await getDb();
  if (!db) return { ok: true, storage: 'json', mongo: false, dataDir };
  const [profilesCount, progressCount, historyCount] = await Promise.all([
    db.collection('profiles').countDocuments(),
    db.collection('watch_progress').countDocuments(),
    db.collection('watch_history').countDocuments(),
  ]);
  return { ok: true, storage: 'mongo', mongo: true, db: db.databaseName, collections: { profiles: profilesCount, watch_progress: progressCount, watch_history: historyCount } };
}

async function createProfile(data) {
  const now = Date.now();
  const profile = {
    id: randomUUID(),
    name: cleanProfileName(data && data.name),
    avatar: profileInitial(data && data.name),
    color: (data && /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : ['#e11d48', '#7c3aed', '#0891b2', '#16a34a', '#f59e0b'][Math.floor(Math.random() * 5)]),
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  if (db) await db.collection('profiles').insertOne(profile);
  else { fallbackProfiles(); profiles.push(profile); saveProfiles(); }
  return publicProfile(profile);
}
function profileIdFrom(u, body) {
  return String((body && body.profileId) || u.searchParams.get('profileId') || 'default').slice(0, 80);
}
function scopedStore(root, profileId) {
  if (!root[profileId] || typeof root[profileId] !== 'object') root[profileId] = {};
  return root[profileId];
}
async function getProgressFor(profileId) {
  const db = await getDb();
  if (db) {
    const docs = await db.collection('watch_progress').find({ profileId }).toArray();
    return Object.fromEntries(docs.map((d) => [d.path, { time: d.time, length: d.length, updatedAt: d.updatedAt }]));
  }
  return scopedStore(progress, profileId);
}
async function saveProgressFor(profileId, filePath, time, length, updatedAt) {
  const incomingTime = Number(time) || 0;
  const incomingLength = Number(length) || 0;
  const incomingUpdatedAt = Number(updatedAt) || Date.now();
  const entry = { profileId, path: filePath, time: incomingTime, length: incomingLength, updatedAt: incomingUpdatedAt };
  const db = await getDb();
  if (db) {
    const existing = await db.collection('watch_progress').findOne({ profileId, path: filePath });
    if (shouldIgnoreProgressSave(existing, entry)) return false;
    await db.collection('watch_progress').updateOne({ profileId, path: filePath }, { $set: entry }, { upsert: true });
  } else {
    const store = scopedStore(progress, profileId);
    if (shouldIgnoreProgressSave(store[filePath], entry)) return false;
    store[filePath] = { time: entry.time, length: entry.length, updatedAt: entry.updatedAt };
    saveProgress();
  }
  return true;
}
function shouldIgnoreProgressSave(existing, incoming) {
  if (!existing) return false;
  const oldTime = Number(existing.time) || 0;
  const newTime = Number(incoming.time) || 0;
  // Protege contra o bug clássico: ao reabrir um episódio nativo, o <video>
  // dispara timeupdate em 0s antes do seek de retomada e apaga um progresso bom.
  if (oldTime > 60 && newTime < 30 && newTime < oldTime - 30) return true;
  return false;
}
async function clearProgressFor(profileId, filePath) {
  const db = await getDb();
  if (db) await db.collection('watch_progress').deleteOne({ profileId, path: filePath });
  else { delete scopedStore(progress, profileId)[filePath]; saveProgress(); }
}
async function getHistoryFor(profileId) {
  const db = await getDb();
  if (db) {
    const docs = await db.collection('watch_history').find({ profileId }).toArray();
    return Object.fromEntries(docs.map((d) => [d.path, { openedAt: d.openedAt, closedAt: d.closedAt, openCount: d.openCount || 0 }]));
  }
  return scopedStore(history, profileId);
}
async function logOpenFor(profileId, filePath) {
  const now = Date.now();
  const db = await getDb();
  if (db) {
    await db.collection('watch_history').updateOne({ profileId, path: filePath }, { $set: { profileId, path: filePath, openedAt: now, closedAt: null }, $inc: { openCount: 1 } }, { upsert: true });
  } else {
    const store = scopedStore(history, profileId);
    const e = store[filePath] || { openCount: 0 };
    e.openedAt = now; e.openCount = (e.openCount || 0) + 1; e.closedAt = null;
    store[filePath] = e; saveHistory();
  }
}
async function logCloseFor(profileId, filePath) {
  const now = Date.now();
  const db = await getDb();
  if (db) await db.collection('watch_history').updateOne({ profileId, path: filePath }, { $set: { closedAt: now } });
  else { const store = scopedStore(history, profileId); if (store[filePath]) { store[filePath].closedAt = now; saveHistory(); } }
}
async function clearHistoryFor(profileId) {
  const db = await getDb();
  if (db) await db.collection('watch_history').deleteMany({ profileId });
  else { history[profileId] = {}; saveHistory(); }
}



async function deleteMediaFile(filePath) {
  const p = safeExistingFile(filePath);
  if (!p) return { ok: false, error: 'Arquivo não encontrado ou fora das pastas permitidas.' };
  if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) return { ok: false, error: 'Só vídeos podem ser apagados por aqui.' };
  let size = 0;
  try { size = fs.statSync(p).size || 0; } catch {}
  try {
    fs.unlinkSync(p);
  } catch (e) {
    return { ok: false, error: 'Não consegui apagar o arquivo: ' + e.message };
  }
  const db = await getDb();
  if (db) {
    await Promise.all([
      db.collection('watch_progress').deleteMany({ path: p }),
      db.collection('watch_history').deleteMany({ path: p }),
    ]);
  } else {
    for (const profileId of Object.keys(progress || {})) delete progress[profileId][p];
    for (const profileId of Object.keys(history || {})) delete history[profileId][p];
    saveProgress();
    saveHistory();
  }
  libraryCache = null;
  return { ok: true, path: p, deletedBytes: size, library: scanLibrary() };
}

// Decisão pura (testável) de auto-exclusão a partir do progresso de TODOS os
// perfis para um mesmo ficheiro. `progressByProfile` = { profileId: ratio }.
// Regras (ver spec 2026-05-31-auto-delete-watched-design):
//  - perfil atual precisa estar assistido (ratio >= 0.90) => garante que o
//    processo de assistir foi gravado no banco antes de apagar;
//  - nenhum OUTRO perfil pode estar a meio (0.05 < ratio < 0.90).
const AUTO_DELETE_WATCHED_RATIO = 0.90;
const AUTO_DELETE_STARTED_RATIO = 0.05;
function shouldAutoDelete(progressByProfile, currentProfileId) {
  const cur = Number(progressByProfile && progressByProfile[currentProfileId]) || 0;
  if (cur < AUTO_DELETE_WATCHED_RATIO) return { ok: false, reason: 'not-finished' };
  for (const [pid, ratioRaw] of Object.entries(progressByProfile || {})) {
    if (pid === currentProfileId) continue;
    const ratio = Number(ratioRaw) || 0;
    if (ratio > AUTO_DELETE_STARTED_RATIO && ratio < AUTO_DELETE_WATCHED_RATIO) {
      return { ok: false, reason: 'in-use-by-other' };
    }
  }
  return { ok: true };
}

// Lê o ratio (time/length) de progresso de cada perfil para um único path.
async function progressRatiosForPath(filePath) {
  const ratios = {};
  const db = await getDb();
  if (db) {
    const docs = await db.collection('watch_progress').find({ path: filePath }).toArray();
    for (const d of docs) {
      const len = Number(d.length) || 0;
      ratios[d.profileId] = len > 0 ? (Number(d.time) || 0) / len : 0;
    }
  } else {
    for (const [profileId, store] of Object.entries(progress || {})) {
      const e = store && store[filePath];
      if (!e) continue;
      const len = Number(e.length) || 0;
      ratios[profileId] = len > 0 ? (Number(e.time) || 0) / len : 0;
    }
  }
  return ratios;
}

// Verifica e (se for o caso) apaga um episódio já assistido. Toda a decisão é
// feita no servidor a partir do banco; o cliente só passa o path e o perfil.
async function autoDeleteWatchedFile(filePath, profileId) {
  if (!config.autoDeleteWatched) return { ok: true, deleted: false, reason: 'disabled' };
  const p = safeExistingFile(filePath);
  if (!p) return { ok: true, deleted: false, reason: 'invalid' };
  if (!VIDEO_EXT.has(path.extname(p).toLowerCase())) return { ok: true, deleted: false, reason: 'invalid' };
  const ratios = await progressRatiosForPath(p);
  const decision = shouldAutoDelete(ratios, String(profileId || 'default'));
  if (!decision.ok) return { ok: true, deleted: false, reason: decision.reason };
  const del = await deleteMediaFile(p);
  if (!del.ok) return { ok: false, deleted: false, reason: 'delete-failed', error: del.error };
  return { ok: true, deleted: true, deletedBytes: del.deletedBytes, library: del.library, path: p };
}

function safeRelativeUploadPath(name) {
  let rel = String(name || 'arquivo').replace(/\\/g, '/').replace(/^\/+/, '');
  rel = rel.split('/').filter((part) => part && part !== '.' && part !== '..').join('/');
  rel = rel.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  return rel || ('upload-' + Date.now());
}
function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  for (let i = 1; i < 1000; i++) {
    const next = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}
function requireUploadToken(req, u) {
  const supplied = req.headers['x-mediaflix-upload-token'] || u.searchParams.get('token') || '';
  return config.uploadToken && supplied === config.uploadToken;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- IMDb ratings (web backend) ----------
const IMDB_DATA_BASE = 'https://cdn.jsdelivr.net/gh/mokronos/imdb-heatmap@main/data';
function imdbNormalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
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
      if (r.year) {
        const ky = imdbNormalize(`${r.title} ${r.year}`);
        if (ky && !map[ky]) map[ky] = r.id;
      }
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
  if (year) variants.unshift(`${title} ${year}`);
  for (const v of variants) {
    const id = imdbTitleIndex.get(imdbNormalize(v));
    if (id) return id;
  }
  return null;
}
async function fetchImdbRatings(imdbId) {
  try {
    const seasons = await httpsGetJson(`${IMDB_DATA_BASE}/${imdbId}.json`);
    const seasonMap = {};
    let total = 0, count = 0;
    if (Array.isArray(seasons)) {
      seasons.forEach((eps, sIdx) => {
        const epMap = {};
        (eps || []).forEach((ep, eIdx) => {
          const r = ep && Number(ep.rating);
          if (Number.isFinite(r) && r > 0) {
            epMap[eIdx + 1] = +r.toFixed(1);
            total += r;
            count++;
          }
        });
        if (Object.keys(epMap).length) seasonMap[sIdx + 1] = epMap;
      });
    }
    return { id: imdbId, average: count ? +(total / count).toFixed(2) : null, seasons: seasonMap };
  } catch {
    return { id: imdbId, average: null, seasons: {} };
  }
}
async function resolveTmdbAverage(cached, kind) {
  if (!config.tmdbKey || !cached || !cached.tmdbId) return null;
  try {
    const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
    const det = await httpsGetJson(`https://api.themoviedb.org/3/${kind}/${cached.tmdbId}?api_key=${config.tmdbKey}&language=${lang}`);
    if (typeof det.vote_average === 'number' && det.vote_average > 0) return +det.vote_average.toFixed(1);
  } catch {}
  return null;
}
async function fetchAllImdbRatings() {
  await getImdbTitleIndex();
  const items = scanLibrary();
  let updated = 0, missing = 0, skipped = 0;
  for (const it of items) {
    const key = groupKeyFromName(it.title) || it.id;
    const cached = metaCache[key] || {};
    const kind = cached.type || (it.type === 'series' ? 'tv' : 'movie');
    if (cached.imdb && cached.imdb.average != null && cached.imdb.seasons) { skipped++; continue; }
    let id = cached.imdbId || (cached.imdb && cached.imdb.id) || it.imdbId || null;
    if (!id && config.tmdbKey && cached.tmdbId) {
      try {
        const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
        const ext = await httpsGetJson(`https://api.themoviedb.org/3/${kind}/${cached.tmdbId}/external_ids?api_key=${config.tmdbKey}&language=${lang}`);
        if (ext && ext.imdb_id) id = ext.imdb_id;
      } catch {}
    }
    if (!id) id = findImdbIdForTitle(it.title, it.year);
    if (!id) { missing++; continue; }
    const data = await fetchImdbRatings(id);
    if (!data || data.average == null) {
      const tmdbAvg = await resolveTmdbAverage(cached, kind);
      if (tmdbAvg != null) {
        metaCache[key] = { ...cached, imdbId: id, imdb: { id, average: tmdbAvg, source: 'tmdb', seasons: {} } };
        updated++;
      } else {
        metaCache[key] = { ...cached, imdbId: id, imdb: { id, average: null, source: 'imdb', seasons: {} } };
        missing++;
      }
    } else {
      metaCache[key] = { ...cached, imdbId: id, imdb: { ...data, source: 'imdb' } };
      updated++;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  saveMetaCache();
  libraryCache = null;
  return { ok: true, updated, missing, skipped, library: scanLibrary() };
}

// ---------- Auto-transcode MKV/AVI → MP4 com chapters preservados ----------
// Faz remux quando possível (H.264 + AAC) e re-encode quando necessário.
// Sempre preserva metadados de capítulos (-map_chapters 0).
const transcodeQueue = [];
// Concorrencia=1 por padrao (servidor com 2 vCPUs compartilhados com varios apps).
// User pode subir via env TRANSCODE_CONCURRENCY=2 se quiser priorizar velocidade.
const TRANSCODE_CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '1', 10));
let transcodeRunning = 0;
const transcodeStatus = new Map(); // path -> { state, progress, error, startedAt }

// Progresso de uploads (chunked) por uploadId, para que QUALQUER dispositivo
// (ex.: celular) possa acompanhar o % de um envio iniciado noutro device.
const activeUploads = new Map(); // uploadId -> { id, startedAt, updatedAt, completedAt, totalBytes, receivedBytes, totalFiles, files: {fileIndex:{name,size,received,totalChunks,done}} }

function trackUploadChunk({ uploadId, fileIndex, rel, totalChunks, totalFiles, totalBytes, fileSize, bytes, final }) {
  let up = activeUploads.get(uploadId);
  if (!up) {
    up = { id: uploadId, startedAt: Date.now(), updatedAt: Date.now(), completedAt: 0, totalBytes: 0, receivedBytes: 0, totalFiles: 0, files: {} };
    activeUploads.set(uploadId, up);
  }
  up.updatedAt = Date.now();
  if (totalBytes > 0) up.totalBytes = totalBytes;
  if (totalFiles > 0) up.totalFiles = totalFiles;
  let f = up.files[fileIndex];
  if (!f) { f = { name: rel, size: fileSize || 0, received: 0, totalChunks: totalChunks || 1, done: false }; up.files[fileIndex] = f; }
  f.name = rel || f.name;
  if (fileSize > 0) f.size = fileSize;
  if (totalChunks > 0) f.totalChunks = totalChunks;
  f.received += bytes || 0;
  up.receivedBytes += bytes || 0;
  if (final) f.done = true;
  const filesDone = Object.values(up.files).filter((x) => x.done).length;
  if (up.totalFiles > 0 && filesDone >= up.totalFiles) up.completedAt = Date.now();
  pruneUploads();
}

function pruneUploads() {
  const now = Date.now();
  for (const [id, up] of activeUploads) {
    const stale = now - up.updatedAt > 5 * 60 * 1000; // 5min sem chunk
    const finishedAgo = up.completedAt && now - up.completedAt > 30 * 1000; // some 30s apos concluir
    if (stale || finishedAgo) activeUploads.delete(id);
  }
}

function activeUploadsList() {
  pruneUploads();
  return Array.from(activeUploads.values()).map((up) => {
    const filesDone = Object.values(up.files).filter((x) => x.done).length;
    let pct;
    if (up.completedAt) pct = 100;
    else if (up.totalBytes > 0) pct = Math.max(0, Math.min(99, Math.round((up.receivedBytes / up.totalBytes) * 100)));
    else pct = null;
    // Ficheiro "atual": o último não concluído com mais bytes recebidos.
    const pending = Object.values(up.files).filter((x) => !x.done).sort((a, b) => b.received - a.received);
    const current = (pending[0] && pending[0].name) || (Object.values(up.files).slice(-1)[0] || {}).name || '';
    return {
      id: up.id,
      percent: pct,
      receivedBytes: up.receivedBytes,
      totalBytes: up.totalBytes,
      totalFiles: up.totalFiles,
      filesDone,
      current: current ? String(current).split('/').pop() : '',
      completed: !!up.completedAt,
      startedAt: up.startedAt,
      updatedAt: up.updatedAt,
    };
  }).sort((a, b) => b.startedAt - a.startedAt);
}

const NEEDS_TRANSCODE = new Set(['.mkv', '.avi', '.flv', '.wmv', '.ts']);

// Spawn ffmpeg com prioridade BAIXA (nice +19 = ultima fila do scheduler)
// e I/O ocioso (ionice -c 3 = so usa disco quando ninguem mais precisa).
// Isso garante que transcode/streaming NUNCA travem outros apps no servidor.
function spawnLowPriority(cmd, args, opts) {
  try {
    return spawn('nice', ['-n', '19', 'ionice', '-c', '3', cmd, ...args], opts);
  } catch {
    return spawn(cmd, args, opts);
  }
}

function enqueueTranscode(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!NEEDS_TRANSCODE.has(ext)) return;
    if (!fs.existsSync(filePath)) return;
    if (transcodeQueue.includes(filePath) || transcodeStatus.get(filePath)?.state === 'running') return;
    transcodeQueue.push(filePath);
    transcodeStatus.set(filePath, { state: 'queued', progress: 0, queuedAt: Date.now() });
    processTranscodeQueue();
  } catch (e) { console.error('[transcode] enqueue err', e.message); }
}

async function processTranscodeQueue() {
  while (transcodeRunning < TRANSCODE_CONCURRENCY && transcodeQueue.length) {
    const next = transcodeQueue.shift();
    if (!next) break;
    transcodeRunning++;
    transcodeOne(next)
      .catch((e) => {
        transcodeStatus.set(next, { state: 'error', error: String(e.message || e), endedAt: Date.now() });
        console.error('[transcode]', next, 'ERROR:', e.message);
      })
      .finally(() => {
        transcodeRunning--;
        if (transcodeQueue.length) setImmediate(processTranscodeQueue);
      });
  }
}

function transcodeOne(srcPath) {
  return new Promise(async (resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return reject(new Error('ffmpeg-static não disponível'));
    if (!fs.existsSync(srcPath)) return reject(new Error('arquivo sumiu'));

    const dir = path.dirname(srcPath);
    const base = path.basename(srcPath, path.extname(srcPath));
    const finalDest = uniquePath(path.join(dir, base + '.mp4'));
    const tmpDest = finalDest + '.transcoding.mp4';

    const info = await probeFile(srcPath);
    const audioIdx = pickPreferredAudio(info.audio);
    const numAudios = (info.audio || []).length;
    const numSubs = (info.subs || []).length;

    // Detectar codecs/resolucao para decidir entre copy (remux) ou re-encode
    let videoCodec = '';
    let videoHeight = 0;
    const audioCodecs = (info.audio || []).map(() => '');
    try {
      const probeRaw = await new Promise((res) => {
        const fp = getFfprobePath();
        const pr = spawn(fp, ['-v', 'error', '-print_format', 'json', '-show_streams', srcPath], { stdio: ['ignore', 'pipe', 'ignore'] });
        let b = ''; pr.stdout.on('data', (d) => b += d); pr.on('exit', () => { try { res(JSON.parse(b)); } catch { res({ streams: [] }); } });
      });
      const v = (probeRaw.streams || []).find((s) => s.codec_type === 'video');
      videoCodec = v ? v.codec_name : '';
      videoHeight = v && v.height ? Number(v.height) : 0;
      const aStreams = (probeRaw.streams || []).filter((s) => s.codec_type === 'audio');
      aStreams.forEach((s, i) => { audioCodecs[i] = s.codec_name || ''; });
    } catch {}

    const canCopyVideo = /^(h264|avc)$/i.test(videoCodec);
    const allAudiosCanCopy = audioCodecs.length > 0 && audioCodecs.every((c) => /^(aac|mp3)$/i.test(c));
    // Pra encodes pesados (HEVC/AV1), baixa pra 720p pra ganhar 2-3x de velocidade.
    // Conteudo de celular nao precisa de 1080p e ainda fica nitido.
    const downscaleTo720 = !canCopyVideo && videoHeight > 1200;

    transcodeStatus.set(srcPath, { state: 'running', progress: 0, startedAt: Date.now(), mode: (canCopyVideo && allAudiosCanCopy) ? 'remux' : 'transcode' });
    console.log(`[transcode] ${path.basename(srcPath)} → MP4 (video:${canCopyVideo ? 'copy' : 'h264'}, audios=${numAudios} preferida=${audioIdx} ${allAudiosCanCopy ? 'copy' : 'aac'}, subs=${numSubs})`);

    // SNAPSHOT do probe do MKV original: salvamos no DB (probe-cache.json)
    // sob a chave do MP4 final tambem. Garante chapters/duration/audio mesmo
    // se o ffmpeg perder metadados no remux (raro, mas acontece com mov_text
    // e disposition mexendo na tabela).
    const snapshot = {
      duration: info.duration || 0,
      audio: info.audio || [],
      subs: info.subs || [],
      chapters: info.chapters || [],
      sourceFile: path.basename(srcPath),
      sourceCodec: { video: videoCodec, audios: audioCodecs },
      cachedAt: Date.now(),
    };
    probeCache[srcPath] = snapshot;
    probeCache[finalDest] = snapshot;
    saveProbeCache();

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-stats',
      '-threads', '0',
      '-i', srcPath,
      '-map', '0:v:0',
      '-map', '0:a?',         // TODAS as audios (PT-BR + EN + outras)
      '-map', '0:s?',         // TODAS as subs (serão convertidas pra mov_text que MP4 suporta)
      '-map_chapters', '0',
      '-map_metadata', '0',
      '-c:v', canCopyVideo ? 'copy' : 'libx264',
      ...(canCopyVideo ? [] : ['-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1']),
      ...(downscaleTo720 ? ['-vf', 'scale=-2:720'] : []),
    ];
    // Audio: copy se todas forem AAC/MP3, senão re-encode TODAS pra AAC stereo
    // Downmix 5.1→2.0 com loudnorm (EBU R128, padrão streaming) pra evitar clipping
    // no diálogo/LFE — antes saturava em -1dB com o downmix padrão do ffmpeg.
    if (allAudiosCanCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000');
    // Subs: pra MP4 precisa ser mov_text. Erros sao ignorados via -fix_sub_duration nao necessario aqui
    if (numSubs > 0) args.push('-c:s', 'mov_text');
    // Marca a faixa de audio preferida como default (player escolhe automaticamente)
    if (numAudios > 1 && audioIdx >= 0 && audioIdx < numAudios) {
      for (let i = 0; i < numAudios; i++) {
        args.push(`-disposition:a:${i}`, i === audioIdx ? 'default' : '0');
      }
    }
    // Marca a sub PT-BR como default se houver
    if (numSubs > 0) {
      const subIdx = (info.subs || []).findIndex((s) => trackMatchesLang(s, 'pt'));
      for (let i = 0; i < numSubs; i++) {
        args.push(`-disposition:s:${i}`, i === subIdx ? 'default' : '0');
      }
    }
    args.push('-movflags', '+faststart', '-f', 'mp4', tmpDest);

    const proc = spawnLowPriority(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const duration = info.duration || 0;
    proc.stderr.on('data', (d) => {
      const m = String(d).match(/time=(\d+):(\d+):([\d.]+)/);
      if (m && duration > 0) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        const pct = Math.min(100, Math.round((t / duration) * 100));
        const cur = transcodeStatus.get(srcPath) || {};
        transcodeStatus.set(srcPath, { ...cur, progress: pct });
      }
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmpDest); } catch {}
        transcodeStatus.set(srcPath, { state: 'error', error: 'ffmpeg exit ' + code, endedAt: Date.now() });
        return reject(new Error('ffmpeg exit ' + code));
      }
      try {
        fs.renameSync(tmpDest, finalDest);
        // BACKUP do original em /srv/mediaflix/originals/ antes de apagar.
        // Permite re-encodar depois em alta qualidade (preset slow + 1080p)
        // sem precisar re-upload. Se ja existir, sobrescreve.
        try {
          const origDir = path.join(path.dirname(path.dirname(path.dirname(srcPath))), 'originals');
          // fallback: usa /srv/mediaflix/originals se o calculo acima nao bater
          const altDir = '/srv/mediaflix/originals';
          const backupDir = fs.existsSync(altDir) ? altDir : origDir;
          fs.mkdirSync(backupDir, { recursive: true });
          const backupPath = path.join(backupDir, path.basename(srcPath));
          if (!fs.existsSync(backupPath)) {
            fs.renameSync(srcPath, backupPath);
          } else {
            // Ja temos backup — apaga o de media/
            fs.unlinkSync(srcPath);
          }
          probeCache[finalDest] = { ...(probeCache[finalDest] || {}), originalBackup: backupPath };
        } catch (e) {
          // Falha em backup — apaga mesmo assim pra liberar espaço
          try { fs.unlinkSync(srcPath); } catch {}
        }
        probeMemCache.delete(srcPath);
        probeMemCache.delete(finalDest);
        // Remove a entry persistida do MKV (arquivo nao existe mais), mas
        // mantem a do MP4 final como fallback.
        delete probeCache[srcPath];
        saveProbeCache();
        libraryCache = null;
        transcodeStatus.set(srcPath, { state: 'done', progress: 100, endedAt: Date.now(), output: finalDest });
        console.log(`[transcode] ✓ ${path.basename(finalDest)}`);
        resolve(finalDest);
      } catch (e) { reject(e); }
    });
    proc.on('error', reject);
  });
}

// Varre biblioteca e enfileira MKV/AVI/etc. existentes (uma vez no boot)
function scanAndEnqueueExisting() {
  for (const folder of config.folders || []) {
    try {
      const vids = listVideosRecursive(folder);
      for (const v of vids) {
        const ext = path.extname(v).toLowerCase();
        if (NEEDS_TRANSCODE.has(ext)) enqueueTranscode(v);
      }
    } catch {}
  }
}


async function handleChunkUpload(req, res, u) {
  if (!requireUploadToken(req, u)) return json(res, 401, { ok: false, error: 'Token de upload inválido.' });
  const targetRoot = normalize(config.folders[0] || path.join('/srv/mediaflix/media'));
  if (!config.folders.includes(targetRoot)) { config.folders.unshift(targetRoot); saveConfig(); }
  fs.mkdirSync(targetRoot, { recursive: true });

  const uploadId = String(u.searchParams.get('uploadId') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const fileIndex = String(u.searchParams.get('fileIndex') || '0').replace(/[^0-9]/g, '').slice(0, 8) || '0';
  const chunkIndex = Number(u.searchParams.get('chunkIndex') || 0);
  const totalChunks = Number(u.searchParams.get('totalChunks') || 1);
  const rel = safeRelativeUploadPath(u.searchParams.get('path') || 'arquivo');
  const uploadExt = path.extname(rel || '').toLowerCase();
  if (!ALLOWED_UPLOAD_EXT.has(uploadExt)) {
    return json(res, 400, { ok: false, error: `Extensão não permitida: ${uploadExt}` });
  }
  const totalFiles = Number(u.searchParams.get('totalFiles') || 0);
  const totalBytes = Number(u.searchParams.get('totalBytes') || 0);
  const fileSize = Number(u.searchParams.get('fileSize') || 0);
  if (!uploadId || !Number.isFinite(chunkIndex) || !Number.isFinite(totalChunks)) return json(res, 400, { ok: false, error: 'Chunk inválido.' });

  const tmpDir = path.join(dataDir, 'uploads', uploadId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `${fileIndex}.part`);
  const body = await readRaw(req);
  try {
    fs.appendFileSync(tmpFile, body);
  } catch (e) {
    // Disco cheio (ENOSPC) ou outro erro de escrita: limpa o parcial e devolve
    // erro limpo em vez de deixar a exceção derrubar o servidor inteiro.
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    activeUploads.delete(uploadId);
    const full = e && e.code === 'ENOSPC';
    return json(res, full ? 507 : 500, { ok: false, error: full ? 'Sem espaço em disco no servidor. Libere espaço antes de continuar o upload.' : ('Falha ao gravar: ' + (e && e.message || e)) });
  }

  const final = chunkIndex + 1 >= totalChunks;
  trackUploadChunk({ uploadId, fileIndex, rel, totalChunks, totalFiles, totalBytes, fileSize, bytes: body.length, final });
  if (!final) return json(res, 200, { ok: true, final: false, received: body.length });

  const dest = uniquePath(path.join(targetRoot, rel));
  if (!isInside(dest, targetRoot)) return json(res, 400, { ok: false, error: 'Destino inválido.' });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(tmpFile, dest);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  libraryCache = null;
  enqueueTranscode(dest);
  return json(res, 200, { ok: true, final: true, saved: path.relative(targetRoot, dest), library: scanLibrary() });
}

function handleUpload(req, res, u) {
  if (!requireUploadToken(req, u)) return json(res, 401, { ok: false, error: 'Token de upload inválido.' });
  const targetRoot = normalize(config.folders[0] || path.join('/srv/mediaflix/media'));
  if (!config.folders.includes(targetRoot)) { config.folders.unshift(targetRoot); saveConfig(); }
  fs.mkdirSync(targetRoot, { recursive: true });
  const bb = Busboy({ headers: req.headers, limits: { files: 500, fileSize: 1024 * 1024 * 1024 * 8 } });
  const saved = [];
  const pendingPaths = [];
  let failed = null;
  const writes = [];
  bb.on('field', (name, value) => {
    if (name === 'paths') pendingPaths.push(value);
  });
  bb.on('file', (_field, file, info) => {
    const rel = safeRelativeUploadPath(pendingPaths.shift() || info.filename);
    const uploadExt = path.extname(rel || '').toLowerCase();
    if (!ALLOWED_UPLOAD_EXT.has(uploadExt)) {
      file.resume();
      return;
    }
    const dest = uniquePath(path.join(targetRoot, rel));
    if (!isInside(dest, targetRoot)) { file.resume(); return; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    saved.push(path.relative(targetRoot, dest));
    file.pipe(out);
    writes.push(new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      file.on('error', reject);
    }));
  });
  bb.on('error', (e) => { failed = e; });
  bb.on('close', async () => {
    try {
      await Promise.all(writes);
      if (failed) throw failed;
      libraryCache = null;
      const targetRootForQueue = targetRoot;
      for (const rel of saved) enqueueTranscode(path.join(targetRootForQueue, rel));
      return json(res, 200, { ok: true, saved, count: saved.length, library: scanLibrary() });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message || e), saved });
    }
  });
  req.pipe(bb);
}

function thumbCachePath(filePath, atSec) {
  const h = require('crypto').createHash('sha1').update(filePath + '|' + atSec).digest('hex').slice(0, 16);
  return path.join(thumbsDir, h + '.jpg');
}
const _thumbInFlight = new Map();
function serveThumbnail(req, res, u) {
  const f = safeExistingFile(u.searchParams.get('path'));
  if (!f) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end(); }
  // Tempo (segundos) — default = 25% da duracao (passa fade in e abertura curta)
  let at = parseFloat(u.searchParams.get('t') || '');
  if (!isFinite(at) || at < 0) {
    const cached = probeCache[f];
    const dur = (cached && cached.duration) || 0;
    at = dur > 0 ? Math.max(60, dur * 0.25) : 60;
  }
  const out = thumbCachePath(f, Math.round(at));
  const send = () => {
    try {
      const stat = fs.statSync(out);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=2592000, immutable',
      });
      fs.createReadStream(out).pipe(res);
    } catch {
      // Sem cache em erro pra nao envenenar browser cache
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end();
    }
  };
  if (fs.existsSync(out)) return send();
  if (_thumbInFlight.has(out)) { _thumbInFlight.get(out).push(send); return; }
  _thumbInFlight.set(out, [send]);
  const ffmpeg = getFfmpegPath();
  if (!ffmpeg) {
    _thumbInFlight.delete(out);
    res.writeHead(500, { 'Cache-Control': 'no-store' });
    return res.end('no ffmpeg');
  }
  // Filter 'thumbnail' escolhe o frame mais representativo (evita black frames).
  // Limita a janela com -t 6 pra nao desperdicar CPU.
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', f, '-t', '6', '-vf', "thumbnail,scale=320:-2", '-frames:v', '1', '-q:v', '4', out];
  const proc = spawnLowPriority(ffmpeg, args, { stdio: 'ignore' });
  proc.on('exit', () => {
    const queue = _thumbInFlight.get(out) || [];
    _thumbInFlight.delete(out);
    queue.forEach((fn) => fn());
  });
  proc.on('error', () => {
    const queue = _thumbInFlight.get(out) || [];
    _thumbInFlight.delete(out);
    queue.forEach((fn) => fn());
  });
}

async function api(req, res, u) {
  if (u.pathname === '/api/thumbnail' || u.pathname === '/api/thumb') return serveThumbnail(req, res, u);
  if (u.pathname === '/api/upload-token' && req.method === 'GET') return json(res, 200, { ok: true, token: config.uploadToken });
  if (u.pathname === '/api/uploads/active' && req.method === 'GET') return json(res, 200, { ok: true, uploads: activeUploadsList() });
  if (u.pathname === '/api/upload-chunk' && req.method === 'POST') return handleChunkUpload(req, res, u);
  if (u.pathname === '/api/upload' && req.method === 'POST') return handleUpload(req, res, u);
  if (u.pathname === '/api/library') return json(res, 200, scanLibrary());
  if (u.pathname === '/api/config') { const safe = { ...config }; delete safe.uploadToken; return json(res, 200, { ...safe, vlcPath: '', web: true, uploads: true }); }
  if (u.pathname === '/api/folders' && req.method === 'POST') {
    const { folder } = await parseBody(req); const p = normalize(folder);
    try { if (!fs.statSync(p).isDirectory()) return json(res, 400, { ok: false, error: 'Pasta não existe no servidor.' }); } catch { return json(res, 400, { ok: false, error: 'Pasta não existe no servidor.' }); }
    if (!config.folders.includes(p)) config.folders.push(p); saveConfig(); return json(res, 200, { ok: true, folder: p, library: scanLibrary() });
  }
  if (u.pathname === '/api/folders' && req.method === 'DELETE') { config.folders = config.folders.filter((f) => f !== u.searchParams.get('folder')); saveConfig(); return json(res, 200, { ok: true, library: scanLibrary() }); }
  if (u.pathname === '/api/profiles' && req.method === 'GET') return json(res, 200, { ok: true, profiles: await listProfiles(), storage: (await getDb()) ? 'mongo' : 'json' });
  if (u.pathname === '/api/profiles' && req.method === 'POST') return json(res, 200, { ok: true, profile: await createProfile(await parseBody(req)) });
  if (u.pathname === '/api/profiles' && req.method === 'DELETE') { const r = await deleteProfile(u.searchParams.get('id')); return json(res, r.ok ? 200 : 400, r); }
  if (u.pathname === '/api/storage/status') return json(res, 200, await storageStatus());
  if (u.pathname === '/api/progress' && req.method === 'GET') return json(res, 200, await getProgressFor(profileIdFrom(u)));
  if (u.pathname === '/api/progress' && req.method === 'POST') { const b = await parseBody(req); let saved = false; if (safeExistingFile(b.path)) saved = await saveProgressFor(profileIdFrom(u, b), b.path, b.time, b.length, b.updatedAt); return json(res, 200, { ok: true, saved }); }
  if (u.pathname === '/api/progress' && req.method === 'DELETE') { await clearProgressFor(profileIdFrom(u), u.searchParams.get('path')); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/history' && req.method === 'GET') return json(res, 200, await getHistoryFor(profileIdFrom(u)));
  if (u.pathname === '/api/history' && req.method === 'DELETE') { await clearHistoryFor(profileIdFrom(u)); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/history/open') { const b = await parseBody(req); if (safeExistingFile(b.path)) await logOpenFor(profileIdFrom(u, b), b.path); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/history/close') { const b = await parseBody(req); await logCloseFor(profileIdFrom(u, b), b.path); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/play') { const b = await parseBody(req); const p = safeExistingFile(b.path); if (!p) return json(res, 404, { ok: false, error: 'Arquivo não encontrado/autorizado.' }); return json(res, 200, { ok: true, embedded: true, url: `/api/stream?f=${encodeURIComponent(p)}` }); }
  if (u.pathname === '/api/media-file' && req.method === 'DELETE') { const r = await deleteMediaFile(u.searchParams.get('path')); return json(res, r.ok ? 200 : 400, r); }
  if (u.pathname === '/api/auto-delete-check' && req.method === 'POST') { const b = await parseBody(req); const r = await autoDeleteWatchedFile(b.path, profileIdFrom(u, b)); return json(res, r.ok ? 200 : 400, r); }
  if (u.pathname === '/api/stream') return streamVideo(req, res, u.searchParams.get('f'), u);
  if (u.pathname === '/api/image') { const p = safeExistingFile(u.searchParams.get('path')); if (!p || !IMAGE_EXT.has(path.extname(p).toLowerCase())) return json(res, 404, { data: null }); const ext = path.extname(p).slice(1).replace('jpg', 'jpeg'); return json(res, 200, { data: `data:image/${ext};base64,${fs.readFileSync(p).toString('base64')}` }); }
  if (u.pathname === '/api/player/probe') {
    const info = await probeFile(u.searchParams.get('path'));
    return json(res, 200, {
      ...info,
      preferred: pickPreferredAudio(info.audio),
      preferredAudioLang: config.preferredAudioLang || 'pt',
      preferredSubLang: config.preferredSubLang || 'off',
      skipIntro: !!config.skipIntro,
      autoSkipIntro: !!config.autoSkipIntro,
      autoSkipIntroSeconds: Number.isFinite(config.autoSkipIntroSeconds) ? config.autoSkipIntroSeconds : 3,
    });
  }
  if (u.pathname === '/api/player/sidecars') { const p = safeExistingFile(u.searchParams.get('path')); if (!p) return json(res, 404, { ok: false, subs: [] }); const dir = path.dirname(p); const base = path.basename(p, path.extname(p)).toLowerCase(); const subs = fs.readdirSync(dir).filter((e) => SUBTITLE_EXT.has(path.extname(e).toLowerCase())).filter((e) => e.toLowerCase().startsWith(base) || fs.readdirSync(dir).length < 20).map((e) => { const lang = detectSubLang(e); return { path: path.join(dir, e), label: langLabel(lang), lang, ext: path.extname(e).toLowerCase() }; }); return json(res, 200, { ok: true, subs }); }
  if (u.pathname === '/api/player/extract-sub') return json(res, 200, { ok: false, error: 'Legenda embutida ainda não habilitada na versão web.' });
  if (u.pathname === '/api/config/toggle') { const b = await parseBody(req); if (['embeddedPlayer', 'autoNext', 'autoRescan', 'autoDeleteWatched', 'skipIntro', 'autoSkipIntro'].includes(b.key)) config[b.key] = !!b.value; saveConfig(); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/config/number') { const b = await parseBody(req); if (b.key === 'autoNextSeconds') config.autoNextSeconds = Math.max(3, Math.min(30, Number(b.value) || 8)); if (b.key === 'doubleTapSeconds') config.doubleTapSeconds = Math.max(3, Math.min(30, Number(b.value) || 5)); if (b.key === 'autoSkipIntroSeconds') config.autoSkipIntroSeconds = Math.max(2, Math.min(20, Number(b.value) || 3)); saveConfig(); return json(res, 200, { ok: true }); }
  if (u.pathname === '/api/config/string') {
    const b = await parseBody(req);
    const allowed = ['preferredAudioLang', 'preferredSubLang'];
    if (allowed.includes(b.key)) {
      const v = String(b.value || '').trim().toLowerCase().slice(0, 8) || (b.key === 'preferredSubLang' ? 'off' : 'pt');
      config[b.key] = v;
      saveConfig();
      return json(res, 200, { ok: true, value: v });
    }
    return json(res, 400, { ok: false, error: 'Chave não permitida' });
  }
  if (u.pathname === '/api/config/tmdb') { const b = await parseBody(req); config.tmdbKey = String(b.key || '').trim(); saveConfig(); return json(res, 200, { ok: true }); }

  // ----- TMDB metadata routes -----
  if (u.pathname === '/api/meta/fetch-all' && req.method === 'POST') {
    if (!config.tmdbKey) return json(res, 200, { ok: false, error: 'Configure a chave TMDB primeiro.' });
    const items = scanLibrary();
    let updated = 0, failed = 0;
    for (const it of items) {
      const key = groupKeyFromName(it.title) || it.id;
      const cached = metaCache[key];
      const onDiskSeasons = it.type === 'series' && Array.isArray(it.seasons) ? it.seasons.map((s) => s.number).filter((n) => n != null) : [];
      const missingSeasons = onDiskSeasons.filter((sn) => { if (!cached || !cached.episodes) return true; const m = cached.episodes[sn]; return !m || !Object.keys(m).length; });
      const hasBanner = cached && (cached.banner || cached.poster);
      if (hasBanner && missingSeasons.length === 0) continue;
      try {
        let result = null;
        if (cached && cached.tmdbId && missingSeasons.length && hasBanner) {
          const kindCached = cached.type || (it.type === 'series' ? 'tv' : 'movie');
          result = await buildMetaFromTmdbId(cached.tmdbId, kindCached, missingSeasons);
          if (result) result.episodes = { ...(cached.episodes || {}), ...(result.episodes || {}) };
        } else {
          result = await tmdbLookup(it.title, it.type === 'series' ? 'tv' : 'movie');
        }
        if (result) { metaCache[key] = result; updated++; }
        else failed++;
      } catch { failed++; }
      await new Promise((r) => setTimeout(r, 250));
    }
    saveMetaCache();
    libraryCache = null;
    return json(res, 200, { ok: true, updated, failed, library: scanLibrary() });
  }
  if (u.pathname === '/api/imdb/fetch-all' && req.method === 'POST') { try { return json(res, 200, await fetchAllImdbRatings()); } catch (e) { return json(res, 500, { ok: false, error: e.message }); } }
  if (u.pathname === '/api/meta/clear' && req.method === 'POST') {
    metaCache = {}; saveMetaCache(); libraryCache = null;
    return json(res, 200, { ok: true, library: scanLibrary() });
  }
  if (u.pathname === '/api/meta/search') {
    if (!config.tmdbKey) return json(res, 200, { ok: false, error: 'Sem chave TMDB.' });
    const lang = encodeURIComponent(config.tmdbLang || 'pt-BR');
    const q = encodeURIComponent(u.searchParams.get('query') || '');
    const t = u.searchParams.get('type');
    const kind = t === 'series' ? 'tv' : t === 'movie' ? 'movie' : 'multi';
    try {
      const j = await httpsGetJson(`https://api.themoviedb.org/3/search/${kind}?api_key=${config.tmdbKey}&language=${lang}&query=${q}&include_adult=false`);
      const results = (j.results || []).slice(0, 10).map((r) => ({
        id: r.id,
        mediaType: r.media_type || (kind === 'multi' ? null : kind),
        title: r.name || r.title || 'Sem título',
        year: (r.first_air_date || r.release_date || '').slice(0, 4),
        overview: r.overview || '',
        posterUrl: r.poster_path ? `https://image.tmdb.org/t/p/w200${r.poster_path}` : null,
      }));
      return json(res, 200, { ok: true, results });
    } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
  }
  if (u.pathname === '/api/meta/apply' && req.method === 'POST') {
    if (!config.tmdbKey) return json(res, 200, { ok: false, error: 'Sem chave TMDB.' });
    const b = await parseBody(req);
    const kind = b.mediaType === 'tv' || b.itemType === 'series' ? 'tv' : 'movie';
    try {
      const result = await buildMetaFromTmdbId(b.tmdbId, kind);
      const candidateTitles = [b.itemTitle, b.rawTitle, result && result.title].filter(Boolean);
      const keysToReplace = new Set();
      for (const t of candidateTitles) { const k = groupKeyFromName(t); if (k) keysToReplace.add(k); }
      for (const k of Array.from(keysToReplace)) delete metaCache[k];
      for (const k of Object.keys(metaCache)) {
        const e = metaCache[k]; if (!e) continue;
        if (e.tmdbId && e.tmdbId !== b.tmdbId) {
          for (const t of candidateTitles) { if (groupKeyFromName(e.title || '') === groupKeyFromName(t)) { delete metaCache[k]; break; } }
        }
      }
      for (const k of keysToReplace) metaCache[k] = result;
      saveMetaCache(); libraryCache = null;
      return json(res, 200, { ok: true, library: scanLibrary() });
    } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
  }
  if (u.pathname === '/api/library/reset' && req.method === 'POST') {
    metaCache = {}; saveMetaCache(); libraryCache = null;
    return json(res, 200, { ok: true, library: scanLibrary() });
  }

  if (u.pathname === '/api/transcode/status') {
    const list = [];
    for (const [p, s] of transcodeStatus.entries()) list.push({ path: p, file: path.basename(p), ...s });
    return json(res, 200, { ok: true, queued: transcodeQueue.length, running: transcodeRunning, concurrency: TRANSCODE_CONCURRENCY, items: list.slice(-50) });
  }
  if (u.pathname === '/api/transcode/rescan' && req.method === 'POST') {
    scanAndEnqueueExisting();
    return json(res, 200, { ok: true, queued: transcodeQueue.length });
  }

  if (u.pathname === '/api/version') return json(res, 200, { version: require('./package.json').version, web: true });
  if (u.pathname === '/api/update') return json(res, 200, { ok: true, updateAvailable: false });
  if (u.pathname.startsWith('/api/')) return json(res, 200, { ok: false, items: [], error: 'Endpoint ainda não implementado na versão web.' });
}
function serveStatic(req, res, u) {
  let pathname = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
  const file = normalize(path.join(__dirname, pathname));
  if (!isInside(file, __dirname)) return text(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return text(res, 404, 'not found');
    const ext = path.extname(file).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate' }); res.end(buf);
  });
}

const mediaflixServer = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return await serveStatic(req, res, u);
  } catch (e) {
    try { return text(res, 500, String(e && e.stack || e)); } catch { /* resposta já enviada */ }
  }
});
// Rede de segurança: um erro inesperado num handler (ex.: disco cheio) não pode
// derrubar o MediaFlix inteiro para todos os utilizadores.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack || e));
if (require.main === module) {
  mediaflixServer.listen(PORT, HOST, () => {
    console.log(`Mediaflix web rodando em http://${HOST}:${PORT}`);
    console.log(`Pastas configuradas: ${config.folders.length ? config.folders.join(', ') : '(nenhuma)'}`);
  });
}
module.exports = { shouldAutoDelete };

// Limpeza periodica de uploads orfaos (> 24h) — evita encher o disco quando
// um upload chunked eh abandonado no meio (ex.: usuario fecha a aba).
function cleanupStaleUploads() {
  try {
    const uploadsDir = path.join(dataDir, 'uploads');
    if (!fs.existsSync(uploadsDir)) return;
    const now = Date.now();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
    let cleaned = 0;
    let freedBytes = 0;
    for (const entry of fs.readdirSync(uploadsDir)) {
      const full = path.join(uploadsDir, entry);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > MAX_AGE_MS) {
          const dirSize = fs.readdirSync(full).reduce((acc, f) => {
            try { return acc + fs.statSync(path.join(full, f)).size; } catch { return acc; }
          }, 0);
          fs.rmSync(full, { recursive: true, force: true });
          cleaned += 1;
          freedBytes += dirSize;
        }
      } catch {}
    }
    if (cleaned) console.log(`[uploads] limpos ${cleaned} upload(s) orfao(s), ${(freedBytes / 1024 / 1024).toFixed(1)} MB liberados`);
  } catch (e) {
    console.warn('[uploads] cleanup falhou:', e.message);
  }
}
if (require.main === module) {
  setInterval(cleanupStaleUploads, 60 * 60 * 1000); // hora em hora
  setTimeout(cleanupStaleUploads, 10 * 1000); // tambem 10s apos boot
  // Boot: enfileira MKV/AVI/etc. existentes para conversão automática
  setTimeout(() => { try { scanAndEnqueueExisting(); } catch (e) { console.error('[transcode boot]', e.message); } }, 15 * 1000);
}
