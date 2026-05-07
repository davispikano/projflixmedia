/* Mediaflix renderer */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  library: [],
  progress: {},
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

function itemProgress(item) {
  if (item.type === 'movie') return progressOf(item.path);
  // For series, find the most recent episode with progress
  let latest = null;
  for (const ep of item.episodes) {
    const p = state.progress[ep.path];
    if (!p) continue;
    if (!latest || p.updatedAt > latest.updatedAt) {
      latest = { ...p, episode: ep, ratio: Math.min(1, p.time / p.length) };
    }
  }
  return latest;
}

function nextEpisode(item) {
  const last = itemProgress(item);
  if (!last || !last.episode) return item.episodes[0];
  if (last.ratio < 0.95) return last.episode;
  // pick next index
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
    .filter((x) => x.p)
    .sort((a, b) => b.p.updatedAt - a.p.updatedAt);

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
async function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  const prog = itemProgress(item);
  const bg = item.banner ? await loadImage(item.banner) : null;
  const sub = item.type === 'series'
    ? `${item.episodes.length} EP${item.episodes.length > 1 ? 'S' : ''}`
    : 'FILME';

  card.innerHTML = `
    <div class="card-img ${bg ? '' : 'fallback'}" ${bg ? `style="background-image:url('${bg}')"` : ''}></div>
    <div class="card-fade"></div>
    <span class="card-badge">${sub}</span>
    <div class="card-meta">
      <h3 class="card-title">${escapeHtml(item.title)}</h3>
      <span class="card-sub">${item.type === 'series' && prog && prog.episode
        ? `EP ${prog.episode.index} · ${Math.round(prog.ratio * 100)}%`
        : (prog ? `${Math.round(prog.ratio * 100)}% assistido` : '')}</span>
    </div>
    ${prog ? `<div class="card-progress"><span style="width:${(prog.ratio * 100).toFixed(1)}%"></span></div>` : ''}
  `;
  card.addEventListener('click', () => {
    if (item.type === 'series') openDetail(item);
    else playItem(item);
  });
  return card;
}

async function renderRows() {
  const series = state.library.filter((i) => i.type === 'series');
  const movies = state.library.filter((i) => i.type === 'movie');

  const continueItems = state.library
    .map((i) => ({ i, p: itemProgress(i) }))
    .filter((x) => x.p && x.p.ratio < 0.95)
    .sort((a, b) => b.p.updatedAt - a.p.updatedAt)
    .map((x) => x.i)
    .slice(0, 12);

  await fillRow('#continueRow', '#continueTrack', '#continueCount', continueItems);
  await fillRow('#seriesRow', '#seriesTrack', '#seriesCount', series);
  await fillRow('#moviesRow', '#moviesTrack', '#moviesCount', movies);
}

async function fillRow(rowSel, trackSel, countSel, items) {
  const row = $(rowSel), track = $(trackSel), count = $(countSel);
  if (!items.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  count.textContent = String(items.length).padStart(2, '0');
  track.innerHTML = '';
  // Build sequentially to await loadImage but it's cached
  for (const item of items) {
    track.appendChild(await buildCard(item));
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
    $('#detailMeta').textContent = `${item.episodes.length} episódios`;
    const next = nextEpisode(item);
    const prog = state.progress[next.path];
    $('#detailPlayLabel').textContent = prog && prog.time > 30 ? `Continuar EP ${next.index}` : `Reproduzir EP ${next.index}`;
    $('#detailPlayBtn').onclick = () => playFile(next.path);

    const list = $('#episodeList');
    list.innerHTML = '';
    for (const ep of item.episodes) {
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
  } else {
    $('#detailMeta').textContent = 'Filme';
    const prog = state.progress[item.path];
    $('#detailPlayLabel').textContent = prog && prog.time > 30 ? 'Continuar' : 'Reproduzir';
    $('#detailPlayBtn').onclick = () => playFile(item.path);
    $('#episodeList').innerHTML = '';
  }

  $('#detailOpenFolderBtn').onclick = () => window.api.openFolder(item.folder || item.path);
}

function closeDetail() {
  $('#detail').classList.add('hidden');
  state.currentDetail = null;
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
  }
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
  state.progress = await window.api.getProgress();
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

  // Add folder
  const addFolder = async () => {
    const res = await window.api.addFolder();
    if (res.ok) {
      state.library = res.library;
      await renderAll();
      route('home');
      showToast('Pasta adicionada e biblioteca atualizada');
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

  // Detail close
  $('#detailClose').addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#detail').classList.contains('hidden')) closeDetail();
  });

  // Periodic refresh of progress so cards stay current while VLC is open
  setInterval(async () => {
    state.progress = await window.api.getProgress();
    // Re-render rows lightly only if something changed
  }, 6000);

  // Initial load
  state.library = await window.api.getLibrary();
  await renderAll();
  if (!state.library.length) route('home');
}

init().catch((e) => {
  console.error(e);
  showToast('Erro ao iniciar: ' + e.message);
});
