/* Mediaflix renderer */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  library: [],
  progress: {},
  history: {},
  currentDetail: null,
  currentProfile: null,
  profiles: [],
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
  const playable = (item.episodes || []).filter((e) => !e.missing && e.path);
  if (!playable.length) return null;
  const last = itemProgress(item);
  if (!last || !last.episode) return playable[0];
  if (last.ratio < 0.95) return last.episode;
  const idx = playable.findIndex((e) => e.path === last.episode.path);
  if (idx < 0) return playable[0];
  return playable[Math.min(idx + 1, playable.length - 1)];
}

async function loadImage(filePath) {
  if (!filePath) return null;
  if (state.imageCache.has(filePath)) return state.imageCache.get(filePath);
  const data = await window.api.readImage(filePath);
  state.imageCache.set(filePath, data);
  return data;
}

function episodeThumbSrc(ep) {
  if (ep && ep.stillPath) return `https://image.tmdb.org/t/p/w500${ep.stillPath}`;
  return '';
}

function episodeThumbFallbackStyle(item) {
  const bg = item && (item.banner || item.poster);
  if (!bg) return '';
  return ` style="background-image:linear-gradient(180deg, rgba(0,0,0,.10), rgba(0,0,0,.45)), url('${bg}')"`;
}

function episodeThumbImg(ep) {
  const primary = episodeThumbSrc(ep);
  const src = primary || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  const tmdb = primary ? '1' : '0';
  // Episodios missing nao tem arquivo local — nao tentar buscar thumbnail
  // local pelo backend (causaria 404).
  const pathAttr = ep && ep.path ? escapeHtml(ep.path) : '';
  return `<img loading="lazy" src="${src}" data-episode-path="${pathAttr}" data-tmdb="${tmdb}" alt="" onerror="handleEpisodeThumbError(this)" />`;
}

async function loadLocalEpisodeThumb(img) {
  if (!img) return false;
  if (img.dataset.localTried === '1') {
    img.style.display = 'none';
    img.closest('.episode-thumb,.player-eps-thumb')?.classList.add('fallback-visible');
    return false;
  }
  img.dataset.localTried = '1';
  const filePath = img.dataset.episodePath;
  if (!filePath || !window.api.getThumbnail) return false;
  try {
    const r = await window.api.getThumbnail(filePath);
    if (r && r.ok && r.data) {
      img.style.display = '';
      img.closest('.episode-thumb,.player-eps-thumb')?.classList.remove('fallback-visible');
      img.src = r.data;
      return true;
    }
  } catch (e) {
    console.warn('thumbnail local falhou', e);
  }
  img.style.display = 'none';
  img.closest('.episode-thumb,.player-eps-thumb')?.classList.add('fallback-visible');
  return false;
}

window.handleEpisodeThumbError = (img) => { loadLocalEpisodeThumb(img); };

function hydrateEpisodeThumbs(root = document) {
  root.querySelectorAll('img[data-episode-path]').forEach((img) => {
    if (img.dataset.tmdb === '1' && img.complete && img.naturalWidth > 1) return;
    if (img.dataset.tmdb !== '1') loadLocalEpisodeThumb(img);
  });
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
      <div class="hero-mobile-brand"><span class="hero-n">M</span><span>MediaFlix</span></div>
      <span class="kicker">${prog ? 'Continuar' : 'Em destaque'}</span>
      <h1 class="hero-title">${escapeHtml(featured.title)}</h1>
      <div class="hero-meta">
        ${meta.map((m, i) => `${i ? '<span class="dot"></span>' : ''}<span>${m}</span>`).join('')}
        ${prog ? `<span class="dot"></span><span>${Math.round(prog.ratio * 100)}% assistido</span>` : ''}
      </div>
      <p class="hero-mobile-overview">${escapeHtml(featured.overview || 'Continue sua sessão no MediaFlix com reprodução rápida, progresso salvo e episódios organizados.')}</p>
      <div class="hero-mobile-actions" aria-label="Ações rápidas">
        <button class="hero-icon-btn" id="heroMyList" type="button" aria-label="Minha lista"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 5v14M5 12h14"/></svg></button>
        <button class="hero-icon-btn" id="heroDetailsIcon" type="button" aria-label="Detalhes"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 17v-6"/><path d="M12 7h.01"/><circle cx="12" cy="12" r="9"/></svg></button>
        <button class="btn-primary hero-watch-now" id="heroPlayMobile" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg><span>Assistir agora</span></button>
        <button class="hero-icon-btn" id="heroRate" type="button" aria-label="Gostei"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M7 10v10H4V10h3zM7 10l4-7 1 1a3 3 0 0 1 .6 3.2L12 9h6a2 2 0 0 1 2 2.3l-1 7A2 2 0 0 1 17 20H7"/></svg></button>
        <button class="hero-icon-btn" id="heroAdd" type="button" aria-label="Adicionar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 5v14M5 12h14"/></svg></button>
      </div>
      <div class="hero-mobile-genres">MediaFlix <span>•</span> streaming local <span>•</span> episódios</div>
      <div class="hero-actions">
        <button class="btn-primary" id="heroPlay">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>
          <span>${prog ? 'Continuar' : 'Reproduzir'}</span>
        </button>
        <button class="btn-ghost" id="heroInfo">Mais detalhes</button>
      </div>
    </div>
  `;

  $('#hero').setAttribute('aria-busy', 'false');
  $('#heroPlay').addEventListener('click', () => playItem(featured));
  $('#heroInfo').addEventListener('click', () => openDetail(featured));
  $('#heroPlayMobile')?.addEventListener('click', () => playItem(featured));
  $('#heroDetailsIcon')?.addEventListener('click', () => openDetail(featured));
  $('#heroMyList')?.addEventListener('click', () => showToast('Já está na sua biblioteca'));
  $('#heroRate')?.addEventListener('click', () => showToast('Marcado como gostei'));
  $('#heroAdd')?.addEventListener('click', () => showToast('Adicionado aos favoritos'));
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


function ratingClass(value) {
  const n = Number(value) || 0;
  if (n >= 8.5) return 'elite';
  if (n >= 7.5) return 'great';
  if (n >= 6.5) return 'good';
  return 'mixed';
}
function ratingLabel(value) {
  const n = Number(value) || 0;
  if (n >= 8.5) return 'Excelente';
  if (n >= 7.5) return 'Muito bom';
  if (n >= 6.5) return 'Bom';
  return 'Misto';
}
function seasonAverage(season) {
  const vals = (season && season.episodes || []).map((e) => e.imdbRating).filter((r) => typeof r === 'number');
  if (!vals.length) return null;
  return +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

// ---------- Detail overlay ----------
async function openDetail(item) {
  state.currentDetail = item;
  const d = $('#detail');
  d.classList.remove('hidden');
  document.body.classList.add('detail-open');

  const bg = item.banner ? await loadImage(item.banner) : null;
  $('#detailBg').style.backgroundImage = bg ? `url('${bg}')` : 'linear-gradient(135deg,#1a1a1f,#0a0a0b)';
  $('#detailKicker').textContent = item.type === 'series' ? 'Série' : 'Filme';
  $('#detailTitle').textContent = item.title;
  $('#detailOverview').textContent = item.overview || '';
  const quick = $('#detailMobileActions');
  if (quick) {
    const prog = itemProgress(item);
    const status = prog && prog.ratio >= 0.95 ? 'Assistido' : (prog && prog.ratio > 0.02 ? `${Math.round(prog.ratio * 100)}% visto` : 'Minha lista');
    quick.innerHTML = `
      <button type="button" class="detail-quick-btn" data-action="folder">
        <span class="detail-quick-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></span>
        <span>Pasta</span>
      </button>
      <button type="button" class="detail-quick-btn" data-action="identify">
        <span class="detail-quick-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span>
        <span>TMDB</span>
      </button>
      <button type="button" class="detail-quick-btn" data-action="status">
        <span class="detail-quick-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 6 9 17l-5-5"/></svg></span>
        <span>${status}</span>
      </button>
      <button type="button" class="detail-quick-btn" data-action="play">
        <span class="detail-quick-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg></span>
        <span>Assistir</span>
      </button>
    `;
    quick.querySelector('[data-action="folder"]').onclick = () => window.api.openFolder(item.folder || item.path);
    quick.querySelector('[data-action="identify"]').onclick = () => openSearchModal(item);
    quick.querySelector('[data-action="play"]').onclick = () => playItem(item);
  }

  // Big rating block (IMDb preferred). Computes best episode if we have
  // per-episode ratings, so the user sees the show's quality at a glance.
  const ratingEl = $('#detailRating');
  const r = item.imdbRating;
  if (r) {
    ratingEl.hidden = false;
    ratingEl.className = 'rating-strip ' + ratingClass(r);
    $('#detailRatingValue').textContent = r.toFixed(1);
    $('#detailRatingSource').textContent = item.imdbId ? 'IMDb' : 'TMDB';
    let bestStr = '';
    if (item.type === 'series' && Array.isArray(item.episodes)) {
      let best = null;
      for (const ep of item.episodes) {
        if (typeof ep.imdbRating === 'number' && (!best || ep.imdbRating > best.imdbRating)) best = ep;
      }
      if (best) {
        bestStr = `<span class="rating-pill ${ratingClass(best.imdbRating)}">${ratingLabel(best.imdbRating)}</span><br>Melhor episódio <b>T${best.season} EP ${best.episode || best.index}</b> · ★ ${best.imdbRating.toFixed(1)}`;
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
    if (next) {
      const prog = state.progress[next.path];
      const epLabel = next.season != null
        ? `T${next.season} EP ${next.index}`
        : `EP ${next.index}`;
      $('#detailPlayLabel').textContent = prog && prog.time > 30 ? `Continuar ${epLabel}` : `Reproduzir ${epLabel}`;
      $('#detailPlayBtn').onclick = () => playFile(next.path, item, next);
      $('#detailPlayBtn').classList.remove('hidden');
    } else {
      // Todos os episodios sao missing (so temos metadata, nada no disco ainda)
      $('#detailPlayLabel').textContent = 'Nenhum episódio disponível';
      $('#detailPlayBtn').onclick = () => showToast('Faça upload da pasta da temporada pra começar a assistir.', 3600);
    }

    renderSeasonTabs(item, (next && next.season != null) ? next.season : (item.seasons[0] && item.seasons[0].number));
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
      const avg = seasonAverage(season);
      btn.innerHTML = `Temporada ${season.number}${avg ? ` <span class="season-rating">★ ${avg.toFixed(1)}</span>` : ''}`;
      btn.addEventListener('click', () => renderSeasonTabs(item, season.number));
      tabs.appendChild(btn);
    }
  }

  const active = item.seasons.find((s) => s.number === activeSeasonNum) || item.seasons[0];
  renderEpisodeList(active);
}


function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}
async function deleteEpisodeFile(ep, season) {
  if (!ep || !ep.path || !window.api.deleteMediaFile) return;
  const label = `T${String(ep.season || season.number || 1).padStart(2, '0')} E${String(ep.episode || ep.index || 1).padStart(2, '0')}`;
  const confirmed = await openConfirmModal({
    title: `Apagar ${label}?`,
    message: `O arquivo "${ep.file || ep.title || 'episódio'}" será removido do disco para liberar espaço. O progresso e histórico desse episódio também serão removidos do banco.`,
    confirmText: 'Apagar do disco',
    cancelText: 'Cancelar',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const res = await window.api.deleteMediaFile(ep.path);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Falha ao apagar arquivo');
    state.library = res.library || await window.api.getLibrary();
    state.progress = await window.api.getProgress();
    state.history = await window.api.getHistory();
    const fresh = state.library.find((item) => state.currentDetail && item.id === state.currentDetail.id) || state.library.find((item) => state.currentDetail && item.title === state.currentDetail.title);
    if (fresh) {
      state.currentDetail = fresh;
      const activeSeason = fresh.seasons.find((s) => s.number === season.number) || fresh.seasons[0];
      const epCount = fresh.episodes.length;
      const metaParts = [`${epCount} episódios`];
      if (fresh.seasons.length > 1) metaParts.unshift(`${fresh.seasons.length} temporadas`);
      if (fresh.year) metaParts.push(fresh.year);
      document.getElementById('detailMeta').textContent = metaParts.join(' · ');
      renderSeasonTabs(fresh, activeSeason && activeSeason.number);
    } else {
      closeDetail();
    }
    await renderRows();
    showToast(`Arquivo apagado · ${formatBytes(res.deletedBytes)} liberados`);
  } catch (err) {
    showToast(err.message || 'Não consegui apagar o episódio', 5000);
  }
}

function renderEpisodeList(season) {
  const list = $('#episodeList');
  list.innerHTML = '';
  for (const ep of season.episodes) {
    const isMissing = !!ep.missing;
    const p = !isMissing ? state.progress[ep.path] : null;
    const ratio = p && p.length ? Math.min(1, p.time / p.length) : 0;
    const li = document.createElement('li');
    li.className = 'episode' + (isMissing ? ' missing' : '');
    const statusChip = isMissing
      ? '<span class="episode-status missing-chip">Indisponível</span>'
      : (ratio >= 0.95
          ? '<span class="episode-status watched">Assistido</span>'
          : (ratio > 0.02 ? '<span class="episode-status continue">Continuar</span>' : ''));
    li.innerHTML = `
      <div class="episode-thumb"${episodeThumbFallbackStyle(state.currentDetail)}>
        ${episodeThumbImg(ep)}
        <div class="episode-num-overlay">${String(ep.episode || ep.index).padStart(2, '0')}</div>
        ${statusChip}
        ${ratio > 0 ? `<div class="episode-thumb-progress"><span style="width:${(ratio*100).toFixed(1)}%"></span></div>` : ''}
      </div>
      <div>
        <p class="episode-title">${escapeHtml(ep.title)}</p>
        ${ep.overview ? `<p class="episode-overview">${escapeHtml(ep.overview)}</p>` : ''}
        ${isMissing && ep.airDate ? `<p class="episode-airdate">Estreia: ${escapeHtml(ep.airDate)}</p>` : ''}
      </div>
      <div class="episode-meta">
        ${typeof ep.imdbRating === 'number' ? `<span class="episode-rating-big ${ratingClass(ep.imdbRating)}" title="IMDb · ${ratingLabel(ep.imdbRating)}">★ ${ep.imdbRating.toFixed(1)}</span>` : ''}
        <span class="episode-time">${p ? `${fmtTime(p.time)} / ${fmtTime(p.length)}` : ''}</span>
        ${isMissing
          ? '<span class="episode-missing-label" aria-label="Episódio não está na sua biblioteca">Não baixado</span>'
          : '<button type="button" class="episode-delete" title="Apagar episódio do disco" aria-label="Apagar episódio do disco">Apagar</button>'}
      </div>
    `;
    if (!isMissing) {
      const deleteBtn = li.querySelector('.episode-delete');
      if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteEpisodeFile(ep, season);
      });
      li.addEventListener('click', () => playFile(ep.path, state.currentDetail, ep));
    } else {
      li.addEventListener('click', () => showToast('Episódio ainda não foi adicionado à biblioteca. Faça o upload da pasta da temporada.', 3600));
    }
    list.appendChild(li);
  }
  hydrateEpisodeThumbs(list);
}

function closeDetail() {
  $('#detail').classList.add('hidden');
  document.body.classList.remove('detail-open');
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
  document.body.classList.add('detail-open');

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
    ratingEl2.className = 'rating-strip ' + ratingClass(r2);
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
    if (!ep) {
      showToast('Nenhum episódio disponível para reproduzir.', 3000);
      return;
    }
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
  locked: false, fitMode: 'contain', lastTap: 0, lastTapSide: null, singleTapTimer: null,
  tapComboSide: null, tapComboTotal: 0, tapComboUntil: 0, tapComboTimer: null,
  scrubbing: false,
  intendedLandscape: false, orientationRetryTimer: null,
  saveInFlight: null, pendingSave: null, lastSavedAt: 0,
  openSeq: 0,
};

function isMobileViewport() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || Math.min(window.innerWidth, window.innerHeight) <= 760;
}

function isPortraitViewport() {
  return window.innerHeight > window.innerWidth;
}

function isPlayerOpen() {
  return !!(player.el && !player.el.classList.contains('hidden') && player.current);
}

function isFullscreenActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

function syncPlayerViewportState() {
  if (!player.el) return;
  const shouldFallbackLandscape = isPlayerOpen()
    && player.intendedLandscape
    && isMobileViewport()
    && isPortraitViewport()
    && !isFullscreenActive();
  player.el.classList.toggle('force-landscape', shouldFallbackLandscape);
}

function scheduleLandscapeRepair(reason = 'resume') {
  if (!isPlayerOpen() || !player.intendedLandscape || !isMobileViewport()) return;
  clearTimeout(player.orientationRetryTimer);
  syncPlayerViewportState();
  player.orientationRetryTimer = setTimeout(async () => {
    syncPlayerViewportState();
    if (document.visibilityState === 'hidden') return;
    const v = player.video;
    if (v && !v.paused) await tryAutoLandscape(v, { force: true, reason });
    syncPlayerViewportState();
  }, 260);
}

function absolutePlayerTime() {
  const v = player.video;
  const cur = player.current;
  if (!v || !cur) return { time: 0, length: 0 };
  const length = cur.duration || v.duration || 0;
  const time = (cur.virtualOffset || 0) + (v.currentTime || 0);
  return { time, length };
}

async function flushProgressSave(payload) {
  if (!payload || !payload.filePath || !payload.length || payload.time < 0) return;
  // Atualiza estado local imediatamente para a UI não “esquecer” entre saves.
  state.progress[payload.filePath] = {
    time: payload.time,
    length: payload.length,
    updatedAt: payload.updatedAt || Date.now(),
  };
  await window.api.saveProgress(payload.filePath, payload.time, payload.length, payload.updatedAt);
}

function queueProgressSave({ force = false, reason = 'tick' } = {}) {
  const cur = player.current;
  if (!cur || !cur.filePath || cur._suspendProgressSave) return Promise.resolve();
  const { time, length } = absolutePlayerTime();
  if (!length || !Number.isFinite(time) || time < 0) return Promise.resolve();
  // Evita que o primeiro timeupdate em 0s durante resume de MP4 sobrescreva
  // um episódio que estava quase no fim.
  if (!force && cur._resumeTarget && time < Math.max(5, cur._resumeTarget - 8)) return Promise.resolve();
  const now = Date.now();
  if (!force && now - player.lastSavedAt < 3500) return player.saveInFlight || Promise.resolve();
  player.lastSavedAt = now;
  const payload = { filePath: cur.filePath, time, length, reason, updatedAt: now };
  player.pendingSave = payload;
  if (player.saveInFlight) return player.saveInFlight;
  player.saveInFlight = (async () => {
    while (player.pendingSave) {
      const next = player.pendingSave;
      player.pendingSave = null;
      try { await flushProgressSave(next); } catch (e) { console.warn('save progress failed', e); }
    }
  })().finally(() => { player.saveInFlight = null; });
  return player.saveInFlight;
}

function saveProgressBeacon(reason = 'pagehide') {
  const cur = player.current;
  if (!cur || cur._suspendProgressSave) return;
  const { time, length } = absolutePlayerTime();
  if (!length || time <= 0) return;
  state.progress[cur.filePath] = { time, length, updatedAt: Date.now() };
  try {
    if (!/^https?:$/i.test(window.location.protocol)) return;
    const base = window.location.pathname.startsWith('/mediaflix') ? '/mediaflix' : '';
    const profileId = window.api.getCurrentProfileId ? window.api.getCurrentProfileId() : 'default';
    const body = JSON.stringify({ path: cur.filePath, time, length, profileId, reason, updatedAt: Date.now() });
    const url = `${base}/api/progress`;
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(url, blob)) return;
    }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(()=>{});
  } catch {}
}

function langCodeLabel(code) {
  const map = { 'pt': 'Português', 'pt-br': 'Português (BR)', 'por': 'Português',
                'en': 'English', 'eng': 'English', 'es': 'Español', 'spa': 'Español',
                'fr': 'Français', 'de': 'Deutsch', 'it': 'Italiano', 'ja': '日本語' };
  return map[(code || '').toLowerCase()] || (code ? code.toUpperCase() : '');
}

function srtToVtt(src) {
  // Convert SRT to WebVTT (browser <track> understands VTT natively)
  let s = src.replace(/\r+/g, '');
  // Replace comma decimals in timestamps with dot
  s = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // Strip BOM, ensure header
  s = s.replace(/^\uFEFF/, '');
  return 'WEBVTT\n\n' + s;
}

// Desloca os timestamps do VTT por -offset (em segundos). Usado quando o stream
// fez seek server-side: video reseta pra 0 mas as cues sao absolutas.
function shiftVtt(vtt, offsetSec) {
  if (!offsetSec) return vtt;
  const parseTs = (s) => {
    const p = s.split(':');
    let h = 0, m = 0, sec = 0;
    if (p.length === 3) { h = +p[0]; m = +p[1]; sec = parseFloat(p[2]); }
    else { m = +p[0]; sec = parseFloat(p[1]); }
    return h * 3600 + m * 60 + sec;
  };
  const fmt = (t) => {
    if (t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(3).padStart(6, '0');
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${s}`;
  };
  return vtt.replace(/(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[\.,]\d{1,3})/g, (_m, a, b) => {
    const ta = parseTs(a.replace(',', '.')) - offsetSec;
    const tb = parseTs(b.replace(',', '.')) - offsetSec;
    if (tb < 0) return `${fmt(0)} --> ${fmt(0.001)}`;
    return `${fmt(Math.max(0, ta))} --> ${fmt(tb)}`;
  });
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function seekPlayerBy(delta) {
  const cur = player.current; const v = player.video;
  if (!v) return;
  if (cur && cur.isNative) {
    v.currentTime = Math.max(0, Math.min(v.duration || cur.duration || 0, v.currentTime + delta));
    queueProgressSave({ force: true, reason: 'skip' });
    return;
  }
  if (cur && cur.duration) {
    const target = Math.max(0, Math.min(cur.duration, (cur.virtualOffset || 0) + v.currentTime + delta));
    loadStream(target);
  } else {
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
    queueProgressSave({ force: true, reason: 'skip' });
  }
}

function seekPlayerTo(target) {
  const cur = player.current; const v = player.video;
  if (!v) return;
  const total = (cur && cur.duration) || v.duration || 0;
  const safeTarget = Math.max(0, Math.min(total || 0, Number(target) || 0));
  if (!total) return;
  if (cur && cur.isNative) {
    try { v.currentTime = safeTarget; } catch {}
  } else if (cur) {
    loadStream(safeTarget);
  } else {
    v.currentTime = safeTarget;
  }
  queueProgressSave({ force: true, reason: 'scrub' });
}

function showTapFeedback(side, seconds) {
  const fb = document.getElementById('playerTapFeedback');
  if (!fb) return;
  fb.className = `player-tap-feedback ${side === 'left' ? 'rewind' : 'forward'}`;
  fb.textContent = `${side === 'left' ? '−' : '+'}${seconds}s`;
  clearTimeout(showTapFeedback._t);
  showTapFeedback._t = setTimeout(() => fb.classList.add('hidden'), 620);
}

function resetTapComboSoon() {
  clearTimeout(player.tapComboTimer);
  player.tapComboTimer = setTimeout(() => {
    player.tapComboSide = null;
    player.tapComboTotal = 0;
    player.tapComboUntil = 0;
  }, 760);
}

function setPlayerLocked(locked) {
  player.locked = !!locked;
  player.el?.classList.toggle('locked', player.locked);
  const float = document.getElementById('playerLockFloat');
  clearTimeout(player.lockTimer);
  if (!player.locked) {
    if (float) float.classList.add('hidden');
    return;
  }
  player.el?.classList.add('hide-chrome');
  showLockFloat();
}

function showLockFloat() {
  const float = document.getElementById('playerLockFloat');
  if (!float || !player.locked) return;
  float.classList.remove('hidden');
  clearTimeout(player.lockTimer);
  player.lockTimer = setTimeout(() => float.classList.add('hidden'), 2400);
}

function togglePlayerFit() {
  player.fitMode = player.fitMode === 'cover' ? 'contain' : 'cover';
  player.el?.classList.toggle('fit-cover', player.fitMode === 'cover');
  const ico = document.getElementById('playerFitIcon');
  if (ico) {
    ico.innerHTML = player.fitMode === 'cover'
      // "shrink" — sair do preenchimento
      ? '<path d="M9 3v4a2 2 0 0 1-2 2H3"/><path d="M21 9h-4a2 2 0 0 1-2-2V3"/><path d="M3 15h4a2 2 0 0 1 2 2v4"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>'
      // "crop" — preencher
      : '<path d="M7 2v15a1 1 0 0 0 1 1h13"/><path d="M2 7h15a1 1 0 0 1 1 1v13"/>';
  }
  showToast(player.fitMode === 'cover' ? 'Preenchendo tela' : 'Ajustado sem cortar');
}

function updateFsIcon() {
  const ico = document.getElementById('playerFsIcon');
  if (!ico) return;
  ico.innerHTML = document.fullscreenElement
    ? '<path d="M8 4v3a1 1 0 0 1-1 1H4M16 4v3a1 1 0 0 0 1 1h3M8 20v-3a1 1 0 0 0-1-1H4M16 20v-3a1 1 0 0 1 1-1h3"/>'
    : '<path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/>';
}

function ensurePlayerInit() {
  if (player.el) return;
  player.el = document.getElementById('player');
  player.video = document.getElementById('playerVideo');

  const v = player.video;
  const playBtn = document.getElementById('playerPlayBtn');
  const timeEl = document.getElementById('playerTime');
  const fill = document.getElementById('playerProgressFill');
  const progressBuffer = document.getElementById('playerProgressBuffer');
  const progressThumb = document.getElementById('playerProgressThumb');
  const progressPreview = document.getElementById('playerProgressPreview');
  const progEl = document.getElementById('playerProgress');
  const muteBtn = document.getElementById('playerMuteBtn');
  const volRange = document.getElementById('playerVol');
  const fsBtn = document.getElementById('playerFsBtn');
  const fitBtn = document.getElementById('playerFitBtn');
  const lockBtn = document.getElementById('playerLockBtn');
  const lockFloat = document.getElementById('playerLockFloat');
  const back10 = document.getElementById('playerBack10');
  const fwd10 = document.getElementById('playerFwd10');
  const subsBtn = document.getElementById('playerSubsBtn');
  const subsMenu = document.getElementById('playerSubsMenu');

  const showChrome = () => {
    if (player.locked) return;
    player.el.classList.remove('hide-chrome');
    clearTimeout(player.hideTimer);
    player.hideTimer = setTimeout(() => {
      const vv = player.video;
      if (vv && !vv.paused) player.el.classList.add('hide-chrome');
    }, 3500);
  };
  // Toque único alterna controles. Duplo toque: esquerda volta, direita avança.
  const SELECTORS_INTERACTIVE = '.player-btn, .player-center-btn, .player-eps, .player-progress, .player-top > *, .player-bottom, .player-skip-btn, .player-next-card, .player-vol, .player-subs-menu, .player-subs-wrap, input, select, button';
  const onPlayerTap = (e) => {
    if (e.target.closest(SELECTORS_INTERACTIVE)) return;
    if (player.locked) { showLockFloat(); return; }
    const now = Date.now();
    const x = (e.clientX || (e.touches && e.touches[0] && e.touches[0].clientX) || window.innerWidth / 2);
    const side = x < window.innerWidth / 2 ? 'left' : 'right';
    const sec = Math.max(3, Math.min(30, Number(player.current?.doubleTapSeconds || 5)));
    if (now < player.tapComboUntil && player.tapComboSide === side) {
      clearTimeout(player.singleTapTimer);
      seekPlayerBy(side === 'left' ? -sec : sec);
      player.tapComboTotal += sec;
      player.tapComboUntil = now + 680;
      showTapFeedback(side, player.tapComboTotal);
      resetTapComboSoon();
      return;
    }
    if (now - player.lastTap < 280 && player.lastTapSide === side) {
      clearTimeout(player.singleTapTimer);
      seekPlayerBy(side === 'left' ? -sec : sec);
      player.tapComboSide = side;
      player.tapComboTotal = sec;
      player.tapComboUntil = now + 680;
      showTapFeedback(side, player.tapComboTotal);
      resetTapComboSoon();
      player.lastTap = 0;
      return;
    }
    player.lastTap = now;
    player.lastTapSide = side;
    clearTimeout(player.singleTapTimer);
    player.singleTapTimer = setTimeout(() => {
      // Toque único só mostra/renova os controles; eles somem depois do timer.
      // Não escondemos instantaneamente, porque isso atrapalha no mobile.
      showChrome();
    }, 290);
  };
  player.el.addEventListener('mousemove', () => { if (!player.locked) showChrome(); });
  player.el.addEventListener('click', onPlayerTap);
  player.onPlayHide = showChrome;

  playBtn.onclick = () => { const vv = player.video; vv.paused ? vv.play() : vv.pause(); };
  const centerBtn = document.getElementById('playerCenterBtn');
  if (centerBtn) {
    centerBtn.onclick = (e) => {
      e.stopPropagation();
      const vv = player.video;
      vv.paused ? vv.play() : vv.pause();
      showChrome();
    };
  }
  bindVideoListeners(v);

  const seekTargetFromEvent = (e) => {
    const cur = player.current; const v = player.video;
    const total = (cur && cur.duration) || v.duration || 0;
    if (!total) return 0;
    const r = progEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, (e.clientX || 0) - r.left));
    return (x / Math.max(1, r.width)) * total;
  };
  const updateProgressPreview = (e) => {
    const cur = player.current; const v = player.video;
    const total = (cur && cur.duration) || v.duration || 0;
    if (!total || !progressPreview) return;
    const r = progEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, (e.clientX || 0) - r.left));
    const target = (x / Math.max(1, r.width)) * total;
    progressPreview.textContent = fmtTime(target);
    progressPreview.style.left = `${x}px`;
    progressPreview.classList.remove('hidden');
  };
  const updateScrubVisual = (e) => {
    const cur = player.current; const v = player.video;
    const total = (cur && cur.duration) || v.duration || 0;
    if (!total) return;
    const target = seekTargetFromEvent(e);
    const pct = Math.max(0, Math.min(100, (target / total) * 100));
    fill.style.width = `${pct}%`;
    if (progressThumb) progressThumb.style.left = `${pct}%`;
    updateProgressPreview(e);
  };
  progEl.addEventListener('pointerenter', updateProgressPreview);
  progEl.addEventListener('pointermove', (e) => {
    if (player.scrubbing) updateScrubVisual(e);
    else updateProgressPreview(e);
  });
  progEl.addEventListener('pointerleave', () => {
    if (!player.scrubbing && progressPreview) progressPreview.classList.add('hidden');
  });
  progEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    player.scrubbing = true;
    progEl.classList.add('scrubbing');
    try { progEl.setPointerCapture(e.pointerId); } catch {}
    updateScrubVisual(e);
    showChrome();
  });
  progEl.addEventListener('pointerup', (e) => {
    if (!player.scrubbing) return;
    e.preventDefault();
    const target = seekTargetFromEvent(e);
    player.scrubbing = false;
    progEl.classList.remove('scrubbing');
    if (progressPreview) progressPreview.classList.add('hidden');
    seekPlayerTo(target);
    showChrome();
  });
  progEl.addEventListener('pointercancel', () => {
    player.scrubbing = false;
    progEl.classList.remove('scrubbing');
    if (progressPreview) progressPreview.classList.add('hidden');
  });
  const updateBuffered = () => {
    const v = player.video;
    const cur = player.current;
    const total = (cur && cur.duration) || v.duration || 0;
    if (!progressBuffer || !total || !v.buffered || !v.buffered.length) return;
    try {
      const end = v.buffered.end(v.buffered.length - 1) + ((cur && cur.virtualOffset) || 0);
      progressBuffer.style.width = `${Math.max(0, Math.min(100, (end / total) * 100))}%`;
    } catch {
      progressBuffer.style.width = '0%';
    }
  };
  v.addEventListener('progress', updateBuffered);
  v.addEventListener('loadedmetadata', updateBuffered);

  back10.onclick = () => seekPlayerBy(-10);
  fwd10.onclick = () => seekPlayerBy(10);

  muteBtn.onclick = () => { const v = player.video; v.muted = !v.muted; volRange.value = v.muted ? 0 : v.volume; };
  volRange.oninput = () => { const v = player.video; v.volume = parseFloat(volRange.value); v.muted = v.volume === 0; };

  fsBtn.onclick = () => {
    if (document.fullscreenElement) {
      player.intendedLandscape = false;
      player.el.classList.remove('force-landscape');
      document.exitFullscreen();
    }
    else {
      player.intendedLandscape = isMobileViewport();
      player.el.requestFullscreen();
      scheduleLandscapeRepair('manual-fullscreen');
    }
  };
  if (fitBtn) fitBtn.onclick = togglePlayerFit;
  if (lockBtn) lockBtn.onclick = () => setPlayerLocked(true);
  if (lockFloat) lockFloat.onclick = (e) => { e.stopPropagation(); setPlayerLocked(false); showChrome(); };

  subsBtn.onclick = (e) => { e.stopPropagation(); subsMenu.classList.toggle('hidden'); document.getElementById('playerAudioMenu')?.classList.add('hidden'); };
  document.addEventListener('click', (e) => {
    if (!subsMenu.contains(e.target) && e.target !== subsBtn) subsMenu.classList.add('hidden');
  });

  // Audio menu toggle
  const audioBtn = document.getElementById('playerAudioBtn');
  const audioMenu = document.getElementById('playerAudioMenu');
  if (audioBtn) {
    audioBtn.onclick = (e) => { e.stopPropagation(); audioMenu.classList.toggle('hidden'); subsMenu.classList.add('hidden'); };
    document.addEventListener('click', (e) => {
      if (!audioMenu.contains(e.target) && e.target !== audioBtn) audioMenu.classList.add('hidden');
    });
  }

  document.getElementById('playerClose').onclick = () => closeEmbeddedPlayer();

  setupChromecast();

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (player.el.classList.contains('hidden')) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const v = player.video;
    if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); showChrome(); }
    else if (e.key === 'ArrowRight') { v.currentTime = Math.min(v.duration||0, v.currentTime + 5); showChrome(); }
    else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); showChrome(); }
    else if (e.key === 'ArrowUp') { v.volume = Math.min(1, v.volume + 0.1); volRange.value = v.volume; showChrome(); }
    else if (e.key === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); volRange.value = v.volume; showChrome(); }
    else if (e.key === 'f' || e.key === 'F') { fsBtn.click(); }
    else if (e.key === 'm' || e.key === 'M') { muteBtn.click(); }
    else if (e.key === 'c' || e.key === 'C') { subsMenu.classList.toggle('hidden'); }
    else if (e.key === 'e' || e.key === 'E') { const eb = document.getElementById('playerEpisodesBtn'); if (eb && eb.style.display !== 'none') eb.click(); }
    else if (e.key === 'Escape') {
      if (document.fullscreenElement) {
        player.intendedLandscape = false;
        player.el.classList.remove('force-landscape');
        document.exitFullscreen();
      } else closeEmbeddedPlayer();
    }
  });

}

// Listeners ligados diretamente ao <video>. Extraido pra poder reanexar
// quando clonamos o elemento em resetVideoElement.
function bindVideoListeners(v) {
  const playPath = document.getElementById('playerPlayPath');
  const centerPath = document.getElementById('playerCenterPath');
  const PATH_PLAY = 'M6 4l14 8-14 8z';
  const PATH_PAUSE = 'M6 4h4v16H6zM14 4h4v16h-4z';
  const timeEl = document.getElementById('playerTime');
  const fill = document.getElementById('playerProgressFill');
  v.addEventListener('play', () => {
    if (playPath) playPath.setAttribute('d', PATH_PAUSE);
    if (centerPath) centerPath.setAttribute('d', PATH_PAUSE);
    if (player.onPlayHide) player.onPlayHide();
    // Se o player ja foi fechado (race condition do open vs close), nao
    // ativamos fullscreen/landscape: pausamos imediatamente.
    if (!player.current || player.el.classList.contains('hidden')) {
      try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
      return;
    }
    if (!player.autoFsTriggered) {
      player.autoFsTriggered = true;
      tryAutoLandscape(v);
    }
  });
  v.addEventListener('pause', () => {
    if (playPath) playPath.setAttribute('d', PATH_PLAY);
    if (centerPath) centerPath.setAttribute('d', PATH_PLAY);
    player.el && player.el.classList.remove('hide-chrome');
    clearTimeout(player.hideTimer);
  });
  // Click no <video> ja eh tratado no container .player via touchstart/mousemove.
  // NAO togglar play/pause aqui — apenas o botao central faz isso.
  v.addEventListener('timeupdate', () => {
    const total = (player.current && player.current.duration) || v.duration || 0;
    const cur = (player.current ? (player.current.virtualOffset || 0) : 0) + v.currentTime;
    if (total && !player.scrubbing) {
      const pct = Math.max(0, Math.min(100, cur / total * 100));
      fill.style.width = pct + '%';
      const thumb = document.getElementById('playerProgressThumb');
      if (thumb) thumb.style.left = pct + '%';
    }
    timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(total)}`;
  });
  v.addEventListener('timeupdate', () => {
    const total = (player.current && player.current.duration) || v.duration || 0;
    const cur = (player.current ? (player.current.virtualOffset || 0) : 0) + v.currentTime;
    queueProgressSave({ reason: 'timeupdate' });
    // Auto-next baseado em duracao real (ffprobe). O evento 'ended' eh
    // pouco confiavel no streaming chunked porque o ffmpeg fecha o pipe
    // mas o <video> nem sempre dispara ended. Disparamos quando faltam
    // <=60s OU quando entra no ultimo capitulo curto (creditos).
    if (player.current && total > 30 && !player.current._endedFired) {
      const remain = total - cur;
      let trigger = false;
      if (remain <= 60) trigger = true;
      // Se chegou no ultimo capitulo e ele eh curto (<= 2min), entra em
      // modo "proximo episodio" mesmo que ainda faltem mais segundos.
      const chaps = player.current.chapters;
      if (chaps && chaps.length > 1) {
        const last = chaps[chaps.length - 1];
        if (cur >= last.start && (last.end - last.start) <= 120) trigger = true;
      }
      if (trigger) {
        player.current._endedFired = true;
        onPlaybackEnded();
      }
    }
    // Skip intro/recap por capitulo
    detectSkippableChapter(cur);
  });
  v.addEventListener('ended', () => onPlaybackEnded());
  v.addEventListener('pause', () => queueProgressSave({ force: true, reason: 'pause' }));
  v.addEventListener('seeking', () => queueProgressSave({ force: true, reason: 'seeking' }));
  v.addEventListener('error', () => {
    const err = v.error;
    const codeMap = { 1: 'aborted', 2: 'rede', 3: 'decode', 4: 'formato/origem nao suportado' };
    const msg = err ? `Erro de player (${codeMap[err.code] || err.code}): ${err.message || ''}` : 'Erro desconhecido';
    console.error('player error', err, v.src);
    showToast(msg, 8000);
  });
  v.addEventListener('stalled', () => console.warn('player stalled'));
  v.addEventListener('waiting', () => console.log('player waiting buffer'));
}

// Auto-fullscreen + landscape lock no estilo Netflix.
// IMPORTANTE: NAO usamos webkitEnterFullscreen do <video> no iOS porque
// ele substitui nossa UI inteira pelos controles nativos da Apple (e ai
// o botao central nem aparece). Em vez disso, fullscreen do CONTAINER
// usa nossa UI e em Android consegue lock de orientacao.
async function tryAutoLandscape(v, opts = {}) {
  try {
    if (!isMobileViewport()) return;
    player.intendedLandscape = true;
    syncPlayerViewportState();
    const el = player.el || v;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req && (opts.force || !isFullscreenActive())) {
      try { await req.call(el); } catch {}
    }
    if (screen.orientation && screen.orientation.lock) {
      try { await screen.orientation.lock('landscape'); } catch {}
    }
    syncPlayerViewportState();
  } catch {}
}

// Substitui o <video> por um clone novo. HTML5 mantem entradas em
// videoEl.textTracks mesmo apos remover os <track> filhos — unica forma de
function resetVideoElement() {
  if (!player.video) return;
  const old = player.video;
  const fresh = old.cloneNode(false); // sem filhos (sem <source>/<track> antigos)
  fresh.removeAttribute('src');
  fresh.controls = false;
  // Garante que o player nao saia pro fullscreen nativo do iOS/Android, que
  // esconderia a UI custom (incl. botao "Pular abertura").
  fresh.setAttribute('playsinline', '');
  fresh.setAttribute('webkit-playsinline', 'true');
  fresh.setAttribute('x5-playsinline', 'true');
  old.replaceWith(fresh);
  player.video = fresh;
  bindVideoListeners(fresh);
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

async function selectSub(idx) {
  const v = player.video;
  const cur = player.current;
  if (!cur) return;
  // -1 = desligar
  if (idx < 0) {
    cur.activeSubIdx = -1;
    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
    document.querySelectorAll('#playerSubsMenu .player-subs-item').forEach((el, i) => {
      el.classList.toggle('active', i === 0);
    });
    document.getElementById('playerSubsMenu').classList.add('hidden');
    return;
  }
  const sub = cur.subs[idx];
  if (!sub) return;

  // Embutida: extrai via ffmpeg sob demanda e guarda VTT bruto
  if (sub.kind === 'embed' && !sub._vttRaw) {
    showToast('Extraindo legenda…', 1800);
    const r = await window.api.extractSub(cur.filePath, sub.index);
    if (!r.ok) { showToast('Falha ao extrair legenda', 3500); return; }
    sub._vttRaw = r.vtt;
  }

  cur.activeSubIdx = idx;
  applySubTracks();
  document.querySelectorAll('#playerSubsMenu .player-subs-item').forEach((el, i) => {
    el.classList.toggle('active', (i - 1) === idx);
  });
  document.getElementById('playerSubsMenu').classList.add('hidden');
}

// Reconstroi os <track> com timestamps deslocados por -virtualOffset.
// Sidecar usa s.content; embed usa sub._vttRaw (preenchido em selectSub).
function applySubTracks() {
  const v = player.video;
  const cur = player.current;
  if (!v || !cur) return;
  // Remove tracks existentes
  Array.from(v.querySelectorAll('track')).forEach((t) => {
    if (t.src && t.src.startsWith('blob:')) URL.revokeObjectURL(t.src);
    t.remove();
  });
  const offset = cur.virtualOffset || 0;
  cur.subs.forEach((s, i) => {
    let raw = null;
    if (s.kind === 'sidecar') {
      raw = s.ext === 'vtt' ? s.content : srtToVtt(s.content);
    } else if (s.kind === 'embed' && s._vttRaw) {
      raw = s._vttRaw;
    }
    if (!raw) { s._trackIdx = -1; return; }
    const shifted = shiftVtt(raw, offset);
    const blob = new Blob([shifted], { type: 'text/vtt' });
    const url = URL.createObjectURL(blob);
    const t = document.createElement('track');
    t.kind = 'subtitles';
    t.label = s.label;
    t.srclang = (s.lang || 'und').slice(0, 2);
    t.src = url;
    v.appendChild(t);
    s._trackIdx = v.textTracks.length - 1;
  });
  // Aplica modo
  const active = cur.activeSubIdx != null ? cur.activeSubIdx : -1;
  setTimeout(() => {
    for (let i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
    if (active >= 0 && cur.subs[active] && cur.subs[active]._trackIdx >= 0) {
      v.textTracks[cur.subs[active]._trackIdx].mode = 'showing';
    }
  }, 50);
}

// ---------- Chromecast ----------
// Usa o Google Cast SDK (carregado em index.html). Funciona em Chrome desktop
// + Android Chrome. iOS Safari nao suporta nativo.
// IMPORTANTE: requer HTTPS + URL publica do video. Como o servidor roda em
// gamingflix.space (HTTPS), basta resolver a baseUrl pra absoluta.
let castInitialized = false;
function setupChromecast() {
  const btn = document.getElementById('playerCastBtn');
  if (!btn) return;
  window.__onGCastApiAvailable = (isAvailable) => {
    if (!isAvailable) return;
    try {
      cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castInitialized = true;
      btn.style.display = '';
      console.log('[cast] SDK pronto');
    } catch (e) { console.warn('[cast] init err', e.message); }
  };
  // Se SDK ja carregou antes (re-bind), checa
  if (window.cast && window.cast.framework) window.__onGCastApiAvailable(true);

  btn.onclick = async () => {
    if (!castInitialized) { alert('Chromecast não disponível neste navegador.'); return; }
    try {
      const ctx = cast.framework.CastContext.getInstance();
      await ctx.requestSession();
      castCurrentMedia();
    } catch (e) {
      if (String(e).includes('cancel')) return;
      console.warn('[cast] requestSession', e);
      alert('Falha ao conectar ao Chromecast: ' + (e.code || e.message || e));
    }
  };
}

function castCurrentMedia() {
  const cur = player.current;
  if (!cur || !cur.baseUrl) return;
  const ctx = cast.framework.CastContext.getInstance();
  const session = ctx.getCurrentSession();
  if (!session) return;
  // Resolve URL relativa pra absoluta
  const absUrl = new URL(cur.baseUrl, window.location.href).href;
  const ext = (cur.filePath.match(/\.([^./\\]+)$/) || [, ''])[1].toLowerCase();
  const mime = ext === 'webm' ? 'video/webm' : 'video/mp4';
  const mediaInfo = new chrome.cast.media.MediaInfo(absUrl, mime);
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = (cur.item && cur.item.title) || 'MediaFlix';
  if (cur.episode) {
    mediaInfo.metadata.subtitle = `T${cur.episode.season} · E${cur.episode.episode}${cur.episode.title ? ' — ' + cur.episode.title : ''}`;
  }
  if (cur.item && cur.item.poster) {
    mediaInfo.metadata.images = [new chrome.cast.Image(cur.item.poster)];
  }
  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  request.currentTime = player.video.currentTime || 0;
  session.loadMedia(request).then(
    () => { player.video.pause(); console.log('[cast] tocando no TV'); },
    (err) => { console.warn('[cast] loadMedia err', err); alert('Não consegui carregar no Chromecast.'); }
  );
}

// ---------- Painel lateral de Episódios (estilo Netflix) ----------
function setupEpisodesPanel(item, currentEp) {
  const btn = document.getElementById('playerEpisodesBtn');
  const panel = document.getElementById('playerEps');
  const closeBtn = document.getElementById('playerEpsClose');
  const seasonSelect = document.getElementById('playerEpsSeason');
  const list = document.getElementById('playerEpsList');
  if (!btn || !panel) return;
  // Só faz sentido pra séries (que tem episódios em multiplas temporadas).
  const seasons = (item && item.seasons) || [];
  const hasMulti = seasons.length > 0 && seasons.some((s) => (s.episodes || []).length > 0);
  if (!hasMulti) { btn.style.display = 'none'; panel.classList.add('hidden'); return; }
  btn.style.display = '';

  let currentSeasonIdx = seasons.findIndex((s) => s.season === (currentEp && currentEp.season));
  if (currentSeasonIdx < 0) currentSeasonIdx = 0;

  seasonSelect.innerHTML = seasons.map((s, i) => {
    const num = s.season === 0 ? 'Especiais' : `Temporada ${s.season}`;
    return `<option value="${i}" ${i === currentSeasonIdx ? 'selected' : ''}>${num} · ${(s.episodes || []).length} eps</option>`;
  }).join('');

  function renderList(idx) {
    const season = seasons[idx]; if (!season) return;
    list.innerHTML = '';
    for (const ep of (season.episodes || [])) {
      const isMissing = !!ep.missing;
      const epNum = ep.episode || ep.index || 0;
      const isActive = !isMissing && currentEp && currentEp.path === ep.path;
      const p = !isMissing && state.progress ? state.progress[ep.path] : null;
      const ratio = (p && p.length) ? Math.min(1, p.time / p.length) : 0;
      const dur = (ep.runtime ? ep.runtime + ' min' : (p && p.length ? fmtTime(p.length) : ''));
      const div = document.createElement('div');
      div.className = 'player-eps-item' + (isActive ? ' active' : '') + (isMissing ? ' missing' : '');
      div.innerHTML = `
        <div class="player-eps-thumb"${episodeThumbFallbackStyle(item)}>
          ${episodeThumbImg(ep)}
          ${isMissing
            ? '<div class="play-overlay missing-overlay"><span>Indisponível</span></div>'
            : '<div class="play-overlay"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg></div>'}
          ${ratio > 0 ? `<div class="progress-bar"><div class="progress-fill" style="width:${(ratio*100).toFixed(1)}%"></div></div>` : ''}
        </div>
        <div class="player-eps-info">
          <div class="player-eps-head-row">
            <span class="player-eps-num">${epNum}.</span>
            <span class="player-eps-name">${escapeHtml(ep.title || 'Episódio ' + epNum)}</span>
            ${dur ? `<span class="player-eps-dur">${dur}</span>` : ''}
            ${isMissing ? '<span class="player-eps-missing-tag">Não baixado</span>' : ''}
          </div>
          ${ep.overview ? `<div class="player-eps-desc">${escapeHtml(ep.overview)}</div>` : ''}
        </div>`;
      div.addEventListener('click', () => {
        if (isMissing) {
          showToast('Episódio ainda não foi adicionado à biblioteca.', 3000);
          return;
        }
        panel.classList.add('hidden');
        closeEmbeddedPlayer();
        playFile(ep.path, item, ep);
      });
      list.appendChild(div);
    }
    hydrateEpisodeThumbs(list);
  }
  renderList(currentSeasonIdx);
  // Auto-scroll pro episodio atual
  setTimeout(() => {
    const active = list.querySelector('.player-eps-item.active');
    if (active) active.scrollIntoView({ block: 'center' });
  }, 100);

  seasonSelect.onchange = () => renderList(parseInt(seasonSelect.value, 10));
  btn.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('hidden'); };
  closeBtn.onclick = (e) => { e.stopPropagation(); panel.classList.add('hidden'); };
}

async function updatePlayerSeriesHud(item, episode) {
  const hud = document.getElementById('playerSeriesHud');
  if (!hud) return;
  if (!item || !episode) { hud.classList.add('hidden'); return; }
  hud.classList.remove('hidden');
  document.getElementById('playerSeriesName').textContent = episode.title || item.title || 'Episódio';
  document.getElementById('playerSeriesKicker').textContent = item.title || 'SÉRIE';
  const parts = [];
  if (episode.season != null) parts.push(`Temporada ${episode.season}`);
  if (episode.episode != null) parts.push(`Episódio ${episode.episode}`);
  if (episode.airDate) parts.push(String(episode.airDate).slice(0, 4));
  if (typeof episode.imdbRating === 'number') parts.push(`★ ${episode.imdbRating.toFixed(1)}`);
  document.getElementById('playerSeriesMeta').textContent = parts.join(' · ');

  const poster = document.getElementById('playerSeriesPoster');
  if (poster) {
    poster.style.backgroundImage = '';
    let bg = null;
    if (episode.stillPath) bg = `https://image.tmdb.org/t/p/w500${episode.stillPath}`;
    else if (item.poster || item.banner) bg = await loadImage(item.poster || item.banner).catch(() => null);
    if (bg) poster.style.backgroundImage = `url('${bg}')`;
  }
}

async function openEmbeddedPlayer({ url, filePath, item, episode, autoNext, autoNextSeconds }) {
  ensurePlayerInit();
  // Token de cancelamento: se o usuario fechar o player antes desse async
  // terminar de montar tudo, abortamos pra nao chamar loadStream depois e
  // fazer o video tocar "por tras" (com rotacao de tela e tudo).
  const mySeq = ++player.openSeq;
  const cancelled = () => mySeq !== player.openSeq;
  // Reset total do <video>: HTML5 nao remove textTracks da colecao mesmo
  // depois de remover <track>. Clonar o elemento descarta tudo (legendas
  // anteriores nao "vazam" pro proximo episodio/serie).
  resetVideoElement();
  setPlayerLocked(false);
  // Probe pra duracao real + lista de faixas de audio + idioma preferido
  const [probe, cfg] = await Promise.all([
    window.api.probe(filePath).catch(() => ({ duration: 0, audio: [], preferred: 0 })),
    window.api.getConfig().catch(() => ({})),
  ]);
  if (cancelled()) return;
  // Arquivos "nativos" (mp4/webm/m4v/mov) sao servidos via range pelo
  // servidor — `&ss=` na URL eh ignorado. Pra esses, fazemos seek client-side
  // via v.currentTime e NAO usamos virtualOffset (senao a contagem de tempo,
  // chapters e auto-next ficam dessincronizados com o video real).
  const ext = (filePath.match(/\.([^./\\]+)$/) || [, ''])[1].toLowerCase();
  const isNative = ['mp4', 'webm', 'm4v', 'mov'].includes(ext);
  player.current = {
    filePath, item, episode, autoNext, autoNextSeconds, baseUrl: url,
    audioIdx: probe.preferred || 0,
    audioTracks: probe.audio || [],
    duration: probe.duration || 0,
    virtualOffset: 0,
    activeSubIdx: -1,
    chapters: probe.chapters || [],
    skipDismissed: {},
    isNative,
    preferredAudioLang: probe.preferredAudioLang || 'pt',
    preferredSubLang: probe.preferredSubLang || 'off',
    skipIntroEnabled: probe.skipIntro !== false,
    autoSkipIntroEnabled: probe.autoSkipIntro !== false,
    autoSkipIntroSeconds: Number.isFinite(probe.autoSkipIntroSeconds) ? probe.autoSkipIntroSeconds : 5,
    doubleTapSeconds: cfg.doubleTapSeconds || 5,
  };
  console.log('[player] chapters:', probe.chapters, 'isNative:', isNative, 'prefAudio:', probe.preferredAudioLang, 'prefSub:', probe.preferredSubLang);
  cancelAutoNext();
  cancelSkip();
  player.el.classList.remove('hidden', 'hide-chrome');
  player.el.classList.toggle('is-series', !!episode);
  setupEpisodesPanel(item, episode);
  updatePlayerSeriesHud(item, episode);

  // Title
  document.getElementById('playerTitle').textContent = item ? item.title : '';
  document.getElementById('playerSubtitle').textContent = episode
    ? `T${String(episode.season).padStart(2,'0')} · E${String(episode.episode).padStart(2,'0')}${episode.title ? ' — ' + episode.title : ''}`
    : '';

  buildAudioMenu(probe.audio || [], player.current.audioIdx);

  // Coleta legendas: sidecars do diretorio + embutidas no MKV (extraidas sob demanda)
  let subs = [];
  try {
    const r = await window.api.getSidecars(filePath);
    if (cancelled()) return;
    if (r && r.ok) subs = (r.subs || []).map((s) => ({ ...s, kind: 'sidecar' }));
  } catch {}
  if (cancelled()) return;
  for (const es of (probe.subs || [])) {
    subs.push({
      kind: 'embed',
      index: es.index,
      lang: es.lang,
      label: (langCodeLabel(es.lang) || es.title || `Faixa ${es.index + 1}`) + ' (embutida)',
      codec: es.codec,
    });
  }
  player.current.subs = subs;
  buildSubsMenu(subs);

  // Auto-seleciona legenda no idioma preferido do usuario (config)
  const prefSub = (player.current.preferredSubLang || 'off').toLowerCase();
  if (prefSub !== 'off' && subs.length) {
    const LANG_RE = {
      pt: /^(pt|por|ptg|pob|prt)/i,
      en: /^(en|eng)/i,
      es: /^(es|spa|esp)/i,
      ja: /^(ja|jpn)/i,
      fr: /^(fr|fra|fre)/i,
      it: /^(it|ita)/i,
      de: /^(de|deu|ger)/i,
      ko: /^(ko|kor)/i,
      zh: /^(zh|zho|chi|cmn)/i,
      ru: /^(ru|rus)/i,
    };
    const re = LANG_RE[prefSub];
    if (re) {
      const idx = subs.findIndex((s) => re.test(s.lang || '') || re.test(s.label || ''));
      if (idx >= 0) {
        try { await selectSub(idx); } catch (e) { console.warn('auto-select sub falhou:', e); }
        if (cancelled()) return;
      }
    }
  }

  // Resume seek
  const savedProg = state.progress[filePath];
  let startSec = 0;
  if (savedProg && savedProg.length && savedProg.time) {
    const remain = savedProg.length - savedProg.time;
    // Não jogar o usuário para o começo só porque ele parou nos créditos ou
    // perto do fim. Só tratamos como finalizado de verdade nos últimos 10s.
    if (remain > 10) startSec = Math.max(0, savedProg.time - 3);
  }
  if (cancelled()) return;
  await loadStream(startSec);
}

// Carrega/recarrega o <video>. Para arquivos nativos (mp4/webm/m4v/mov), o
// seek eh feito client-side via v.currentTime (range request) — `?ss=` na URL
// nao funciona com range streaming. Para MKV/AVI/etc., usa transcoding com
// seek server-side via `?ss=` + virtualOffset pra manter currentTime coerente.
async function loadStream(seekSec) {
  const cur = player.current;
  if (!cur) return;
  const v = player.video;
  // Token de cancelamento: se closeEmbeddedPlayer rodar enquanto a gente ta
  // no await abaixo, abortamos antes de re-anexar src+load (senao o video
  // recomeca a tocar depois do close, com rotacao de tela e tudo).
  const mySeq = player.openSeq;
  const cancelled = () => mySeq !== player.openSeq || player.current !== cur;
  await queueProgressSave({ force: true, reason: 'before-loadStream' });
  if (cancelled()) return;
  v.pause();
  while (v.firstChild) v.removeChild(v.firstChild);
  v.removeAttribute('src');

  const want = Math.max(0, Number(seekSec) || 0);
  cur._resumeTarget = want;
  cur._suspendProgressSave = true;

  let url;
  if (cur.isNative) {
    // Native: nao seekamos server-side. virtualOffset fica 0; v.currentTime
    // refletira o tempo real do arquivo.
    cur.virtualOffset = 0;
    url = cur.baseUrl + `&a=${cur.audioIdx}`;
  } else {
    cur.virtualOffset = want;
    url = cur.baseUrl + (want ? `&ss=${want}` : '') + `&a=${cur.audioIdx}`;
  }

  const src = document.createElement('source');
  src.src = url;
  src.type = 'video/mp4';
  v.appendChild(src);

  // Reconstroi <track>s com cues deslocadas pelo virtualOffset. Mantem a sub
  // ativa selecionada (se houver) — caso contrario fica desligada por padrao.
  applySubTracks();

  // Track de capitulos: aparece no fullscreen nativo do iOS (Safari) e
  // tambem alimenta features futuras do player custom.
  applyChaptersTrack();

  if (cancelled()) { v.removeAttribute('src'); v.load(); return; }
  v.load();
  v.addEventListener('loadedmetadata', () => {
    // Reverifica no callback async — close pode ter rodado entre o load() e o evento.
    if (cancelled()) { v.pause(); v.removeAttribute('src'); v.load(); return; }
    if (cur.isNative && want > 0) {
      try { v.currentTime = want; } catch {}
    }
    const enableSave = () => {
      cur._suspendProgressSave = false;
      setTimeout(() => { cur._resumeTarget = 0; }, 2500);
      queueProgressSave({ force: true, reason: 'loadedmetadata' });
    };
    if (cur.isNative && want > 0) {
      const onSeeked = () => enableSave();
      v.addEventListener('seeked', onSeeked, { once: true });
      setTimeout(() => { if (cur._suspendProgressSave) enableSave(); }, 1800);
    } else {
      enableSave();
    }
    if (cancelled()) return;
    v.play().catch(()=>{});
  }, { once: true });
}

function applyChaptersTrack() {
  const cur = player.current;
  const v = player.video;
  if (!cur || !v || !cur.chapters || !cur.chapters.length) return;
  const vtt = buildChaptersVTT(cur.chapters);
  if (!vtt) return;
  const blob = new Blob([vtt], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);
  const t = document.createElement('track');
  t.kind = 'chapters';
  t.label = 'Capítulos';
  t.srclang = 'pt';
  t.default = true;
  t.src = url;
  v.appendChild(t);
}

function fmtVttTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(3).padStart(6, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${ss}`;
}

function humanChapterTitle(chap, idx, allChaps, totalDuration) {
  const t = (chap.title || '').trim();
  // Se o titulo ja eh semantico, usa
  if (t && !/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(t)) return t;
  // Heuristica: nomeia conforme posicao/duracao
  const dur = chap.end - chap.start;
  if (chap.start < 360 && dur > 0 && dur <= 240 && idx === 0) return 'Abertura / Recap';
  if (totalDuration && chap.start > totalDuration * 0.92 && dur <= 120) return 'Créditos';
  return `Capítulo ${idx + 1}`;
}

function buildChaptersVTT(chapters) {
  if (!chapters || !chapters.length) return '';
  const cur = player.current;
  const total = (cur && cur.duration) || chapters[chapters.length - 1].end || 0;
  const lines = ['WEBVTT', ''];
  chapters.forEach((c, i) => {
    const start = fmtVttTime(c.start);
    const end = fmtVttTime(c.end || (chapters[i + 1] ? chapters[i + 1].start : total));
    const title = humanChapterTitle(c, i, chapters, total);
    lines.push(String(i + 1));
    lines.push(`${start} --> ${end}`);
    lines.push(title);
    lines.push('');
  });
  return lines.join('\n');
}

function buildAudioMenu(tracks, currentIdx) {
  let menu = document.getElementById('playerAudioMenu');
  let btn = document.getElementById('playerAudioBtn');
  if (!btn) return; // criado via HTML em update futura
  menu.innerHTML = '';
  if (!tracks.length) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  tracks.forEach((tr, i) => {
    const it = document.createElement('div');
    it.className = 'player-subs-item' + (i === currentIdx ? ' active' : '');
    const langLabel = (tr.lang || '').toUpperCase() || '?';
    it.textContent = `${langLabel}${tr.title ? ' — ' + tr.title : ''} (${tr.codec})`;
    it.onclick = async () => {
      const cur = player.current;
      if (!cur || cur.audioIdx === i) return;
      cur.audioIdx = i;
      const cT = player.video.currentTime + (cur.virtualOffset || 0);
      await loadStream(cT);
      buildAudioMenu(tracks, i);
      menu.classList.add('hidden');
      showToast(`Áudio: ${langLabel}`, 2000);
    };
    menu.appendChild(it);
  });
}

function closeEmbeddedPlayer() {
  // Invalida qualquer openEmbeddedPlayer ainda em andamento (probe/sidecars/etc).
  // Sem isso, fechar rapido depois de clicar num episodio fazia a corrotina
  // de open continuar, tirar o 'hidden' do player e chamar loadStream → o
  // video tocava "por tras" no menu e ate girava a tela (tryAutoLandscape).
  player.openSeq++;
  cancelAutoNext();
  hideSkipBtn();
  if (!player.el) return;
  const v = player.video;
  const closingItem = player.current ? player.current.item : null;
  let savePromise = null;
  if (player.current) {
    savePromise = queueProgressSave({ force: true, reason: 'close' });
    window.api.logClose(player.current.filePath);
  }
  v.pause();
  v.removeAttribute('src');
  v.load();
  player.el.classList.add('hidden');
  const epsPanel = document.getElementById('playerEps');
  if (epsPanel) epsPanel.classList.add('hidden');
  player.current = null;
  player.lastSavedAt = 0;
  player.intendedLandscape = false;
  clearTimeout(player.orientationRetryTimer);
  player.el.classList.remove('force-landscape');
  player.autoFsTriggered = false;
  // Libera orientation lock + sai do fullscreen
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch {}
  if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});
  // Refresh listas: aguarda o saveProgress terminar antes de reler do disco,
  // senao o estado em memoria fica defasado e a barra de "continuar" some.
  (async () => {
    if (savePromise) { try { await savePromise; } catch {} }
    state.progress = await window.api.getProgress();
    state.history = await window.api.getHistory();
    await renderRows();
    await renderHero();
    // Se a tela de detalhe estiver aberta no mesmo titulo, re-renderiza
    // pra atualizar a barrinha por episodio.
    if (closingItem && state.currentDetail && state.currentDetail.path === closingItem.path) {
      openDetail(state.currentDetail);
    }
  })();
}

function findNextEpisode(item, currentEp) {
  if (!item || item.type !== 'series' || !currentEp) return null;
  const playable = (item.episodes || []).filter((e) => !e.missing && e.path);
  const idx = playable.findIndex((e) => e.path === currentEp.path);
  if (idx < 0 || idx >= playable.length - 1) return null;
  return playable[idx + 1];
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
      advanceToNext(cur, nextEp);
    }
  }, 1000);

  document.getElementById('playerNextPlayBtn').onclick = () => {
    cancelAutoNext();
    advanceToNext(cur, nextEp);
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

// Avança para o próximo episódio e, se a opção "apagar assistidos" estiver
// ligada, pede ao servidor para apagar o episódio anterior. A decisão de
// apagar é 100% do servidor a partir do banco (watch_progress); aqui só
// garantimos que o progresso final foi gravado como assistido antes de pedir.
async function advanceToNext(cur, nextEp) {
  const prevPath = cur && cur.filePath;
  const prevLen = (cur && cur.duration) || 0;
  await playFile(nextEp.path, cur.item, nextEp);
  if (!prevPath || !window.api.autoDeleteWatched) return;
  try {
    if (prevLen > 0) await window.api.saveProgress(prevPath, prevLen, prevLen);
    const r = await window.api.autoDeleteWatched(prevPath);
    if (r && r.deleted) {
      if (r.library) state.library = r.library;
      state.progress = await window.api.getProgress();
      state.history = await window.api.getHistory();
      await renderRows();
      await renderHero();
      showToast(`Episódio assistido apagado · ${formatBytes(r.deletedBytes || 0)} liberados`);
    }
  } catch (e) {
    // Silencioso de propósito: falha ao apagar nunca pode atrapalhar a reprodução.
  }
}

// ---------- Skip intro/recap (por capitulos do MKV) ----------
const SKIP_PATTERNS = [
  { re: /\b(intro|opening|abertura|op|openning|theme)\b/i, label: 'Pular abertura' },
  { re: /\b(recap|previously|anteriormente|resumo|antes)\b/i, label: 'Pular resumo' },
  { re: /\b(credits|cr[ée]ditos|ending|encerramento|outro)\b/i, label: 'Pular cr\u00e9ditos' },
];

// Decide se o capitulo merece botao de pular. Aceita por nome OU por
// heuristica (primeiros capitulos curtos no inicio do episodio sao
// tipicamente recap/abertura, mesmo quando o titulo eh apenas um timestamp).
function chapterSkipLabel(chap, allChaps, totalDuration) {
  // Match explicito por nome → ALTA confianca (auto-skip permitido)
  for (const p of SKIP_PATTERNS) if (chap.title && p.re.test(chap.title)) return { label: p.label, confident: true };
  if (!allChaps || allChaps.length < 3) return null;
  const dur = chap.end - chap.start;
  if (!(dur > 0)) return null;
  const idx = allChaps.indexOf(chap);
  if (idx < 0) return null;
  const total = (totalDuration && Number.isFinite(totalDuration) && totalDuration > 0) ? totalDuration : 0;
  // Heuristica: abertura nao nomeada — confianca BAIXA (so botao manual)
  if (idx <= 1 && chap.start < 360 && dur <= 240) {
    if (!total || chap.start < total * 0.4) return { label: 'Pular abertura', confident: false };
  }
  // Creditos: NUNCA auto-skip (usuario pode querer assistir cena pos-creditos)
  if (total && idx >= allChaps.length - 2 && chap.start > total * 0.92 && dur <= 120) {
    return { label: 'Pular cr\u00e9ditos', confident: false };
  }
  return null;
}

function detectSkippableChapter(absSec) {
  const cur = player.current;
  if (!cur || !cur.chapters || !cur.chapters.length) return;
  if (cur.skipIntroEnabled === false) { hideSkipBtn(); return; }
  const chap = cur.chapters.find((c) => absSec >= c.start && absSec < c.end);
  if (!chap) { hideSkipBtn(); return; }
  const info = chapterSkipLabel(chap, cur.chapters, cur.duration);
  if (!info) { hideSkipBtn(); return; }
  if (cur.skipDismissed[chap.start] === 'dismissed') { hideSkipBtn(); return; }
  showSkipBtn(info.label, chap, info.confident);
}

function showSkipBtn(label, chap, confident) {
  const btn = document.getElementById('playerSkipBtn');
  if (!btn) return;
  if (btn.dataset.chapStart === String(chap.start) && !btn.classList.contains('hidden')) return;
  btn.dataset.chapStart = String(chap.start);
  btn.classList.remove('hidden');
  document.getElementById('playerSkipLabel').textContent = label;
  const cdEl = document.getElementById('playerSkipCountdown');
  if (cdEl) cdEl.textContent = '';
  if (player.skipTimer) { clearInterval(player.skipTimer); player.skipTimer = null; }

  const cur = player.current;
  // Auto-skip pra qualquer abertura/recap detectada (nome OU heuristica posicional).
  // Creditos NUNCA auto-skip — usuario pode querer ver cena pos-creditos.
  const canAuto = cur
    && cur.autoSkipIntroEnabled !== false
    && !/cr[ée]ditos/i.test(label)
    && cur.skipDismissed[chap.start] !== 'started';

  if (canAuto && cdEl) {
    let n = Math.max(2, Math.min(20, Number(cur.autoSkipIntroSeconds) || 3));
    cdEl.textContent = `(${n}s)`;
    cur.skipDismissed[chap.start] = 'started';
    player.skipTimer = setInterval(() => {
      n -= 1;
      cdEl.textContent = `(${n}s)`;
      if (n <= 0) {
        clearInterval(player.skipTimer);
        player.skipTimer = null;
        cdEl.textContent = '';
        doSkip(chap);
      }
    }, 1000);
  }

  btn.onclick = () => doSkip(chap);
}

function doSkip(chap) {
  cancelSkip();
  const cur = player.current;
  if (!cur) return;
  cur.skipDismissed[chap.start] = 'dismissed';
  // Native: seek instantaneo via v.currentTime (evita reload do stream).
  if (cur.isNative && player.video) {
    try { player.video.currentTime = chap.end; player.video.play().catch(()=>{}); return; } catch {}
  }
  // Pula pro fim do capitulo (com seek server-side)
  loadStream(chap.end);
}

function hideSkipBtn() {
  const btn = document.getElementById('playerSkipBtn');
  if (btn && !btn.classList.contains('hidden')) {
    btn.classList.add('hidden');
    btn.dataset.chapStart = '';
  }
  if (player.skipTimer) { clearInterval(player.skipTimer); player.skipTimer = null; }
}

function cancelSkip() {
  hideSkipBtn();
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
  wireToggle('autoDeleteWatchedToggle', 'autoDeleteWatched');
  wireToggle('autoRescanToggle', 'autoRescan');
  wireToggle('skipIntroToggle', 'skipIntro');
  wireToggle('autoSkipIntroToggle', 'autoSkipIntro');
  // Numero: segundos pra auto-skip
  const autoSkipSecsEl = $('#autoSkipIntroSeconds');
  if (autoSkipSecsEl) {
    autoSkipSecsEl.value = Number.isFinite(cfg.autoSkipIntroSeconds) ? cfg.autoSkipIntroSeconds : 5;
    autoSkipSecsEl.onchange = async () => {
      const v = Math.max(2, Math.min(20, Number(autoSkipSecsEl.value) || 5));
      autoSkipSecsEl.value = v;
      await window.api.setNumber('autoSkipIntroSeconds', v);
      showToast(`Auto-skip definido pra ${v}s`);
    };
  }

  // Selects de idioma padrao (audio + legenda)
  const wireLangSelect = (id, key, fallback) => {
    const el = $('#' + id);
    if (!el) return;
    el.value = cfg[key] || fallback;
    el.onchange = async () => {
      await window.api.setString(key, el.value);
      const label = el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value;
      showToast(`Idioma salvo: ${label}`);
    };
  };
  wireLangSelect('preferredAudioLangSelect', 'preferredAudioLang', 'pt');
  wireLangSelect('preferredSubLangSelect', 'preferredSubLang', 'off');

  const secInput = $('#autoNextSecondsInput');
  if (secInput) {
    secInput.value = cfg.autoNextSeconds || 8;
    secInput.onchange = async () => {
      await window.api.setNumber('autoNextSeconds', secInput.value);
    };
  }
  const doubleTapInput = $('#doubleTapSecondsInput');
  if (doubleTapInput) {
    doubleTapInput.value = cfg.doubleTapSeconds || 5;
    doubleTapInput.onchange = async () => {
      await window.api.setNumber('doubleTapSeconds', doubleTapInput.value);
      showToast(`Duplo toque: ${doubleTapInput.value}s`);
    };
  }
}

// ---------- Routing ----------
function route(name) {
  document.body.classList.toggle('route-home', name === 'home');
  document.body.classList.toggle('route-settings', name === 'settings');
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



function openConfirmModal({ title = 'Confirmar ação', message = '', confirmText = 'Confirmar', cancelText = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    let modal = document.getElementById('confirmModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'confirmModal';
      modal.className = 'confirm-modal hidden';
      modal.innerHTML = `
        <div class="confirm-backdrop" data-confirm-cancel></div>
        <section class="confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
          <div class="confirm-icon" id="confirmIcon">!</div>
          <div class="confirm-copy">
            <h2 id="confirmTitle"></h2>
            <p id="confirmMessage"></p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel" data-confirm-cancel></button>
            <button type="button" class="confirm-submit" id="confirmSubmit"></button>
          </div>
        </section>
      `;
      document.body.appendChild(modal);
    }

    const titleEl = modal.querySelector('#confirmTitle');
    const msgEl = modal.querySelector('#confirmMessage');
    const submit = modal.querySelector('#confirmSubmit');
    const cancel = modal.querySelector('.confirm-cancel');
    titleEl.textContent = title;
    msgEl.textContent = message;
    submit.textContent = confirmText;
    cancel.textContent = cancelText;
    modal.classList.toggle('is-danger', !!danger);
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    let done = false;
    const cleanup = (value) => {
      if (done) return;
      done = true;
      modal.classList.add('hidden');
      document.body.classList.remove('modal-open');
      modal.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onClick = (e) => {
      if (e.target.closest('[data-confirm-cancel]')) cleanup(false);
      if (e.target.closest('#confirmSubmit')) cleanup(true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter') cleanup(true);
    };
    modal.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    setTimeout(() => submit.focus(), 30);
  });
}

// ---------- Profiles (web / Netflix-style gate) ----------
let profileSelectionResolve = null;
function ensureProfilesUi() {
  if (document.getElementById('profileGate')) return;
  const gate = document.createElement('section');
  gate.id = 'profileGate';
  gate.className = 'profile-gate hidden';
  gate.innerHTML = `
    <div class="profile-shell">
      <p class="profile-kicker">MEDIAFLIX</p>
      <h1>Quem está assistindo?</h1>
      <div class="profile-grid" id="profileGrid"></div>
      <form class="profile-create" id="profileCreateForm">
        <input id="profileNameInput" type="text" maxlength="32" placeholder="Novo perfil" autocomplete="off" />
        <button type="submit">Adicionar</button>
      </form>
    </div>
  `;
  document.body.appendChild(gate);

  const switcher = document.createElement('button');
  switcher.id = 'profileSwitcher';
  switcher.className = 'profile-switcher hidden';
  switcher.type = 'button';
  switcher.title = 'Trocar perfil';
  const actions = document.querySelector('.topbar-actions');
  if (actions) actions.prepend(switcher);
  switcher.addEventListener('click', () => openProfileGate(false));

  document.getElementById('profileCreateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('profileNameInput');
    const name = input.value.trim();
    if (!name || !window.api.createProfile) return;
    const res = await window.api.createProfile(name);
    if (res && res.ok && res.profile) {
      input.value = '';
      state.profiles.push(res.profile);
      renderProfileGrid();
      showToast('Perfil criado');
    }
  });
}

function renderProfileGrid() {
  const grid = document.getElementById('profileGrid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const profile of state.profiles) {
    const card = document.createElement('div');
    card.className = 'profile-card-wrap';
    const btn = document.createElement('button');
    btn.className = 'profile-card';
    btn.type = 'button';
    btn.innerHTML = `
      <span class="profile-avatar" style="--profile-color:${profile.color || '#e11d48'}">${escapeHtml(profile.avatar || (profile.name || 'P').slice(0,1).toUpperCase())}</span>
      <span class="profile-name">${escapeHtml(profile.name || 'Perfil')}</span>
    `;
    btn.addEventListener('click', () => selectProfile(profile));
    card.appendChild(btn);
    if (window.api.deleteProfile && state.profiles.length > 1) {
      const del = document.createElement('button');
      del.className = 'profile-delete';
      del.type = 'button';
      del.title = `Apagar perfil ${profile.name || 'Perfil'}`;
      del.setAttribute('aria-label', del.title);
      del.innerHTML = '×';
      del.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const name = profile.name || 'Perfil';
        const confirmed = await openConfirmModal({
          title: `Apagar perfil ${name}?`,
          message: 'Isso remove também o progresso salvo e o histórico desse perfil. Essa ação não afeta os outros perfis.',
          confirmText: 'Apagar perfil',
          cancelText: 'Cancelar',
          danger: true,
        });
        if (!confirmed) return;
        try {
          const res = await window.api.deleteProfile(profile.id);
          if (!res || !res.ok) throw new Error((res && res.error) || 'Falha ao apagar perfil');
          state.profiles = state.profiles.filter((p) => p.id !== profile.id);
          if (state.currentProfile && state.currentProfile.id === profile.id) {
            localStorage.removeItem('mediaflix:profileId');
            state.currentProfile = null;
            document.getElementById('profileSwitcher')?.classList.add('hidden');
          }
          renderProfileGrid();
          showToast('Perfil apagado');
          if (!state.currentProfile) openProfileGate(true);
        } catch (err) {
          showToast(err.message || 'Não consegui apagar o perfil', 5000);
        }
      });
      card.appendChild(del);
    }
    grid.appendChild(card);
  }
}

function updateProfileSwitcher() {
  const btn = document.getElementById('profileSwitcher');
  if (!btn || !state.currentProfile) return;
  btn.classList.remove('hidden');
  btn.innerHTML = `<span style="--profile-color:${state.currentProfile.color || '#e11d48'}">${escapeHtml(state.currentProfile.avatar || 'P')}</span><b>${escapeHtml(state.currentProfile.name || 'Perfil')}</b>`;
}

async function selectProfile(profile) {
  if (!profile || !window.api.setCurrentProfile) return;
  state.currentProfile = profile;
  await window.api.setCurrentProfile(profile.id);
  document.getElementById('profileGate')?.classList.add('hidden');
  document.body.classList.remove('profile-locked');
  updateProfileSwitcher();
  state.progress = await window.api.getProgress();
  state.history = await window.api.getHistory();
  if (profileSelectionResolve) { profileSelectionResolve(profile); profileSelectionResolve = null; }
  if (state.library && state.library.length) await renderAll();
}

function openProfileGate(required = false) {
  ensureProfilesUi();
  renderProfileGrid();
  document.getElementById('profileGate').classList.remove('hidden');
  if (required) document.body.classList.add('profile-locked');
  setTimeout(() => document.getElementById('profileNameInput')?.focus(), 80);
}

async function ensureProfileSelected() {
  if (!window.api.getProfiles) return;
  ensureProfilesUi();
  const res = await window.api.getProfiles();
  state.profiles = (res && res.profiles) || [];
  const saved = window.api.getCurrentProfileId ? window.api.getCurrentProfileId() : localStorage.getItem('mediaflix:profileId');
  const current = state.profiles.find((p) => p.id === saved);
  if (current) {
    state.currentProfile = current;
    await window.api.setCurrentProfile(current.id);
    updateProfileSwitcher();
    return;
  }
  openProfileGate(true);
  await new Promise((resolve) => { profileSelectionResolve = resolve; });
}



async function ensureUploadToken() {
  let token = localStorage.getItem('mediaflix:uploadToken') || '';
  if (token) return token;
  token = prompt('Token de upload do MediaFlix:') || '';
  token = token.trim();
  if (token) localStorage.setItem('mediaflix:uploadToken', token);
  return token;
}

async function uploadSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!window.api.uploadFiles) { showToast('Upload web indisponível nesta versão'); return; }
  const token = await ensureUploadToken();
  if (!token) return;
  const progress = document.getElementById('uploadProgress');
  const status = document.getElementById('uploadStatus');
  const bar = progress && progress.querySelector('span');
  const totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const firstName = files[0] && (files[0].webkitRelativePath || files[0].name);
  const setUploadStatus = (pct, meta = {}) => {
    if (!status) return;
    const sizeMb = totalSize ? ` · ${(totalSize / 1024 / 1024).toFixed(1)} MB` : '';
    const label = pct == null ? 'Enviando…' : `${pct}% enviado`;
    const phase = meta.fileName ? ` · ${meta.fileName}` : (meta.phase === 'processing' ? ' · processando no servidor' : '');
    status.textContent = `${label}${phase} · ${files.length} arquivo(s)${sizeMb}${firstName ? ' · ' + firstName : ''}`;
  };
  progress?.classList.remove('hidden');
  status?.classList.remove('hidden');
  if (bar) bar.style.width = '0%';
  setUploadStatus(0);
  showToast(`Enviando ${files.length} arquivo(s)… 0%`, 4000);
  try {
    const res = await window.api.uploadFiles(files, token, (pct, meta) => {
      if (pct != null && bar) bar.style.width = pct + '%';
      setUploadStatus(pct, meta);
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Upload falhou');
    state.library = res.library || await window.api.rescan();
    state.imageCache.clear();
    await renderAll();
    route('home');
    if (bar) bar.style.width = '100%';
    setUploadStatus(100);
    showToast(`Upload concluído: ${res.count || files.length} arquivo(s) · 100%`);
  } catch (e) {
    if (/token/i.test(String(e.message))) localStorage.removeItem('mediaflix:uploadToken');
    showToast(e.message || 'Upload falhou', 5000);
  } finally {
    setTimeout(() => { progress?.classList.add('hidden'); status?.classList.add('hidden'); }, 1800);
  }
}

// ---------- Monitor flutuante de uploads (visível em qualquer dispositivo) ----------
// O progresso é lido do servidor (/api/uploads/active), então um upload começado
// no PC aparece também no celular, e vice-versa.
function ensureUploadMonitor() {
  let el = document.getElementById('uploadMonitor');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'uploadMonitor';
  el.style.cssText = 'position:fixed;z-index:9000;right:16px;bottom:16px;max-width:min(86vw,340px);background:rgba(20,20,22,.96);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px 14px;box-shadow:0 12px 34px rgba(0,0,0,.55);font-size:13px;cursor:pointer;backdrop-filter:blur(8px);display:none';
  el.innerHTML = ''
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
    + '<span style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;color:#f59e0b">\u2b06</span>'
    + '<strong id="umTitle" style="font-weight:700;font-size:13px">Enviando\u2026</strong>'
    + '<span id="umPct" style="margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums"></span>'
    + '</div>'
    + '<div style="height:6px;border-radius:99px;background:rgba(255,255,255,.14);overflow:hidden">'
    + '<div id="umBar" style="height:100%;width:0%;background:linear-gradient(90deg,#e11d48,#f59e0b);transition:width .3s"></div>'
    + '</div>'
    + '<div id="umMeta" style="margin-top:7px;color:rgba(255,255,255,.72);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>';
  el.title = 'Toque para abrir a área de uploads';
  el.addEventListener('click', () => route('settings'));
  document.body.appendChild(el);
  return el;
}

function renderUploadMonitor(uploads) {
  const el = ensureUploadMonitor();
  const active = Array.isArray(uploads) ? uploads : [];
  if (!active.length) { el.style.display = 'none'; return; }
  const totalBytes = active.reduce((s, u) => s + (u.totalBytes || 0), 0);
  const recvBytes = active.reduce((s, u) => s + (u.receivedBytes || 0), 0);
  const totalFiles = active.reduce((s, u) => s + (u.totalFiles || 0), 0);
  const filesDone = active.reduce((s, u) => s + (u.filesDone || 0), 0);
  const allCompleted = active.every((u) => u.completed);
  let pct = totalBytes > 0 ? Math.round((recvBytes / totalBytes) * 100) : null;
  if (allCompleted) pct = 100;
  if (pct != null) pct = Math.max(0, Math.min(100, pct));
  const cur = active.find((u) => !u.completed && u.current) || active[0] || {};
  document.getElementById('umTitle').textContent = allCompleted ? 'Upload conclu\u00eddo \u2713' : 'Enviando para o servidor';
  document.getElementById('umPct').textContent = pct == null ? '' : pct + '%';
  document.getElementById('umBar').style.width = (pct == null ? 0 : pct) + '%';
  const parts = [];
  if (totalFiles) parts.push(`${filesDone}/${totalFiles} arquivo(s)`);
  if (cur.current && !allCompleted) parts.push(cur.current);
  if (totalBytes) parts.push(`${formatBytes(recvBytes)} / ${formatBytes(totalBytes)}`);
  document.getElementById('umMeta').textContent = parts.join(' \u00b7 ');
  el.style.display = 'block';
}

async function pollActiveUploads() {
  if (!window.api.getActiveUploads) return;
  try {
    const r = await window.api.getActiveUploads();
    const uploads = (r && r.uploads) || [];
    renderUploadMonitor(uploads);
    // Quando um upload conclui, a biblioteca muda — refresca uma vez de leve.
    if (uploads.some((u) => u.completed) && !state._uploadRefreshed) {
      state._uploadRefreshed = true;
      state.library = await window.api.getLibrary();
      state.imageCache && state.imageCache.clear && state.imageCache.clear();
      await renderRows();
      setTimeout(() => { state._uploadRefreshed = false; }, 10000);
    }
  } catch (e) { /* silencioso */ }
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
  await ensureProfileSelected();

  // Topbar scroll state
  document.addEventListener('scroll', () => {
    $('.topbar').classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  // Auto-update da biblioteca: o main vigia as pastas (autoRescan) e tambem
  // dispara um rescan quando a janela ganha foco. Aqui so aplicamos.
  if (window.api.onLibraryUpdated) {
    window.api.onLibraryUpdated(async ({ library }) => {
      const before = state.library ? state.library.length : 0;
      state.library = library || [];
      // So mostra toast se realmente apareceu coisa nova
      if (library && library.length > before) {
        showToast(`Biblioteca atualizada: ${library.length - before} novo(s) item(ns)`, 3500);
      }
      await renderAll();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgressBeacon('visibility-hidden');
    else {
      queueProgressSave({ force: true, reason: 'visibility-visible' });
      scheduleLandscapeRepair('visibility-visible');
    }
  });
  window.addEventListener('pagehide', () => saveProgressBeacon('pagehide'));
  window.addEventListener('beforeunload', () => saveProgressBeacon('beforeunload'));
  document.addEventListener('fullscreenchange', () => { scheduleLandscapeRepair('fullscreenchange'); updateFsIcon(); });
  document.addEventListener('webkitfullscreenchange', () => { scheduleLandscapeRepair('webkitfullscreenchange'); updateFsIcon(); });
  window.addEventListener('orientationchange', () => setTimeout(() => scheduleLandscapeRepair('orientationchange'), 180));
  window.addEventListener('resize', () => syncPlayerViewportState(), { passive: true });

  // Nav
  $$('.nav-link').forEach((b) => b.addEventListener('click', () => route(b.dataset.route)));
  $('#mobileLibraryBtn')?.addEventListener('click', () => {
    route('home');
    document.getElementById('seriesRow')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#mobileSearchBtn')?.addEventListener('click', () => {
    route('home');
    const input = $('#topbarSearchInput');
    input?.focus();
    input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Add folder/upload. In the public web version, this opens the native
  // file picker instead of asking for a server path.
  const addFolder = async () => {
    const cfg = await window.api.getConfig().catch(() => null);
    if (cfg && cfg.web && window.api.uploadFiles) {
      route('settings');
      showToast('Selecione os episódios ou use “Selecionar pasta” para temporada inteira', 4500);
      setTimeout(() => document.getElementById('uploadFilesInput')?.click(), 120);
      return;
    }
    const res = await window.api.addFolder();
    if (!res.ok) return;
    state.library = res.library;
    await renderAll();
    route('home');
    showToast('Pasta adicionada');
    // Auto-fetch metadata in background so banners/episode names appear without
    // the user having to click Configurações > Buscar metadados.
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

  const uploadFilesBtn = document.getElementById('uploadFilesBtn');
  const uploadFolderBtn = document.getElementById('uploadFolderBtn');
  const uploadFilesInput = document.getElementById('uploadFilesInput');
  const uploadFolderInput = document.getElementById('uploadFolderInput');
  if (uploadFilesBtn && uploadFilesInput) {
    uploadFilesBtn.addEventListener('click', () => uploadFilesInput.click());
    uploadFilesInput.addEventListener('change', () => uploadSelectedFiles(uploadFilesInput.files));
  }
  if (uploadFolderBtn && uploadFolderInput) {
    uploadFolderBtn.addEventListener('click', () => uploadFolderInput.click());
    uploadFolderInput.addEventListener('change', () => uploadSelectedFiles(uploadFolderInput.files));
  }

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
    if (e.key !== 'Escape') return;
    // Se o player ou o modal de busca estao abertos, nao fecha o detalhe.
    // O proprio player consome o ESC. Sem essa guarda, o ESC fecha player
    // E detail no mesmo evento, jogando o usuario direto pra home.
    if (player.el && !player.el.classList.contains('hidden')) return;
    if (!$('#searchModal').classList.contains('hidden')) return;
    if (!$('#detail').classList.contains('hidden')) closeDetail();
  });

  // Periodic refresh of progress + history so the "Continuar" row stays fresh
  setInterval(async () => {
    [state.progress, state.history] = await Promise.all([
      window.api.getProgress(),
      window.api.getHistory(),
    ]);
    await renderRows();
  }, 6000);

  // Monitor de uploads em tempo real (funciona entre dispositivos: PC <-> celular)
  setInterval(pollActiveUploads, 2500);
  pollActiveUploads();

  // Initial load
  state.library = await window.api.getLibrary();
  await renderAll();
  route('home');
  document.body.classList.remove('app-booting');
  document.body.classList.add('app-ready');

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
    let _searchDebounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(_searchDebounceTimer);
      _searchDebounceTimer = setTimeout(applyFilter, 180);
    });
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
  document.body.classList.remove('app-booting');
  document.body.classList.add('app-ready');
  showToast('Erro ao iniciar: ' + e.message);
});
