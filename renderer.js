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
  const prog = itemProgress(item);
  const bg = item.banner ? await loadImage(item.banner) : null;
  const sub = item.type === 'series'
    ? `${item.seasons && item.seasons.length > 1 ? item.seasons.length + ' TEMPORADAS' : item.episodes.length + ' EP' + (item.episodes.length > 1 ? 'S' : '')}`
    : 'FILME';

  card.innerHTML = `
    <div class="card-img ${bg ? '' : 'fallback'}" ${bg ? `style="background-image:url('${bg}')"` : ''}></div>
    <div class="card-fade"></div>
    <span class="card-badge">${sub}</span>
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
      if (item.type === 'series' && prog && prog.episode) return playFile(prog.episode.path);
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
    $('#detailPlayBtn').onclick = () => playFile(next.path);

    renderSeasonTabs(item, next.season != null ? next.season : (item.seasons[0] && item.seasons[0].number));
  } else {
    $('#detailMeta').textContent = item.year ? `Filme · ${item.year}` : 'Filme';
    const prog = state.progress[item.path];
    $('#detailPlayLabel').textContent = prog && prog.time > 30 ? 'Continuar' : 'Reproduzir';
    $('#detailPlayBtn').onclick = () => playFile(item.path);
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
        ${ratio > 0 ? `<div class="episode-progress"><span style="width:${(ratio * 100).toFixed(1)}%"></span></div>` : ''}
      </div>
      <div class="episode-meta">${p ? `${fmtTime(p.time)} / ${fmtTime(p.length)}` : ''}</div>
    `;
    li.addEventListener('click', () => playFile(ep.path));
    list.appendChild(li);
  }
}

function closeDetail() {
  $('#detail').classList.add('hidden');
  state.currentDetail = null;
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
      const apply = await window.api.applyMeta(item.title, item.type, r.id, r.mediaType);
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
    return playFile(ep.path);
  }
  return playFile(item.path);
}

async function playFile(filePath) {
  showToast('Abrindo no VLC…');
  const res = await window.api.play(filePath);
  if (!res.ok) {
    showToast(res.error || 'Falha ao abrir o VLC');
    return;
  }
  // Refresh history immediately so "Continuar assistindo" updates without waiting
  state.history = await window.api.getHistory();
  await renderRows();
  await renderHero();
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

  // Restore + wire row view toggles (carousel <-> grid). Preference is persisted
  // per row in localStorage so it survives restarts.
  document.querySelectorAll('.row-toggle').forEach((btn) => {
    const targetId = btn.dataset.target;
    const section = document.getElementById(targetId);
    if (!section) return;
    const storageKey = 'rowView:' + targetId;
    if (localStorage.getItem(storageKey) === 'grid') section.classList.add('grid');
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
