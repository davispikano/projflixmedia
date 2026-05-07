// Title cleaning + season grouping for Mediaflix
// Powered by parse-torrent-title (used by many Stremio-ecosystem projects).
// This is essentially the same approach Jellyfin/Sonarr use: a robust regex
// engine that recognizes scene/release tags and extracts {title, season,
// episode, year, resolution, codec, group, ...}.

const path = require('path');
const ptt = require('parse-torrent-title');

function titleCase(str) {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'da', 'de', 'do', 'das', 'dos', 'e', 'um', 'uma']);
  return String(str || '').split(/\s+/).map((w, i) => {
    if (!w) return w;
    const lower = w.toLowerCase();
    if (i > 0 && small.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

function normalizeName(raw) {
  let s = String(raw || '').replace(/\.(mp4|mkv|avi|mov|wmv|m4v|webm|flv|ts)$/i, '');
  s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

function parseFolder(name) {
  return ptt.parse(normalizeName(name)) || {};
}

function parseFile(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return ptt.parse(base) || {};
}

function cleanTitle(raw) {
  if (!raw) return '';
  const info = ptt.parse(normalizeName(raw));
  let title = info && info.title ? info.title : normalizeName(raw);
  return titleCase(title);
}

function cleanEpisodeTitle(rawFile) {
  const base = path.basename(rawFile).replace(/\.[^.]+$/, '');
  const info = ptt.parse(base) || {};
  // ptt.title returns the SHOW name. For per-episode title, look at what comes
  // after SxxExx in the filename and parse it again.
  const after = base.match(/s\d{1,2}[\s._-]*e\d{1,3}[\s._-]+(.+)$/i);
  if (after && after[1]) {
    const inner = ptt.parse(normalizeName(after[1]));
    const candidate = inner && inner.title ? inner.title : normalizeName(after[1]);
    if (candidate && candidate.length > 1 && !/^\d+$/.test(candidate)) {
      return titleCase(candidate);
    }
  }
  if (info.episode != null) return `Episódio ${info.episode}`;
  return titleCase(normalizeName(base));
}

function detectSeasonNumber(name) {
  const info = ptt.parse(normalizeName(name));
  return info && info.season != null ? info.season : null;
}

function detectSeasonAndEpisode(name) {
  const info = ptt.parse(normalizeName(name));
  return {
    season: info && info.season != null ? info.season : null,
    episode: info && info.episode != null ? info.episode : null,
  };
}

// Stable key used to merge "Dexter Season 4", "Dexter Season 5", etc.
function groupKeyFromName(name) {
  const info = ptt.parse(normalizeName(name));
  const title = info && info.title ? info.title : normalizeName(name);
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  cleanTitle,
  cleanEpisodeTitle,
  detectSeasonNumber,
  detectSeasonAndEpisode,
  groupKeyFromName,
  parseFolder,
  parseFile,
};
