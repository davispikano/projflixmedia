// Browser adapter for the public web version. Electron keeps using preload.js;
// this file only defines window.api when it is opened in a normal browser.
(() => {
  if (window.api) return;

  const BASE = window.location.pathname.startsWith('/mediaflix') ? '/mediaflix' : '';
  const apiPath = (path) => BASE + path;

  async function request(path, options = {}) {
    const res = await fetch(apiPath(path), {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
    return res.json();
  }

  const post = (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) });
  let currentProfileId = localStorage.getItem('mediaflix:profileId') || 'default';
  const withProfile = (path) => path + (path.includes('?') ? '&' : '?') + 'profileId=' + encodeURIComponent(currentProfileId || 'default');
  const bodyWithProfile = (body = {}) => ({ ...body, profileId: currentProfileId || 'default' });

  window.api = {
    getLibrary: () => request('/api/library'),
    rescan: () => request('/api/library?rescan=1'),
    addFolder: async () => {
      const folder = prompt('Caminho da pasta no servidor onde estão os vídeos:');
      if (!folder) return { ok: false };
      return post('/api/folders', { folder });
    },
    removeFolder: (folder) => request('/api/folders?folder=' + encodeURIComponent(folder), { method: 'DELETE' }),
    getConfig: () => request('/api/config'),
    setVlcPath: async () => ({ ok: false, error: 'VLC externo não existe na versão web.' }),
    setTmdbKey: (key) => post('/api/config/tmdb', { key }),
    fetchAllMeta: () => post('/api/meta/fetch-all'),
    fetchAllImdb: () => post('/api/imdb/fetch-all'),
    onImdbProgress: () => {},
    clearMeta: () => post('/api/meta/clear'),
    searchMeta: (query, type) => request(`/api/meta/search?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type || '')}`),
    applyMeta: (itemTitle, itemType, tmdbId, mediaType, rawTitle, folder) => post('/api/meta/apply', { itemTitle, itemType, tmdbId, mediaType, rawTitle, folder }),
    resetCache: () => post('/api/library/reset'),
    onMetaProgress: () => {},
    getProfiles: () => request('/api/profiles'),
    createProfile: (name) => post('/api/profiles', { name }),
    deleteProfile: (id) => request('/api/profiles?id=' + encodeURIComponent(id), { method: 'DELETE' }),
    getStorageStatus: () => request('/api/storage/status'),
    setCurrentProfile: (id) => { currentProfileId = id || 'default'; localStorage.setItem('mediaflix:profileId', currentProfileId); return Promise.resolve({ ok: true }); },
    getCurrentProfileId: () => currentProfileId,
    getProgress: () => request(withProfile('/api/progress')),
    clearProgress: (p) => request(withProfile('/api/progress?path=' + encodeURIComponent(p)), { method: 'DELETE' }),
    getHistory: () => request(withProfile('/api/history')),
    clearHistory: () => request(withProfile('/api/history'), { method: 'DELETE' }),
    deleteMediaFile: (p) => request('/api/media-file?path=' + encodeURIComponent(p), { method: 'DELETE' }),
    autoDeleteWatched: (p) => post('/api/auto-delete-check', bodyWithProfile({ path: p })),

    getUploadToken: () => request('/api/upload-token'),
    getActiveUploads: () => request('/api/uploads/active'),
    play: async (p) => {
      const res = await post('/api/play', { path: p });
      if (res && res.url && BASE && res.url.startsWith('/api/')) res.url = BASE + res.url;
      return res;
    },
    uploadFiles: async (files, token, onProgress) => {
      const list = Array.from(files || []);
      const uploadToken = token || localStorage.getItem('mediaflix:uploadToken') || '';
      const uploadId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const chunkSize = 8 * 1024 * 1024; // 8 MB: progresso real e evita upload gigante em uma única request
      const totalBytes = list.reduce((sum, file) => sum + (file.size || 0), 0) || 1;
      let sentBytes = 0;
      let lastLibrary = null;
      let saved = [];

      if (onProgress) onProgress(0, { phase: 'start' });
      for (let fileIndex = 0; fileIndex < list.length; fileIndex++) {
        const file = list[fileIndex];
        const relPath = file.webkitRelativePath || file.name;
        const totalChunks = Math.max(1, Math.ceil((file.size || 0) / chunkSize));
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const start = chunkIndex * chunkSize;
          const end = Math.min(file.size || 0, start + chunkSize);
          const blob = file.slice(start, end);
          const qs = new URLSearchParams({
            uploadId,
            fileIndex: String(fileIndex),
            chunkIndex: String(chunkIndex),
            totalChunks: String(totalChunks),
            path: relPath,
            totalFiles: String(list.length),
            totalBytes: String(totalBytes),
            fileSize: String(file.size || 0),
          });
          const res = await fetch(apiPath('/api/upload-chunk?' + qs.toString()), {
            method: 'POST',
            headers: { 'X-Mediaflix-Upload-Token': uploadToken, 'Content-Type': 'application/octet-stream' },
            body: blob,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || res.statusText || 'Upload falhou');
          sentBytes += blob.size;
          const pct = Math.max(1, Math.min(99, Math.round((sentBytes / totalBytes) * 100)));
          if (onProgress) onProgress(pct, { phase: 'uploading', fileIndex, fileName: relPath, chunkIndex, totalChunks, loaded: sentBytes, total: totalBytes });
          if (data.final) {
            saved.push(data.saved);
            if (data.library) lastLibrary = data.library;
          }
        }
      }
      if (onProgress) onProgress(100, { phase: 'done' });
      return { ok: true, count: saved.length, saved, library: lastLibrary || await request('/api/library') };
    },
    openFolder: async () => ({ ok: false, error: 'Abrir pasta é recurso do app desktop.' }),
    openExternal: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve({ ok: true }); },
    getTrending: () => request('/api/discover/trending'),
    readImage: (p) => request('/api/image?path=' + encodeURIComponent(p)).then((r) => r.data),
    getSidecars: (p) => request('/api/player/sidecars?path=' + encodeURIComponent(p)),
    getThumbnail: (p) => Promise.resolve({ ok: true, data: apiPath('/api/thumb?path=' + encodeURIComponent(p)) }),
    saveProgress: (p, time, length, updatedAt) => post('/api/progress', bodyWithProfile({ path: p, time, length, updatedAt })),
    logOpen: (p) => post('/api/history/open', bodyWithProfile({ path: p })),
    logClose: (p) => post('/api/history/close', bodyWithProfile({ path: p })),
    setToggle: (key, value) => post('/api/config/toggle', { key, value }),
    setNumber: (key, value) => post('/api/config/number', { key, value }),
    setString: (key, value) => post('/api/config/string', { key, value }),
    getVersion: () => request('/api/version'),
    checkUpdate: () => request('/api/update'),
    probe: (p) => request('/api/player/probe?path=' + encodeURIComponent(p)),
    extractSub: (p, idx) => request(`/api/player/extract-sub?path=${encodeURIComponent(p)}&idx=${encodeURIComponent(idx)}`),
    onLibraryUpdated: () => {},
  };
})();
