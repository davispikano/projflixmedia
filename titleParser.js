// Title cleaning + season grouping for Mediaflix
// No external deps. Heuristics tuned for typical scene/release names.

const path = require('path');

const RELEASE_TAGS = [
  '2160p', '1080p', '720p', '480p', '4k', 'uhd',
  'bluray', 'blu-ray', 'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'dvdrip', 'brrip', 'bdrip',
  'x264', 'x265', 'h264', 'h265', 'h\\.264', 'h\\.265', 'hevc', 'avc', 'xvid', 'divx',
  'aac', 'aac2\\.0', 'ac3', 'dts', 'dts-hd', 'dd5\\.1', 'ddp5\\.1', 'ddp7\\.1', 'atmos', 'truehd',
  'hdr', 'hdr10', 'hdr10\\+', 'dv', 'dolby', 'vision',
  'dual', 'dublado', 'legendado', 'multi', 'nacional',
  '10bit', '8bit', 'remux', 'extended', 'unrated', 'directors\\.cut', 'imax',
  'amzn', 'nf', 'netflix', 'dsnp', 'hmax', 'hulu', 'atvp', 'mubi', 'crav', 'pcok',
  'repack', 'proper', 'internal', 'limited',
];

const RELEASE_TAG_RE = new RegExp(`\\b(${RELEASE_TAGS.join('|')})\\b`, 'gi');
const TRAILING_GROUP_RE = /[-_.][a-z0-9]+$/i; // dangling -GroupName
const YEAR_RE = /\b(19|20)\d{2}\b/;

// Recognize season indicators inside a folder name
// Captures explicit season number where possible
const SEASON_PATTERNS = [
  /\bs(?:eason)?[.\s_-]*?(\d{1,2})\b/i, // Season 4, S04
  /\btemporada[.\s_-]*?(\d{1,2})\b/i,    // Temporada 4
  /\bs(\d{1,2})\b/i,                     // S04 standalone
];

function detectSeasonNumber(name) {
  for (const re of SEASON_PATTERNS) {
    const m = name.match(re);
    if (m && m[1]) return parseInt(m[1], 10);
  }
  return null;
}

function detectEpisodeNumber(name) {
  // SxxExx, 1x05, EP05, E05
  let m = name.match(/s\d{1,2}[\s._-]*e(\d{1,3})/i);
  if (m) return parseInt(m[1], 10);
  m = name.match(/\b\d{1,2}x(\d{1,3})\b/i);
  if (m) return parseInt(m[1], 10);
  m = name.match(/\bep?[.\s_-]*?(\d{1,3})\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function detectSeasonAndEpisode(name) {
  let m = name.match(/s(\d{1,2})[\s._-]*e(\d{1,3})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = name.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  return { season: null, episode: detectEpisodeNumber(name) };
}

// Strip a season indicator from a name to get the parent series base name
function stripSeasonFromName(name) {
  let out = name;
  out = out.replace(/\bseason[.\s_-]*?\d{1,2}\b/gi, '');
  out = out.replace(/\btemporada[.\s_-]*?\d{1,2}\b/gi, '');
  out = out.replace(/\bs\d{1,2}(?![\dxe])/gi, '');
  return out;
}

function titleCase(str) {
  // Lowercase small words but capitalize at word boundaries
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'da', 'de', 'do', 'das', 'dos', 'e', 'o', 'a', 'um', 'uma']);
  return str.split(/\s+/).map((w, i) => {
    if (!w) return w;
    const lower = w.toLowerCase();
    if (i > 0 && small.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join(' ');
}

// Clean a raw folder/file name into a presentable title.
// Strips release tags, year, group suffix, normalizes separators.
function cleanTitle(raw) {
  if (!raw) return '';
  let s = raw;

  // Remove extension if present
  s = s.replace(/\.(mp4|mkv|avi|mov|wmv|m4v|webm|flv|ts)$/i, '');

  // Replace separators with spaces
  s = s.replace(/[._]+/g, ' ');

  // Strip bracketed segments [...] (...) - usually metadata
  s = s.replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');

  // Remove release tags
  s = s.replace(RELEASE_TAG_RE, ' ');

  // Strip episode markers SxxExx etc.
  s = s.replace(/\bs\d{1,2}[\s_-]*e\d{1,3}\b/gi, ' ');
  s = s.replace(/\b\d{1,2}x\d{1,3}\b/g, ' ');

  // Strip season-only markers
  s = s.replace(/\bseason[\s_-]*\d{1,2}\b/gi, ' ');
  s = s.replace(/\btemporada[\s_-]*\d{1,2}\b/gi, ' ');
  s = s.replace(/\bs\d{1,2}\b/gi, ' ');

  // Strip year
  s = s.replace(YEAR_RE, ' ');

  // Strip trailing group name like " Hector" or "-RARBG"
  s = s.replace(/[-]\s*[a-z0-9]+\s*$/i, ' ');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();

  // Remove dangling separators
  s = s.replace(/^[-:\s]+|[-:\s]+$/g, '').trim();

  if (!s) return raw;
  return titleCase(s);
}

// Compute a stable grouping key from a folder name to merge season folders
// e.g. "Dexter_Season.4" → "dexter"
//      "Dexter Season 5" → "dexter"
//      "How.I.Met.Your.Mother.S05.1080p..." → "how i met your mother"
function groupKeyFromName(name) {
  let s = stripSeasonFromName(name);
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/\bs\d{1,2}\b/gi, ' ');
  s = s.replace(RELEASE_TAG_RE, ' ');
  s = s.replace(YEAR_RE, ' ');
  s = s.replace(/[-]\s*[a-z0-9]+\s*$/i, ' ');
  s = s.replace(/[^a-z0-9\s]/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim().toLowerCase();
  return s || name.toLowerCase();
}

function cleanEpisodeTitle(rawFile) {
  // Try to extract a per-episode title after SxxExx; fallback to cleanTitle
  const base = path.basename(rawFile).replace(/\.[^.]+$/, '');
  const m = base.match(/s\d{1,2}[\s._-]*e\d{1,3}[\s._-]*(.*)/i);
  if (m && m[1]) {
    const cleaned = cleanTitle(m[1]);
    if (cleaned && cleaned.length > 1) return cleaned;
  }
  return cleanTitle(base);
}

module.exports = {
  cleanTitle,
  cleanEpisodeTitle,
  detectSeasonNumber,
  detectEpisodeNumber,
  detectSeasonAndEpisode,
  groupKeyFromName,
};
