/* Mediaflix renderer */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  library: [],
  progress: {},
  history: {},
  currentDetail: null,
  imageCache: new Map(),
};

// ---------- Helpers ----------
function fmtTime(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function progressOf(filePath) {
  const p = state.progress[filePath];
  if (!p || !p.length) return null;
  const ratio = Math.min(1, Math.max(0, p.time / p.length));
  return { ratio, ...p };
}

function lastActivityForPath(filePath) {
  const p = state.progress[filePath];
  const h = state.history[filePath];
  const candidates = [];
  if (p && p.updatedAt) candidates.push(p.updatedAt);
  if (h && h.openedAt) candidates.push(h.openedAt);
  if (h && h.closedAt) candidates.push(h.closedAt);
  return candidates.length ? Math.max(...candidates) : 0;
}

function itemProgress(item) {
  if (item.type === 'movie') {
    const p = progressOf(item.path);
    const last = lastActivityForPath(item.path);
    if (p) return { ...p, lastActivity: last };
    if (last > 0) return { ratio: 0, time: 0, length: 0, updatedAt: last, lastActivity: last };
    return null;
  }
  // For series, find the episode with the most recent activity (history OR progress)
  let latest = null;
  for (const ep of item.episodes) {
    const last = lastActivityForPath(ep.path);
    if (!last) continue;
    if (!latest || last > latest.lastActivity) {
      const p = state.progress[ep.path];
      latest = {
        episode: ep,
        time: p ? p.time : 0,
        length: p ? p.length : 0,
        updatedAt: p ? p.updatedAt : last,
        ratio: p && p.length ? Math.min(1, p.time / p.length) : 0,
        lastActivity: last,
      };
    }
  }
  return latest;
}

function nextEpisode(item) {
  const last = itemProgress(item);
  if (!last || !last.episode) return item.episodes[0];
  if (last.ratio < 0.95) return last.episode;
  // pick next index in flat episode list
  const idx = item.episodes.findIndex((e) => e.path === last.episode.path);
  return item.episodes[Math.min(idx + 1, item.episodes.length - 1)];
}

async function loadImage(filePath) {
  if (!filePath) return null;
  if (state.imageCache.has(filePath)) return state.imageCache.get(filePath);
  const data = await window.api.readImage(filePath);
  state.imageCache.set(filePath, data);
  return data;
}

function showToast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- Hero ----------
async function renderHero() {
  const hero = $('#hero');
  if (!state.library.length) { hero.classList.add('hidden'); return; }
  hero.classList.remove('hidden');

  // Prefer item with banner and (if any) most recent progress
  const withBanner = state.library.filter((i) => i.banner);
  const recent = state.library
    .map((i) => ({ i, p: itemProgress(i) }))
    .filter((x) => x.p && x.p.lastActivity)
    .sort((a, b) => b.p.lastActivity - a.p.lastActivity);

  let featured = recent.length && recent[0].i.banner ? recent[0].i : (withBanner[0] || state.library[0]);

  const bg = featured.banner ? await loadImage(featured.banner) : null;
  const meta = [];
  meta.push(featured.type === 'series' ? 'Série' : 'Filme');
  if (featured.type === 'series') meta.push(`${featured.episodes.length} episódios`);
  const prog = itemProgress(featured);

  hero.classList.remove('hero-skeleton');
  hero.innerHTML = `
    <div class="hero-bg" style="${bg ? `background-image:url('${bg}')` : 'background:linear-gradient(135deg,#1a1a1f,#0a0a0b)'}"></div>
    <div class="hero-fade"></div>
    <div class="hero-content">
      <span class="kicker">${prog ? 'Continuar' : 'Em destaque'}</span>
      <h1 class="hero-title">${escapeHtml(featured.title)}</h1>
      <div class="hero-meta">
        ${meta.map((m, i) => `${i ? '<span class="dot"></span>' : ''}<span>${m}</span>`).join('')}
        ${prog ? `<span class="dot"></span><span>${Math.round(prog.ratio * 100)}% assistido</span>` : ''}
      </div>
      <div class="hero-actions">
        <button class="btn-primary" id="heroPlay">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>
          <span>${prog ? 'Continuar' : 'Reproduzir'}</span>
        </button>
        <button class="btn-ghost" id="heroInfo">Mais detalhes</button>
      </div>
    </div>
  `;

  $('#heroPlay').addEventListener('click', () => playItem(featured));
  $('#heroInfo').addEventListener('click', () => openDetail(featured));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Cards / Rows ----------
async function buildCard(item, opts = {}) {
  const { resumeMode = false } = opts;
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.search = (item.title + ' ' + (item.rawTitle || '')).toLowerCase();
  const prog = itemProgress(item);
  const bg = item.banner ? await loadImage(item.banner) : null;
  const sub = item.type === 'series'
    ? `${item.seasons && item.seasons.length > 1 ? item.seasons.length + ' TEMPORADAS' : item.episodes.length + ' EP' + (item.episodes.length > 1 ? 'S' : '')}`
    : 'FILME';

  card.innerHTML = `
    <div class="card-img ${bg ? '' : 'fallback'}" ${bg ? `style="background-image:url('${bg}')"` : ''}></div>
    <div class="card-fade"></div>
    <span class="card-badge">${sub}</span>
    ${item.imdbRating ? `<span class="card-rating">${item.imdbRating.toFixed(1)}</span>` : ''}
    ${resumeMode ? '<span class="card-resume" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg></span>' : ''}
    <div class="card-meta">
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      <span class="card-sub">${item.type === 'series' && prog && prog.episode
        ? `EP ${prog.episode.index}${prog.ratio ? ' · ' + Math.round(prog.ratio * 100) + '%' : ''}`
        : (prog && prog.ratio ? `${Math.round(prog.ratio * 100)}% assistido` : '')}</span>
    </div>
    ${prog && prog.ratio ? `<div class="card-progress"><span style="width:${(prog.ratio * 100).toFixed(1)}%"></span></div>` : ''}
  `;
  card.addEventListener('click', () => {
    if (resumeMode) {
      // Resume: play the exact last-opened episode (or movie itself)
      if (item.type === 'series' && prog && prog.episode) return playFile(prog.episode.path, item, prog.episode);
      return playItem(item);
    }
    // Always open detail (for both series and movies) so user can identify, see
    // overview, and choose to play. Detail screen has a Reproduzir button on top.
    openDetail(item);
  });
  return card;
}

async function renderRows() {
  const series = state.library.filter((i) => i.type === 'series');
  const movies = state.library.filter((i) => i.type === 'movie');

  const continueItems = state.library
    .map((i) => ({ i, p: itemProgress(i) }))
    .filter((x) => x.p && x.p.lastActivity)
    .filter((x) => !(x.p.ratio >= 0.95))
    .sort((a, b) => b.p.lastActivity - a.p.lastActivity)
    .map((x) => x.i)
    .slice(0, 12);

  await fillRow('#continueRow', '#continueTrack', '#continueCount', continueItems, { resumeMode: true });
  await fillRow('#seriesRow', '#seriesTrack', '#seriesCount', series);
  await fillRow('#moviesRow', '#moviesTrack', '#moviesCount', movies);
  if (typeof window.__applySearchFilter === 'function') window.__applySearchFilter();
}

async function buildDiscoverCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.search = (item.title || '').toLowerCase();
  const bg = item.banner ? await loadImage(item.banner) : null;
  const sub = item.kind === 'tv' ? 'SÉRIE' : 'FILME';
  const rating = item.imdbRating || item.tmdbRating;
  const ratingSrc = item.imdbRating ? 'IMDb' : 'TMDB';
  card.innerHTML = `
    <div class="card-img ${bg ? '' : 'fallback'}" ${bg ? `style="background-image:url('${bg}')"` : ''}></div>
    <div class="card-fade"></div>
    <span class="card-badge">${sub}${item.year ? ' · ' + item.year : ''}</span>
    ${rating ? `<span class="card-rating" title="${ratingSrc}">${rating.toFixed(1)}</span>` : ''}
    <div class="card-meta">
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      <span class="card-sub">${item.imdbId ? 'Abrir no IMDb' : 'Abrir no TMDB'}</span>
    </div>
  `;
  card.addEventListener('click', () => {
    openDiscoverDetail(item);
  });
  return card;
}

async function renderTrending() {
  const row = document.getElementById('trendingRow');
  const track = document.getElementById('trendingTrack');
  const count = document.getElementById('trendingCount');
  if (!row || !track) return;
  try {
    const cfg = await window.api.getConfig();
    if (!cfg || !cfg.tmdbKey) { row.classList.add('hidden'); return; }
    const res = await window.api.getTrending();
    if (!res || !res.ok || !res.items || !res.items.length) {
      row.classList.add('hidden');
      return;
    }
    row.classList.remove('hidden');
    count.textContent = String(res.items.length).padStart(2, '0');
    track.innerHTML = '';
    for (const it of res.items) track.appendChild(await buildDiscoverCard(it));
    if (typeof window.__applySearchFilter === 'function') window.__applySearchFilter();
  } catch (e) {
    console.warn('trending failed', e);
    row.classList.add('hidden');
  }
}

async function fillRow(rowSel, trackSel, countSel, items, opts = {}) {
  const row = $(rowSel), track = $(trackSel), count = $(countSel);
  if (!items.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  count.textContent = String(items.length).padStart(2, '0');
  track.innerHTML = '';
  for (const item of items) {
    track.appendChild(await buildCard(item, opts));
  }
}

// ---------- Detail overlay ----------
async function openDetail(item) {
  state.currentDetail = item;
  const d = $('#detail');
  d.classList.remove('hidden');

  const bg = item.banner ? await loadImage(item.banner) : null;
  $('#detailBg').style.backgroundImage = bg ? `url('${bg}')` : 'linear-gradient(135deg,#1a1a1f,#0a0a0b)';
  $('#detailKicker').textContent = item.type === 'series' ? 'Série' : 'Filme';
  $('#detailTitle').textContent = item.title;
  $('#detailOverview').textContent = item.overview || '';

  // Big rating block (IMDb preferred). Computes best episode if we have
  // per-episode ratings, so the user sees the show's quality at a glance.
  const ratingEl = $('#detailRating');
  const r = item.imdbRating;
  if (r) {
    ratingEl.hidden = false;
    $('#detailRatingValue').textContent = r.toFixed(1);
    $('#detailRatingSource').textContent = item.imdbId ? 'IMDb' : 'TMDB';
    let bestStr = '';
    if (item.type === 'series' && Array.isArray(item.episodes)) {
      let best = null;
      for (const ep of item.episodes) {
        if (typeof ep.imdbRating === 'number' && (!best || ep.imdbRating > best.imdbRating)) best = ep;
      }
      if (best) {
        bestStr = `Melhor episódio<br><b>T${best.season} EP ${best.index}</b> · ★ ${best.imdbRating.toFixed(1)}`;
      }
    }
    $('#detailRatingBest').innerHTML = bestStr;
    $('#detailRatingBest').style.display = bestStr ? '' : 'none';
  } else {
    ratingEl.hidden = true;
  }

  // Reset discover-only buttons (this is the local-detail flow)
  $('#detailAddFolderBtn').classList.add('hidden');
  $('#detailImdbBtn').classList.add('hidden');
  $('#detailPlayBtn').classList.remove('hidden');
  $('#detailOpenFolderBtn').classList.remove('hidden');
  $('#detailIdentifyBtn').classList.remove('hidden');

  if (item.type === 'series') {
    const seasonCount = item.seasons ? item.seasons.length : 1;
    const epCount = item.episodes.length;
    const metaParts = [`${epCount} episódios`];
    if (seasonCount > 1) metaParts.unshift(`${seasonCount} temporadas`);
    if (item.year) metaParts.push(item.year);
    $('#detailMeta').textContent = metaParts.join(' · ');

    const next = nextEpisode(item);
    const prog = state.progress[next.path];
    const epLabel = next.season != null
      ? `T${next.season} EP ${next.index}`
      : `EP ${next.index}`;
    $('#detailPlayLabel').textContent = prog && prog.time > 30 ? `Continuar ${epLabel}` : `Reproduzir ${epLabel}`;
    $('#detailPlayBtn').onclick = () => playFile(next.path, item, next);

    renderSeasonTabs(item, next.season != null ? next.season : (item.seasons[0] && item.seasons[0].number));
  } else {
    $('#detailMeta').textContent = item.year ? `Filme · ${item.year}` : 'Filme';
    const prog = state.progress[item.path];
    $('#detailPlayLabel').textContent = prog && prog.time > 30 ? 'Continuar' : 'Reproduzir';
    $('#detailPlayBtn').onclick = () => playFile(item.path, item, null);
    $('#episodeList').innerHTML = '';
    $('#seasonTabs').innerHTML = '';
  }

  $('#detailOpenFolderBtn').onclick = () => window.api.openFolder(item.folder || item.path);
  $('#detailIdentifyBtn').onclick = () => openSearchModal(item);
}

function renderSeasonTabs(item, activeSeasonNum) {
  const tabs = $('#seasonTabs');
  tabs.innerHTML = '';
  if (!item.seasons || item.seasons.length === 0) return;

  if (item.seasons.length > 1) {
    for (const season of item.seasons) {
      const btn = document.createElement('button');
      btn.className = 'season-tab' + (season.number === activeSeasonNum ? ' active' : '');
      btn.textContent = `Temporada ${season.number}`;
      btn.addEventListener('click', () => renderSeasonTabs(item, season.number));
      tabs.appendChild(btn);
    }
  }

  const active = item.seasons.find((s) => s.number === activeSeasonNum) || item.seasons[0];
  renderEpisodeList(active);
}

function renderEpisodeList(season) {
  const list = $('#episodeList');
  list.innerHTML = '';
  for (const ep of season.episodes) {
    const p = state.progress[ep.path];
    const ratio = p && p.length ? Math.min(1, p.time / p.length) : 0;
    const li = document.createElement('li');
    li.className = 'episode';
    li.innerHTML = `
      <div class="episode-num">${String(ep.index).padStart(2, '0')}</div>
      <div>
        <p class="episode-title">${escapeHtml(ep.title)}</p>
        ${ep.overview ? `<p class="episode-overview">${escapeHtml(ep.overview)}</p>` : ''}
        ${ratio > 0 ? `<div class="episode-progress"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>` : ''}
      </div>
      <div class="episode-meta">
        ${typeof ep.imdbRating === 'number' ? `<span class="episode-rating-big">★ ${ep.imdbRating.toFixed(1)}</span>` : ''}
        <span class="episode-time">${p ? `${fmtTime(p.time)} / ${fmtTime(p.length)}` : ''}</span>
      </div>
    `;
    li.addEventListener('click', () => playFile(ep.path, state.currentDetail, ep));
    list.appendChild(li);
  }
}

function closeDetail() {
  $('#detail').classList.add('hidden');
  state.currentDetail = null;
}

// Find a local library item that matches the given title (case + accent
// insensitive). Used to deep-link discover cards into the local detail view
// when the user already has the show/movie on disk.
function findLocalMatch(title) {
  if (!title) return null;
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  const target = norm(title);
  if (!target) return null;
  return state.library.find((it) => norm(it.title) === target || norm(it.rawTitle) === target) || null;
}

async function openDiscoverDetail(item) {
  // If already in the user's library, open the normal local detail.
  const local = findLocalMatch(item.title);
  if (local) return openDetail(local);

  state.currentDetail = item;
  const d = $('#detail');
  d.classList.remove('hidden');

  const bg = item.banner ? await loadImage(item.banner) : null;
  $('#detailBg').style.backgroundImage = bg ? `url('${bg}')` : 'linear-gradient(135deg,#1a1a1f,#0a0a0b)';
  $('#detailKicker').textContent = item.kind === 'tv' ? 'Série · Em alta' : 'Filme · Em alta';
  $('#detailTitle').textContent = item.title;
  const metaParts = [];
  if (item.year) metaParts.push(item.year);
  const r = item.imdbRating || item.tmdbRating;
  if (r) metaParts.push(`${item.imdbRating ? 'IMDb' : 'TMDB'} ${r.toFixed(1)}`);
  metaParts.push('Não está na sua biblioteca');
  $('#detailMeta').textContent = metaParts.join(' · ');
  $('#detailOverview').textContent = item.overview || '';

  // Show the big rating block on discover too if we have a number
  const ratingEl2 = $('#detailRating');
  const r2 = item.imdbRating || item.tmdbRating;
  if (r2) {
    ratingEl2.hidden = false;
    $('#detailRatingValue').textContent = r2.toFixed(1);
    $('#detailRatingSource').textContent = item.imdbRating ? 'IMDb' : 'TMDB';
    $('#detailRatingBest').innerHTML = '';
    $('#detailRatingBest').style.display = 'none';
  } else {
    ratingEl2.hidden = true;
  }

  // Empty episode list (we don't have local files yet)
  $('#episodeList').innerHTML = '';
  $('#seasonTabs').innerHTML = '';

  // Discover-only buttons
  $('#detailPlayBtn').classList.add('hidden');
  $('#detailOpenFolderBtn').classList.add('hidden');
  $('#detailIdentifyBtn').classList.add('hidden');
  const addBtn = $('#detailAddFolderBtn');
  addBtn.classList.remove('hidden');
  addBtn.onclick = async () => {
    const res = await window.api.addFolder();
    if (!res || !res.ok) return;
    state.library = res.library;
    await renderAll();
    showToast('Pasta adicionada');
    // Auto-fetch metadata so the new title gets banner + episode names
    const cfg = await window.api.getConfig();
    if (cfg && cfg.tmdbKey) {
      const meta = await window.api.fetchAllMeta();
      if (meta && meta.ok) {
        state.library = meta.library;
        state.imageCache.clear();
        await renderAll();
      }
    }
    // After adding, try to deep-link the user to the freshly added local item.
    const newLocal = findLocalMatch(item.title);
    if (newLocal) openDetail(newLocal);
    else closeDetail();
  };
  const imdbBtn = $('#detailImdbBtn');
  if (item.imdbUrl) {
    imdbBtn.classList.remove('hidden');
    imdbBtn.onclick = () => window.api.openExternal(item.imdbUrl);
  } else {
    imdbBtn.classList.add('hidden');
  }
}

// ---------- Manual TMDB search ----------
function openSearchModal(item) {
  state.searchingFor = item;
  $('#searchInput').value = item.title || '';
  $('#searchType').value = item.type === 'series' ? 'series' : item.type === 'movie' ? 'movie' : 'multi';
  $('#searchResults').innerHTML = '';
  $('#searchModal').classList.remove('hidden');
  setTimeout(() => $('#searchInput').focus(), 50);
  runSearch();
}

function closeSearchModal() {
  $('#searchModal').classList.add('hidden');
  state.searchingFor = null;
}

async function runSearch() {
  const q = $('#searchInput').value.trim();
  const type = $('#searchType').value;
  const target = $('#searchResults');
  if (!q) { target.innerHTML = '<div class="search-empty">Digite algo para buscar</div>'; return; }
  target.innerHTML = '<div class="search-empty">Buscando…</div>';
  const res = await window.api.searchMeta(q, type);
  if (!res.ok) { target.innerHTML = `<div class="search-empty">${escapeHtml(res.error || 'Erro')}</div>`; return; }
  if (!res.results.length) { target.innerHTML = '<div class="search-empty">Nenhum resultado</div>'; return; }
  target.innerHTML = '';
  for (const r of res.results) {
    const row = document.createElement('div');
    row.className = 'search-result';
    row.innerHTML = `
      <div class="search-poster" ${r.posterUrl ? `style="background-image:url('${r.posterUrl}')"` : ''}></div>
      <div class="search-info">
        <h3>${escapeHtml(r.title)}</h3>
        <p>${escapeHtml(r.overview || 'Sem sinopse')}</p>
      </div>
      <div class="search-meta">${escapeHtml(r.year || '')} · ${(r.mediaType || '').toUpperCase()}</div>
    `;
    row.addEventListener('click', async () => {
      const item = state.searchingFor;
      if (!item) return;
      showToast('Aplicando metadados…');
      const apply = await window.api.applyMeta(item.title, item.type, r.id, r.mediaType, item.rawTitle, item.folder);
      if (!apply.ok) { showToast(apply.error || 'Falhou'); return; }
      state.library = apply.library;
      state.imageCache.clear();
      closeSearchModal();
      await renderAll();
      // Reopen detail with the updated item, by matched title
      const updated = state.library.find((x) => x.title.toLowerCase() === r.title.toLowerCase()) ||
                      state.library.find((x) => x.id === item.id);
      if (updated) openDetail(updated);
      showToast('Metadados aplicados');
    });
    target.appendChild(row);
  }
}

// ---------- Playback ----------
async function playItem(item) {
  if (item.type === 'series') {
    const ep = nextEpisode(item);
    return playFile(ep.path, item, ep);
  }
  return playFile(item.path, item, null);
}

async function playFile(filePath, item, episode) {
  const cfg = await window.api.getConfig();
  const res = await window.api.play(filePath);
  if (!res.ok) {
    showToast(res.error || 'Falha ao abrir');
    return;
  }
  if (res.embedded) {
    // Player embutido — abre overlay com o vídeo
    await openEmbeddedPlayer({ url: res.url, filePath, item, episode, autoNext: cfg.autoNext, autoNextSeconds: cfg.autoNextSeconds || 8 });
  } else {
    showToast(res.fallbackMsg || 'Abrindo no VLC…', 4000);
  }
  await window.api.logOpen(filePath);
  // Refresh history immediately so "Continuar assistindo" updates without waiting
  state.history = await window.api.getHistory();
  await renderRows();
  await renderHero();
}

// ---------- Embedded player ----------
const player = {
  el: null, video: null, hideTimer: null, current: null, nextTimer: null, nextRemaining: 0,
};

function srtToVtt(src) {
  // Convert SRT to WebVTT (browser <track> understands VTT natively)
  let s = src.replace(/\r+/g, '');
  // Replace comma decimals in timestamps with dot
  s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // Strip BOM, ensure header
  s = s.replace(/^\uFEFF/, '');
  return 'WEBVTT\n\n' + s;
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function ensurePlayerInit() {
  if (player.el) return;
  player.el = document.getElementById('player');
  player.video = document.getElementById('playerVideo');

  const v = player.video;
  const playBtn = document.getElementById('playerPlayBtn');
  const playIcon = document.getElementById('playerPlayIcon');
  const pauseIcon = document.getElementById('playerPauseIcon');
  const timeEl = document.getElementById('playerTime');
  const fill = document.getElementById('playerProgressFill');
  const progEl = document.getElementById('playerProgress');
  const muteBtn = document.getElementById('playerMuteBtn');
  const volRange = document.getElementById('playerVol');
  const fsBtn = document.getElementById('playerFsBtn');
  const back10 = document.getElementById('playerBack10');
  const fwd10 = document.getElementById('playerFwd10');
  const subsBtn = document.getElementById('playerSubsBtn');
  const subsMenu = document.getElementById('playerSubsMenu');

  const showChrome = () => {
    player.el.classList.remove('hide-chrome');
    clearTimeout(player.hideTimer);
    player.hideTimer = setTimeout(() => {
      if (!v.paused) player.el.classList.add('hide-chrome');
    }, 2500);
  };
  player.el.addEventListener('mousemove', showChrome);

  playBtn.onclick = () => v.paused ? v.play() : v.pause();
  v.addEventListener('play', () => { playIcon.hidden = true; pauseIcon.hidden = false; });
  v.addEventListener('pause', () => { playIcon.hidden = false; pauseIcon.hidden = true; });
  v.addEventListener('click', () => v.paused ? v.play() : v.pause());

  v.addEventListener('timeupdate', () => {
    if (v.duration) fill.style.width = (v.currentTime / v.duration * 100) + '%';
    timeEl.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  });

  // Save progress every 4s
  let lastSave = 0;
  v.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastSave > 4000 && v.duration && player.current) {
      lastSave = now;
      window.api.saveProgress(player.current.filePath, v.currentTime, v.duration);
    }
  });

  progEl.onclick = (e) => {
    if (!v.duration) return;
    const r = progEl.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
  };

  back10.onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
  fwd10.onclick = () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); };

  muteBtn.onclick = () => { v.muted = !v.muted; volRange.value = v.muted ? 0 : v.volume; };
  volRange.oninput = () => { v.volume = parseFloat(volRange.value); v.muted = v.volume === 0; };

  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else player.el.requestFullscreen();
  };

  subsBtn.onclick = (e) => { e.stopPropagation(); subsMenu.classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!subsMenu.contains(e.target) && e.target !== subsBtn) subsMenu.classList.add('hidden');
  });

  document.getElementById('playerClose').onclick = () => closeEmbeddedPlayer();

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (player.el.classList.contains('hidden')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); showChrome(); }
    else if (e.key === 'ArrowRight') { v.currentTime = Math.min(v.duration||0, v.currentTime + 5); showChrome(); }
    else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); showChrome(); }
    else if (e.key === 'ArrowUp') { v.volume = Math.min(1, v.volume + 0.1); volRange.value = v.volume; showChrome(); }
    else if (e.key === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); volRange.value = v.volume; showChrome(); }
    else if (e.key === 'f' || e.key === 'F') { fsBtn.click(); }
    else if (e.key === 'm' || e.key === 'M') { muteBtn.click(); }
    else if (e.key === 'c' || e.key === 'C') { subsMenu.classList.toggle('hidden'); }
    else if (e.key === 'Escape') { if (document.fullscreenElement) document.exitFullscreen(); else closeEmbeddedPlayer(); }
  });

  v.addEventListener('ended', () => onPlaybackEnded());
}

function buildSubsMenu(subs) {
  const menu = document.getElementById('playerSubsMenu');
  menu.innerHTML = '';
  const off = document.createElement('div');
  off.className = 'player-subs-item active';
  off.textContent = 'Desligar';
  off.onclick = () => selectSub(-1);
  menu.appendChild(off);
  subs.forEach((s, i) => {
    const it = document.createElement('div');
    it.className = 'player-subs-item';
    it.textContent = s.label + (s.lang ? '' : ` — ${s.name}`);
    it.dataset.idx = i;
    it.onclick = () => selectSub(i);
    menu.appendChild(it);
  });
}

function selectSub(idx) {
  const v = player.video;
  for (let i = 0; i < v.textTracks.length; i++) {
    v.textTracks[i].mode = (i === idx) ? 'showing' : 'disabled';
  }
  document.querySelectorAll('#playerSubsMenu .player-subs-item').forEach((el, i) => {
    el.classList.toggle('active', (i - 1) === idx); // first item is "Off" -> idx -1
  });
  document.getElementById('playerSubsMenu').classList.add('hidden');
}

async function openEmbeddedPlayer({ url, filePath, item, episode, autoNext, autoNextSeconds }) {
  ensurePlayerInit();
  player.current = { filePath, item, episode, autoNext, autoNextSeconds };
  cancelAutoNext();
  player.el.classList.remove('hidden', 'hide-chrome');

  // Title
  document.getElementById('playerTitle').textContent = item ? item.title : '';
  document.getElementById('playerSubtitle').textContent = episode
    ? `T${String(episode.season).padStart(2,'0')} · E${String(episode.episode).padStart(2,'0')}${episode.title ? ' — ' + episode.title : ''}`
    : '';

  // Clear previous tracks
  const v = player.video;
  v.pause();
  while (v.firstChild) v.removeChild(v.firstChild);
  v.removeAttribute('src');
  v.load();

  // Source
  const src = document.createElement('source');
  src.src = url;
  v.appendChild(src);

  // Sidecars (subtitles)
  let subs = [];
  try {
    const r = await window.api.getSidecars(filePath);
    if (r && r.ok) subs = r.subs || [];
  } catch {}
  for (const s of subs) {
    const vtt = s.ext === 'vtt' ? s.content : srtToVtt(s.content);
    const blob = new Blob([vtt], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = s.label;
    t.srclang = (s.lang || 'und').slice(0,2);
    t.src = blobUrl;
    v.appendChild(t);
  }
  buildSubsMenu(subs);

  v.load();

  // Resume from saved progress
  const savedProg = state.progress[filePath];
  v.addEventListener('loadedmetadata', () => {
    if (savedProg && savedProg.length && savedProg.time && savedProg.time / savedProg.length < 0.95) {
      v.currentTime = Math.max(0, savedProg.time - 3);
    }
    // Auto-show first sub track if any
    if (v.textTracks.length) {
      v.textTracks[0].mode = 'showing';
      const firstItem = document.querySelector('#playerSubsMenu .player-subs-item[data-idx="0"]');
      if (firstItem) {
        document.querySelectorAll('#playerSubsMenu .player-subs-item').forEach(el => el.classList.remove('active'));
        firstItem.classList.add('active');
      }
    }
    v.play().catch(()=>{});
  }, { once: true });
}

function closeEmbeddedPlayer() {
  cancelAutoNext();
  if (!player.el) return;
  const v = player.video;
  if (player.current && v.duration) {
    window.api.saveProgress(player.current.filePath, v.currentTime, v.duration);
  }
  if (player.current) window.api.logClose(player.current.filePath);
  v.pause();
  v.removeAttribute('src');
  v.load();
  player.el.classList.add('hidden');
  player.current = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
  // Refresh continue row
  (async () => {
    state.progress = await window.api.getProgress();
    state.history = await window.api.getHistory();
    await renderRows();
    await renderHero();
  })();
}

function findNextEpisode(item, currentEp) {
  if (!item || item.type !== 'series' || !currentEp) return null;
  const idx = item.episodes.findIndex((e) => e.path === currentEp.path);
  if (idx < 0 || idx >= item.episodes.length - 1) return null;
  return item.episodes[idx + 1];
}

function onPlaybackEnded() {
  const cur = player.current;
  if (!cur || !cur.autoNext) { closeEmbeddedPlayer(); return; }
  const next = findNextEpisode(cur.item, cur.episode);
  if (!next) { closeEmbeddedPlayer(); return; }
  showAutoNextCard(next);
}

async function showAutoNextCard(nextEp) {
  const card = document.getElementById('playerNextCard');
  const cur = player.current;
  document.getElementById('playerNextTitle').textContent =
    `T${String(nextEp.season).padStart(2,'0')} E${String(nextEp.episode).padStart(2,'0')}${nextEp.title ? ' — ' + nextEp.title : ''}`;
  document.getElementById('playerNextOverview').textContent = nextEp.overview || '';
  // Backdrop from item meta
  const bg = document.getElementById('playerNextBg');
  if (cur.item && cur.item.banner) {
    const data = await loadImage(cur.item.banner);
    if (data) bg.style.backgroundImage = `url("${data}")`;
  }
  card.classList.remove('hidden');

  player.nextRemaining = cur.autoNextSeconds || 8;
  const cdEl = document.getElementById('playerNextCountdown');
  cdEl.textContent = `(${player.nextRemaining}s)`;
  player.nextTimer = setInterval(() => {
    player.nextRemaining -= 1;
    cdEl.textContent = `(${player.nextRemaining}s)`;
    if (player.nextRemaining <= 0) {
      cancelAutoNext();
      playFile(nextEp.path, cur.item, nextEp);
    }
  }, 1000);

  document.getElementById('playerNextPlayBtn').onclick = () => {
    cancelAutoNext();
    playFile(nextEp.path, cur.item, nextEp);
  };
  document.getElementById('playerNextCancelBtn').onclick = () => {
    cancelAutoNext();
    closeEmbeddedPlayer();
  };
}

function cancelAutoNext() {
  if (player.nextTimer) { clearInterval(player.nextTimer); player.nextTimer = null; }
  const card = document.getElementById('playerNextCard');
  if (card) card.classList.add('hidden');
}

// ---------- Settings ----------
async function renderSettings() {
  const cfg = await window.api.getConfig();
  const list = $('#folderList');
  list.innerHTML = '';
  if (!cfg.folders.length) {
    const li = document.createElement('li');
    li.className = 'empty-row';
    li.textContent = 'Nenhuma pasta adicionada ainda.';
    list.appendChild(li);
  } else {
    for (const folder of cfg.folders) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="path">${escapeHtml(folder)}</div>
        <div class="actions">
          <button class="btn-ghost" data-open>Abrir</button>
          <button class="btn-ghost" data-remove>Remover</button>
        </div>
      `;
      li.querySelector('[data-open]').addEventListener('click', () => window.api.openFolder(folder));
      li.querySelector('[data-remove]').addEventListener('click', async () => {
        const res = await window.api.removeFolder(folder);
        state.library = res.library;
        renderSettings();
        renderAll();
      });
      list.appendChild(li);
    }
  }
  $('#vlcInfo').textContent = `VLC: ${cfg.vlcPath || 'auto-detectado em Program Files (configurar se não funcionar)'} · porta HTTP ${cfg.vlcPort}`;
  $('#tmdbKeyInput').value = cfg.tmdbKey || '';

  // Player kind radios
  const embeddedRadio = $('#playerEmbeddedRadio');
  const vlcRadio = $('#playerVlcRadio');
  if (embeddedRadio && vlcRadio) {
    embeddedRadio.checked = !!cfg.embeddedPlayer;
    vlcRadio.checked = !cfg.embeddedPlayer;
    embeddedRadio.onchange = async () => {
      if (embeddedRadio.checked) {
        await window.api.setToggle('embeddedPlayer', true);
        showToast('Player embutido ativado');
      }
    };
    vlcRadio.onchange = async () => {
      if (vlcRadio.checked) {
        await window.api.setToggle('embeddedPlayer', false);
        showToast('VLC externo ativado');
      }
    };
  }

  // Toggles
  const wireToggle = (id, key) => {
    const el = $('#' + id);
    if (!el) return;
    el.checked = !!cfg[key];
    el.onchange = async () => {
      await window.api.setToggle(key, el.checked);
      showToast((el.checked ? 'Ativado: ' : 'Desativado: ') + el.parentElement.textContent.trim());
    };
  };
  wireToggle('autoNextToggle', 'autoNext');
  wireToggle('autoRescanToggle', 'autoRescan');
  wireToggle('skipIntroToggle', 'skipIntro');

  const secInput = $('#autoNextSecondsInput');
  if (secInput) {
    secInput.value = cfg.autoNextSeconds || 8;
    secInput.onchange = async () => {
      await window.api.setNumber('autoNextSeconds', secInput.value);
    };
  }
}

// ---------- Routing ----------
function route(name) {
  $$('.nav-link').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  const home = name === 'home';
  $('#hero').classList.toggle('hidden', !home);
  ['#continueRow', '#seriesRow', '#moviesRow'].forEach((s) => {
    const el = $(s);
    if (!home) el.classList.add('hidden');
    else if (el.querySelector('.row-track').children.length) el.classList.remove('hidden');
  });
  if (home && !state.library.length) $('#empty').classList.remove('hidden');
  else $('#empty').classList.add('hidden');
  $('#settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'settings') renderSettings();
}

// ---------- Bootstrap ----------
async function renderAll() {
  [state.progress, state.history] = await Promise.all([
    window.api.getProgress(),
    window.api.getHistory(),
  ]);
  await renderHero();
  await renderRows();
  if (!state.library.length) {
    $('#hero').classList.add('hidden');
    $('#empty').classList.remove('hidden');
  } else {
    $('#empty').classList.add('hidden');
  }
}

async function init() {
  // Topbar scroll state
  document.addEventListener('scroll', () => {
    $('.topbar').classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  // Nav
  $$('.nav-link').forEach((b) => b.addEventListener('click', () => route(b.dataset.route)));

  // Add folder (then auto-fetch TMDB metadata if a key is configured)
  const addFolder = async () => {
    const res = await window.api.addFolder();
    if (!res.ok) return;
    state.library = res.library;
    await renderAll();
    route('home');
    showToast('Pasta adicionada');
    // Auto-fetch metadata in background so banners/episode names appear without
    // the user having to click Configurações > Buscar metadados.
    const cfg = await window.api.getConfig();
    if (cfg && cfg.tmdbKey) {
      showToast('Buscando metadados no TMDB…', 4000);
      const meta = await window.api.fetchAllMeta();
      if (meta && meta.ok) {
        state.library = meta.library;
        state.imageCache.clear();
        await renderAll();
        showToast(`Metadados atualizados (${meta.updated})`);
      }
    }
  };
  $('#addFolderBtn').addEventListener('click', addFolder);
  $('#emptyAddBtn').addEventListener('click', addFolder);
  $('#settingsAddBtn').addEventListener('click', async () => {
    await addFolder();
    renderSettings();
  });

  // Rescan
  $('#rescanBtn').addEventListener('click', async () => {
    state.library = await window.api.rescan();
    await renderAll();
    showToast('Biblioteca reescaneada');
  });

  // VLC path
  $('#setVlcBtn').addEventListener('click', async () => {
    const res = await window.api.setVlcPath();
    if (res.ok) { showToast('Caminho do VLC salvo'); renderSettings(); }
  });

  // TMDB
  $('#saveTmdbKeyBtn').addEventListener('click', async () => {
    const key = $('#tmdbKeyInput').value.trim();
    await window.api.setTmdbKey(key);
    showToast(key ? 'Chave TMDB salva' : 'Chave TMDB removida');
  });

  $('#fetchMetaBtn').addEventListener('click', async () => {
    const log = $('#metaLog');
    log.classList.add('active');
    log.innerHTML = 'Buscando metadados…\n';
    showToast('Buscando metadados no TMDB…', 4000);
    const res = await window.api.fetchAllMeta();
    if (!res.ok) { showToast(res.error || 'Falhou'); return; }
    state.library = res.library;
    state.imageCache.clear();
    await renderAll();
    log.innerHTML += `\nConcluído: ${res.updated} atualizados, ${res.failed} sem resultado.`;
    showToast(`Metadados atualizados (${res.updated})`);
  });

  $('#clearMetaBtn').addEventListener('click', async () => {
    const res = await window.api.clearMeta();
    state.library = res.library;
    state.imageCache.clear();
    await renderAll();
    showToast('Cache de metadados limpo');
    renderSettings();
  });

  $('#resetCacheBtn').addEventListener('click', async () => {
    const res = await window.api.resetCache();
    state.library = res.library;
    state.progress = await window.api.getProgress();
    state.imageCache.clear();
    await renderAll();
    showToast(`Biblioteca resetada${res.prunedProgress ? ` (${res.prunedProgress} progressos órfãos removidos)` : ''}`);
    renderSettings();
  });

  // Manual TMDB search modal
  $('#searchModalClose').addEventListener('click', closeSearchModal);
  $('#searchModalCloseBtn').addEventListener('click', closeSearchModal);
  $('#searchGoBtn').addEventListener('click', runSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#searchModal').classList.contains('hidden')) closeSearchModal();
  });

  window.api.onMetaProgress((d) => {
    const log = $('#metaLog');
    log.classList.add('active');
    const cls = d.ok ? 'ok' : 'err';
    const line = document.createElement('div');
    line.innerHTML = `<span class="${cls}">${d.ok ? '✓' : '✗'}</span> ${escapeHtml(d.title)}${d.error ? ' — ' + escapeHtml(d.error) : ''}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  });

  // Detail close
  $('#detailClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#detail').classList.contains('hidden')) closeDetail();
  });

  // Periodic refresh of progress + history so the "Continuar" row stays fresh
  setInterval(async () => {
    [state.progress, state.history] = await Promise.all([
      window.api.getProgress(),
      window.api.getHistory(),
    ]);
    await renderRows();
  }, 6000);

  // Initial load
  state.library = await window.api.getLibrary();
  await renderAll();
  if (!state.library.length) route('home');

  // Versão visível + checagem de update silenciosa
  try {
    const v = await window.api.getVersion();
    const txt = document.getElementById('versionText');
    const pill = document.getElementById('versionPill');
    const dot = document.getElementById('versionDot');
    if (txt && v && v.version) {
      txt.textContent = 'v' + v.version;
      pill.onclick = async () => {
        showToast('Verificando atualizações…', 2500);
        const u = await window.api.checkUpdate();
        if (!u || !u.ok) { showToast('Não consegui checar (sem internet?)', 3500); return; }
        if (u.newer) {
          window.api.openExternal(u.downloadUrl || u.url);
        } else {
          showToast(`Você já está na última versão (v${u.current})`, 3500);
        }
      };
      // Background check após 3s
      setTimeout(async () => {
        const u = await window.api.checkUpdate();
        if (u && u.ok && u.newer) {
          pill.classList.add('has-update');
          dot.classList.remove('hidden');
          txt.textContent = `v${u.current} → v${u.latest.replace(/^v/, '')}`;
          showToast(`Nova versão disponível: v${u.latest.replace(/^v/, '')} — clique no número da versão para baixar`, 6000);
        }
      }, 3000);
    }
  } catch {}

  // Discover row (trending). Background-loaded so the UI never blocks.
  renderTrending();
  const refreshTrendingBtn = document.getElementById('refreshTrendingBtn');
  if (refreshTrendingBtn) refreshTrendingBtn.addEventListener('click', () => {
    showToast('Atualizando \"Em alta\"…');
    renderTrending();
  });

  // Live search across all card rows + grid sections. Filters by data-search
  // (set when the card is built). Hides empty rows so the layout stays tight.
  const norm = (s) => String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const searchInput = document.getElementById('topbarSearchInput');
  if (searchInput) {
    const applyFilter = () => {
      const q = norm(searchInput.value.trim());
      document.querySelectorAll('.card').forEach((c) => {
        const hay = c.dataset.search || '';
        const match = !q || norm(hay).includes(q);
        c.style.display = match ? '' : 'none';
      });
      // Hide rows with no visible cards (avoids empty headers when filtering)
      document.querySelectorAll('.row').forEach((row) => {
        if (row.classList.contains('hidden')) return;
        const visible = Array.from(row.querySelectorAll('.card')).some((c) => c.style.display !== 'none');
        row.dataset.filterEmpty = visible ? '' : '1';
        row.style.opacity = visible ? '' : '0.35';
      });
    };
    searchInput.addEventListener('input', applyFilter);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
    });
    // Re-apply after every render (cards are recreated)
    const origRenderAll = renderAll;
    window.__applySearchFilter = applyFilter;
  }

  // IMDb ratings button (settings)
  const imdbBtn = document.getElementById('fetchImdbBtn');
  if (imdbBtn) {
    imdbBtn.addEventListener('click', async () => {
      const log = $('#metaLog');
      log.classList.add('active');
      log.innerHTML = 'Buscando notas IMDb…\n';
      showToast('Baixando notas IMDb…', 4000);
      const res = await window.api.fetchAllImdb();
      if (!res || !res.ok) { showToast(res && res.error ? res.error : 'Falhou'); return; }
      state.library = res.library;
      state.imageCache.clear();
      await renderAll();
      log.innerHTML += `\nConcluído: ${res.updated} com nota, ${res.missing} sem correspondência.`;
      showToast(`Notas IMDb atualizadas (${res.updated})`);
    });
  }
  if (window.api.onImdbProgress) {
    window.api.onImdbProgress((d) => {
      const log = $('#metaLog');
      log.classList.add('active');
      const cls = d.ok ? 'ok' : 'err';
      const line = document.createElement('div');
      line.innerHTML = `<span class="${cls}">${d.ok ? '★' : '✗'}</span> ${escapeHtml(d.title)}${d.rating ? ' — ' + d.rating : ''}`;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    });
  }

  // Restore + wire row view toggles (carousel <-> grid). Preference is persisted
  // per row in localStorage so it survives restarts.
  document.querySelectorAll('.row-toggle').forEach((btn) => {
    const targetId = btn.dataset.target;
    const section = document.getElementById(targetId);
    if (!section) return;
    const storageKey = 'rowView:' + targetId;
    // Grid is the default; only switch to carousel when explicitly saved.
    const saved = localStorage.getItem(storageKey);
    if (saved === 'row') section.classList.remove('grid');
    else section.classList.add('grid');
    btn.addEventListener('click', () => {
      const isGrid = section.classList.toggle('grid');
      localStorage.setItem(storageKey, isGrid ? 'grid' : 'row');
    });
  });
}

init().catch((e) => {
  console.error(e);
  showToast('Erro ao iniciar: ' + e.message);
});
