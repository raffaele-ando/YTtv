// ============================================================
// YTtv — stato dell'app, persistenza locale e logica dati
// ============================================================

import { MAX_CACHE_PER_CHANNEL } from './config.js';
import { fetchChannelVideos, refineShortsDetection, setApiKey } from './api.js';

const LS_KEY = 'yttv:state:v2';

const defaultSettings = () => ({
  apiKey: '',
  maxPerChannel: 25,
  autoRefresh: true,
  autoplayNext: true,
  hideWatchedHome: true,
  updatedAt: 0,
});

const emptyState = () => ({
  channels: {},   // id -> {id,title,handle,thumb,banner,uploads,subs,addedAt,lastSource,lastFetch}
  videos: {},     // videoId -> {id,ch,title,pub,dur,views,isShort,live,src}
  watched: {},    // videoId -> {at, t? (sec visti)}
  progress: {},   // videoId -> {t, d, at}  (riproduzione parziale)
  watchLater: {}, // videoId -> at
  settings: defaultSettings(),
  meta: { updatedAt: 0, lastRefresh: 0 },
});

export const state = emptyState();

// ---------- eventi ----------

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what = 'change') { listeners.forEach((fn) => fn(what)); }

// ---------- persistenza locale ----------

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    Object.assign(state, emptyState(), data);
    state.settings = { ...defaultSettings(), ...(data.settings || {}) };
  } catch { /* stato corrotto → si riparte puliti */ }
  setApiKey(state.settings.apiKey);
}

let saveTimer = null;
export function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* quota piena */ }
  }, 150);
}

function touch() {
  state.meta.updatedAt = Date.now();
  saveLocal();
  cloudPush?.();
}

// hook impostato da cloud.js per sincronizzare dopo ogni modifica
let cloudPush = null;
export function setCloudPush(fn) { cloudPush = fn; }

// ---------- dati utente sincronizzabili ----------

export function userDataSnapshot() {
  return {
    channels: Object.fromEntries(
      Object.entries(state.channels).map(([id, c]) => [id, {
        id: c.id, title: c.title, handle: c.handle, thumb: c.thumb,
        banner: c.banner || '', uploads: c.uploads || '', subs: c.subs ?? null,
        addedAt: c.addedAt || 0,
        filters: c.filters || null, noShorts: Boolean(c.noShorts), fUpd: c.fUpd || 0,
      }])
    ),
    watched: state.watched,
    progress: state.progress,
    watchLater: state.watchLater,
    settings: state.settings,
    meta: { updatedAt: state.meta.updatedAt },
  };
}

// Fusione dei dati remoti con quelli locali (unione, vince il più recente)
export function mergeRemoteData(remote) {
  if (!remote) return false;
  let changed = false;

  for (const [id, ch] of Object.entries(remote.channels || {})) {
    const local = state.channels[id];
    if (!local) {
      state.channels[id] = { ...ch };
      changed = true;
    } else if ((ch.fUpd || 0) > (local.fUpd || 0)) {
      // i filtri del canale modificati su un altro dispositivo vincono se più recenti
      local.filters = ch.filters || null;
      local.noShorts = Boolean(ch.noShorts);
      local.fUpd = ch.fUpd;
      changed = true;
    }
  }
  for (const [id, w] of Object.entries(remote.watched || {})) {
    const local = state.watched[id];
    if (!local || (w.at || 0) > (local.at || 0)) { state.watched[id] = w; changed = true; }
  }
  for (const [id, p] of Object.entries(remote.progress || {})) {
    const local = state.progress[id];
    if (!local || (p.at || 0) > (local.at || 0)) { state.progress[id] = p; changed = true; }
  }
  for (const [id, at] of Object.entries(remote.watchLater || {})) {
    if (!state.watchLater[id]) { state.watchLater[id] = at; changed = true; }
  }
  const remoteUpd = remote.settings?.updatedAt || 0;
  if (remoteUpd > (state.settings.updatedAt || 0)) {
    state.settings = { ...defaultSettings(), ...remote.settings };
    setApiKey(state.settings.apiKey);
    changed = true;
  }
  if (changed) {
    state.meta.updatedAt = Math.max(state.meta.updatedAt, remote.meta?.updatedAt || 0);
    saveLocal();
    emit('remote-merge');
  }
  return changed;
}

// ---------- canali ----------

export function addChannel(channel) {
  if (state.channels[channel.id]) return false;
  state.channels[channel.id] = { ...channel, addedAt: Date.now() };
  touch();
  emit();
  return true;
}

export function removeChannel(id) {
  delete state.channels[id];
  for (const [vid, v] of Object.entries(state.videos)) {
    if (v.ch === id) delete state.videos[vid];
  }
  touch();
  emit();
}

export const channelList = () =>
  Object.values(state.channels).sort((a, b) => a.title.localeCompare(b.title, 'it'));

// ---------- filtri per canale ----------
// Ogni canale può avere regole sul titolo: "mostra solo ciò che corrisponde"
// (es. solo un podcast) oppure "nascondi ciò che corrisponde" (es. una rubrica
// che non interessa). I video esclusi restano in cache ma spariscono da Home,
// Video, Shorts, contatori e ricerca — in automatico, anche per i video futuri.

export function channelFilterInfo(ch) {
  const f = ch?.filters;
  if (!f || f.mode === 'all' || !Array.isArray(f.terms) || !f.terms.length) return null;
  return f;
}

function titleMatches(title, terms) {
  const t = (title || '').toLowerCase();
  return terms.some((k) => k && t.includes(k.toLowerCase()));
}

export function isExcluded(v) {
  const ch = state.channels[v.ch];
  if (!ch) return false;
  if (ch.noShorts && v.isShort) return true;
  const f = channelFilterInfo(ch);
  if (!f) return false;
  const m = titleMatches(v.title, f.terms);
  return f.mode === 'include' ? !m : m;
}

export function setChannelFilter(id, { mode = 'all', terms = [], noShorts = false } = {}) {
  const ch = state.channels[id];
  if (!ch) return;
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  ch.filters = mode === 'all' || !clean.length ? null : { mode, terms: clean };
  ch.noShorts = Boolean(noShorts);
  ch.fUpd = Date.now();
  touch();
  emit();
}

// ---------- video ----------

export function videosOf(channelId, { includeExcluded = false } = {}) {
  return Object.values(state.videos)
    .filter((v) => v.ch === channelId)
    .filter((v) => includeExcluded || !isExcluded(v))
    .sort((a, b) => new Date(b.pub) - new Date(a.pub));
}

export function allVideos({ shorts = null, includeExcluded = false } = {}) {
  let list = Object.values(state.videos);
  if (shorts === true) list = list.filter((v) => v.isShort);
  if (shorts === false) list = list.filter((v) => !v.isShort);
  if (!includeExcluded) list = list.filter((v) => !isExcluded(v));
  return list.sort((a, b) => new Date(b.pub) - new Date(a.pub));
}

export const isWatched = (id) => Boolean(state.watched[id]);
export const isWatchLater = (id) => Boolean(state.watchLater[id]);
export const progressOf = (id) => state.progress[id] || null;

export function unwatched({ shorts = null } = {}) {
  return allVideos({ shorts }).filter((v) => !isWatched(v.id));
}

export function continueWatching() {
  return Object.entries(state.progress)
    .filter(([id, p]) => !isWatched(id) && state.videos[id] && p.t > 20)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .map(([id]) => state.videos[id]);
}

export function watchLaterList() {
  return Object.entries(state.watchLater)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => state.videos[id])
    .filter(Boolean);
}

export function historyList(limit = 60) {
  return Object.entries(state.watched)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, limit)
    .map(([id, w]) => ({ video: state.videos[id], id, at: w.at }))
    .filter((h) => h.video);
}

// ---------- azioni utente ----------

export function markWatched(id, watched = true) {
  if (watched) {
    state.watched[id] = { at: Date.now() };
    delete state.progress[id];
    delete state.watchLater[id];
  } else {
    delete state.watched[id];
  }
  touch();
  emit();
}

export function toggleWatchLater(id) {
  if (state.watchLater[id]) delete state.watchLater[id];
  else state.watchLater[id] = Date.now();
  touch();
  emit();
  return Boolean(state.watchLater[id]);
}

export function saveProgress(id, t, d) {
  if (!t || t < 5) return;
  state.progress[id] = { t: Math.floor(t), d: Math.floor(d || 0), at: Date.now() };
  // visto al 90%
  if (d && t / d >= 0.9) markWatched(id, true);
  else { touch(); }
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch, { updatedAt: Date.now() });
  setApiKey(state.settings.apiKey);
  touch();
  emit('settings');
}

// ---------- refresh dei contenuti ----------

export const refreshStatus = { running: false, done: 0, total: 0, errors: [] };

export async function refreshChannel(channel) {
  const { videos, source } = await fetchChannelVideos(channel, state.settings.maxPerChannel);

  for (const v of videos) {
    const prev = state.videos[v.id];
    // non degradare i dati API con quelli RSS
    if (prev && prev.src === 'api' && v.src === 'rss') {
      prev.views = v.views ?? prev.views;
      continue;
    }
    state.videos[v.id] = prev ? { ...prev, ...v, probed: prev.probed, isShort: prev.probed ? prev.isShort : v.isShort } : v;
  }

  // pota la cache del canale (compresi gli esclusi dai filtri, o non verrebbero mai eliminati)
  const list = videosOf(channel.id, { includeExcluded: true });
  for (const old of list.slice(MAX_CACHE_PER_CHANNEL)) {
    if (!state.watchLater[old.id] && !state.progress[old.id]) delete state.videos[old.id];
  }

  const ch = state.channels[channel.id];
  if (ch) { ch.lastFetch = Date.now(); ch.lastSource = source; }

  // affina il riconoscimento shorts in background
  const mine = videosOf(channel.id).filter((v) => state.videos[v.id]?.ambiguous);
  if (mine.length) {
    refineShortsDetection(mine.map((v) => state.videos[v.id]), () => { saveLocal(); emit('shorts-refined'); });
  }

  saveLocal();
  return source;
}

export async function refreshAll(onProgress) {
  if (refreshStatus.running) return refreshStatus;
  const channels = channelList();
  refreshStatus.running = true;
  refreshStatus.done = 0;
  refreshStatus.total = channels.length;
  refreshStatus.errors = [];
  emit('refresh-start');

  const POOL = 4;
  const queue = [...channels];
  const worker = async () => {
    while (queue.length) {
      const ch = queue.shift();
      try {
        await refreshChannel(ch);
      } catch (e) {
        refreshStatus.errors.push({ channel: ch.title, message: e.message });
      }
      refreshStatus.done++;
      onProgress?.(refreshStatus);
      emit('refresh-progress');
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, channels.length) }, worker));

  refreshStatus.running = false;
  state.meta.lastRefresh = Date.now();
  saveLocal();
  emit('refresh-end');
  return refreshStatus;
}

// ---------- ricerca locale ----------

export function searchLocal(query) {
  const q = query.trim().toLowerCase();
  if (!q) return { channels: [], videos: [] };
  const channels = channelList().filter((c) =>
    c.title.toLowerCase().includes(q) || (c.handle || '').toLowerCase().includes(q));
  const videos = allVideos().filter((v) => v.title.toLowerCase().includes(q)).slice(0, 40);
  return { channels, videos };
}

// ---------- statistiche profilo ----------

export function stats() {
  const watchedEntries = Object.keys(state.watched);
  let watchedVideos = 0, watchedShorts = 0, seconds = 0;
  for (const id of watchedEntries) {
    const v = state.videos[id];
    if (v?.isShort) watchedShorts++; else watchedVideos++;
    if (v?.dur) seconds += v.dur;
  }
  return {
    channels: Object.keys(state.channels).length,
    toWatch: unwatched({ shorts: false }).length,
    toWatchShorts: unwatched({ shorts: true }).length,
    watchedVideos,
    watchedShorts,
    hours: Math.round(seconds / 3600 * 10) / 10,
    watchLater: Object.keys(state.watchLater).length,
  };
}

// ---------- export / import ----------

export function exportJSON() {
  return JSON.stringify({ ...userDataSnapshot(), exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('File non valido');
  mergeRemoteData(data);
  touch();
  emit();
}

export function resetAll() {
  Object.assign(state, emptyState());
  localStorage.removeItem(LS_KEY);
  emit();
}
