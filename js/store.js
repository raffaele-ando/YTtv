// ============================================================
// YTtv — stato dell'app, persistenza locale e logica dati
// ============================================================

import { MAX_CACHE_PER_CHANNEL } from './config.js';
import { fetchChannelVideos, refineShortsDetection, setApiKey, getPlaylistVideoIds } from './api.js';

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
  watchTime: {},  // videoId -> {sec, plays, first, last, ch, title, short}  (tempo di visione cumulativo)
  // "lapidi": cosa è stato cancellato e quando. Senza queste, una rimozione
  // fatta su un dispositivo tornerebbe indietro dal cloud (o dall'altro
  // dispositivo che ha ancora il dato) alla prima sincronizzazione.
  graves: {
    ch: {},       // channelId -> ts di rimozione
    wa: {},       // videoId -> ts in cui è stato segnato "da vedere"
    wl: {},       // videoId -> ts di rimozione da "guarda dopo"
  },
  activity: {
    daily: {},    // 'YYYY-MM-DD' -> {sec, plays, shorts, opens, appSec}
    events: [],   // cronologia dettagliata: {t, type, id?, ch?, title?, short?, q?, sec?}
    sessions: [], // {t, dur} sessioni d'uso dell'app
  },
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
  // normalizza le strutture di tracciamento per gli stati salvati da versioni precedenti
  state.watchTime = state.watchTime || {};
  state.activity = { daily: {}, events: [], sessions: [], ...(state.activity || {}) };
  state.graves = { ch: {}, wa: {}, wl: {}, ...(state.graves || {}) };
  setApiKey(state.settings.apiKey);
}

const MAX_GRAVES = 300;

// Registra una cancellazione (e tiene la lista limitata alle più recenti).
function grave(kind, id) {
  const g = state.graves[kind];
  if (!g) return;
  g[id] = Date.now();
  const keys = Object.keys(g);
  if (keys.length > MAX_GRAVES) {
    keys.sort((a, b) => g[b] - g[a]).slice(MAX_GRAVES).forEach((k) => delete g[k]);
  }
}
const ungrave = (kind, id) => { delete state.graves[kind]?.[id]; };

let saveTimer = null;
export function saveLocal() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLocalNow, 150);
}
export function saveLocalNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* quota piena */ }
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
    watchTime: state.watchTime,
    graves: state.graves,
    activity: {
      daily: state.activity.daily,
      events: state.activity.events.slice(0, 250),
      sessions: state.activity.sessions.slice(0, 120),
    },
    settings: state.settings,
    meta: { updatedAt: state.meta.updatedAt },
  };
}

// Applica le lapidi ai dati locali: ciò che è stato cancellato (qui o su un
// altro dispositivo) sparisce, a meno che non sia stato ri-aggiunto dopo.
function applyGraves() {
  let changed = false;
  for (const [id, ts] of Object.entries(state.graves.ch)) {
    const ch = state.channels[id];
    if (ch && (ch.addedAt || 0) <= ts) {
      delete state.channels[id];
      for (const [vid, v] of Object.entries(state.videos)) if (v.ch === id) delete state.videos[vid];
      changed = true;
    }
  }
  for (const [id, ts] of Object.entries(state.graves.wa)) {
    const w = state.watched[id];
    if (w && (w.at || 0) <= ts) { delete state.watched[id]; changed = true; }
  }
  for (const [id, ts] of Object.entries(state.graves.wl)) {
    const at = state.watchLater[id];
    if (at != null && at <= ts) { delete state.watchLater[id]; changed = true; }
  }
  return changed;
}

// Fusione dei dati remoti con quelli locali (unione, vince il più recente)
export function mergeRemoteData(remote) {
  if (!remote) return false;
  let changed = false;

  // 1) unione delle lapidi (vince il timestamp più recente)
  for (const kind of ['ch', 'wa', 'wl']) {
    for (const [id, ts] of Object.entries(remote.graves?.[kind] || {})) {
      if ((state.graves[kind][id] || 0) < ts) { state.graves[kind][id] = ts; changed = true; }
    }
  }
  // 2) le cancellazioni fatte altrove valgono anche qui
  if (applyGraves()) changed = true;

  // 3) fusione dei dati, ignorando ciò che risulta cancellato
  const buried = (kind, id, ts) => (state.graves[kind][id] || 0) >= (ts || 0);

  for (const [id, ch] of Object.entries(remote.channels || {})) {
    if (buried('ch', id, ch.addedAt)) continue;
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
    if (buried('wa', id, w.at)) continue;
    const local = state.watched[id];
    if (!local || (w.at || 0) > (local.at || 0)) { state.watched[id] = w; changed = true; }
  }
  for (const [id, p] of Object.entries(remote.progress || {})) {
    const local = state.progress[id];
    if (!local || (p.at || 0) > (local.at || 0)) { state.progress[id] = p; changed = true; }
  }
  for (const [id, at] of Object.entries(remote.watchLater || {})) {
    if (buried('wl', id, at)) continue;
    if (!state.watchLater[id]) { state.watchLater[id] = at; changed = true; }
  }
  // tempo di visione: unione conservativa (max), non somma → mai gonfiato tra dispositivi
  for (const [id, r] of Object.entries(remote.watchTime || {})) {
    const l = state.watchTime[id];
    if (!l) { state.watchTime[id] = { ...r }; changed = true; }
    else {
      const merged = {
        sec: Math.max(l.sec || 0, r.sec || 0),
        plays: Math.max(l.plays || 0, r.plays || 0),
        first: Math.min(l.first || r.first || 0, r.first || l.first || 0) || (l.first || r.first || 0),
        last: Math.max(l.last || 0, r.last || 0),
        ch: l.ch || r.ch || null,
        title: l.title || r.title || '',
        short: l.short ?? r.short ?? false,
      };
      // confronto campo per campo: con JSON.stringify bastava un ordine di
      // chiavi diverso per far credere che ci fosse una modifica, e i due
      // dispositivi si rimpallavano scritture all'infinito
      const differs = ['sec', 'plays', 'first', 'last', 'ch', 'title', 'short']
        .some((k) => merged[k] !== l[k]);
      if (differs) { state.watchTime[id] = merged; changed = true; }
    }
  }
  // aggregati giornalieri: max per campo per giorno (evita doppi conteggi al riallineamento)
  const rDaily = remote.activity?.daily || {};
  for (const [dk, d] of Object.entries(rDaily)) {
    const l = state.activity.daily[dk];
    if (!l) { state.activity.daily[dk] = { ...d }; changed = true; }
    else {
      for (const k of ['sec', 'plays', 'shorts', 'opens', 'appSec']) {
        const nv = Math.max(l[k] || 0, d[k] || 0);
        if (nv !== (l[k] || 0)) { l[k] = nv; changed = true; }
      }
    }
  }
  // cronologia eventi: unione con dedup, ordinata per tempo, limitata
  const rEvents = remote.activity?.events || [];
  if (rEvents.length) {
    const key = (e) => `${e.t}|${e.type}|${e.id || ''}`;
    const seen = new Set(state.activity.events.map(key));
    let added = false;
    for (const e of rEvents) if (!seen.has(key(e))) { state.activity.events.push(e); seen.add(key(e)); added = true; }
    if (added) {
      state.activity.events.sort((a, b) => b.t - a.t);
      state.activity.events.length = Math.min(state.activity.events.length, 250);
      changed = true;
    }
  }
  // sessioni: unione per timestamp d'inizio
  const rSessions = remote.activity?.sessions || [];
  if (rSessions.length) {
    const seenS = new Set(state.activity.sessions.map((s) => s.t));
    let added = false;
    for (const s of rSessions) if (!seenS.has(s.t)) { state.activity.sessions.push(s); seenS.add(s.t); added = true; }
    if (added) {
      state.activity.sessions.sort((a, b) => b.t - a.t);
      state.activity.sessions.length = Math.min(state.activity.sessions.length, 120);
      changed = true;
    }
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
  if (!channel?.id || state.channels[channel.id]) return false;
  ungrave('ch', channel.id);
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
  grave('ch', id);
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
  if (!f || f.mode === 'all') return null;
  const hasTerms = Array.isArray(f.terms) && f.terms.length;
  const hasPls = Array.isArray(f.playlists) && f.playlists.length;
  return hasTerms || hasPls ? f : null;
}

function titleMatches(text, terms) {
  const t = (text || '').toLowerCase();
  return terms.some((k) => k && t.includes(k.toLowerCase()));
}

// Un video "corrisponde" al filtro se una parola compare nel titolo (e nella
// descrizione, se richiesto) OPPURE se appartiene a una playlist selezionata.
export function videoMatchesFilter(v, f, ch) {
  const inPlaylist = Boolean(ch?.plVids?.[v.id]);
  const text = f.inDesc ? `${v.title}\n${v.desc || ''}` : v.title;
  const byTerms = f.terms?.length ? titleMatches(text, f.terms) : false;
  return byTerms || inPlaylist;
}

export function isExcluded(v) {
  const ch = state.channels[v.ch];
  if (!ch) return false;
  if (ch.noShorts && v.isShort) return true;
  const f = channelFilterInfo(ch);
  if (!f) return false;
  const m = videoMatchesFilter(v, f, ch);
  return f.mode === 'include' ? !m : m;
}

export function setChannelFilter(id, {
  mode = 'all', terms = [], inDesc = false, noShorts = false, playlists = [], plVids = null,
} = {}) {
  const ch = state.channels[id];
  if (!ch) return;
  const clean = terms.map((t) => t.trim()).filter(Boolean);
  const pls = (playlists || []).filter((p) => p?.id).map((p) => ({ id: p.id, title: p.title || 'Playlist' }));
  ch.filters = (mode === 'all' || (!clean.length && !pls.length))
    ? null
    : { mode, terms: clean, inDesc: Boolean(inDesc), playlists: pls };
  ch.noShorts = Boolean(noShorts);
  if (plVids) ch.plVids = plVids;
  if (!ch.filters?.playlists?.length) delete ch.plVids;
  ch.fUpd = Date.now();
  touch();
  emit();
}

// Aggiorna la mappa "video → appartiene a una playlist selezionata".
// Richiede l'API; se non è disponibile si tiene la mappa precedente e si
// riprova al prossimo aggiornamento. La mappa è locale (non va nel cloud):
// ogni dispositivo la ricostruisce da sé partendo dalle playlist scelte.
async function updatePlaylistMembership(channel) {
  const ch = state.channels[channel.id];
  const pls = ch?.filters?.playlists;
  if (!pls?.length) return;
  const cachedIds = new Set(videosOf(channel.id, { includeExcluded: true }).map((v) => v.id));
  const member = {};
  let ok = 0;
  for (const pl of pls) {
    try {
      const ids = await getPlaylistVideoIds(pl.id);
      for (const id of ids) if (cachedIds.has(id)) member[id] = 1;
      ok++;
    } catch { /* quota/offline: si riprova più tardi */ }
  }
  if (!ok) return;
  // se qualche playlist non è stata letta, non perdere le appartenenze note
  ch.plVids = ok === pls.length ? member : { ...(ch.plVids || {}), ...member };
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

// Informazioni su un video anche se non è più in cache (o non lo è ancora su
// questo dispositivo): si ricostruiscono dal tracciamento, che viaggia nel cloud.
export function videoInfo(id) {
  const v = state.videos[id];
  if (v) return v;
  const wt = state.watchTime[id];
  if (!wt) return null;
  return {
    id, ch: wt.ch || null, title: wt.title || 'Video', desc: '',
    pub: wt.first || 0, dur: 0, views: null, isShort: Boolean(wt.short),
    live: false, src: 'track', fromTracking: true,
  };
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
    .map(([id, w]) => ({ video: videoInfo(id), id, at: w.at }))
    .filter((h) => h.video);
}

// ---------- azioni utente ----------

function setWatched(id, watched) {
  if (watched) {
    ungrave('wa', id);
    state.watched[id] = { at: Date.now() };
    delete state.progress[id];
    if (state.watchLater[id] != null) { delete state.watchLater[id]; grave('wl', id); }
  } else {
    delete state.watched[id];
    grave('wa', id);
  }
}

export function markWatched(id, watched = true) {
  setWatched(id, watched);
  touch();
  emit();
}

// Segna in blocco (un solo salvataggio/sync invece di uno per video).
export function markManyWatched(ids, watched = true) {
  for (const id of ids) setWatched(id, watched);
  touch();
  emit();
}

export function toggleWatchLater(id) {
  if (state.watchLater[id]) { delete state.watchLater[id]; grave('wl', id); }
  else { ungrave('wl', id); state.watchLater[id] = Date.now(); }
  touch();
  emit();
  return Boolean(state.watchLater[id]);
}

export function saveProgress(id, t, d) {
  if (!t || t < 5) return;
  // già visto: niente da salvare (evitava un markWatched ripetuto ogni 5s
  // negli ultimi minuti del video, con un push nel cloud ogni volta)
  if (state.watched[id]) return;
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

// ============================================================
// Tracciamento attività: cosa guardi, chi, per quanto, quando
// ============================================================

export function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dailyEntry(ts = Date.now()) {
  const k = dateKey(ts);
  return (state.activity.daily[k] ||= { sec: 0, plays: 0, shorts: 0, opens: 0, appSec: 0 });
}

function watchEntry(videoId) {
  const v = state.videos[videoId];
  const wt = (state.watchTime[videoId] ||= {
    sec: 0, plays: 0, first: Date.now(), last: 0, ch: v?.ch || null, title: v?.title || '', short: !!v?.isShort,
  });
  if (v) { wt.ch = v.ch; wt.title = v.title; wt.short = !!v.isShort; }
  return wt;
}

export function logEvent(type, meta = {}) {
  const ev = { t: Date.now(), type };
  for (const [k, val] of Object.entries(meta)) if (val != null) ev[k] = val;
  state.activity.events.unshift(ev);
  if (state.activity.events.length > 250) state.activity.events.length = 250;
  saveLocal();
  cloudPush?.();
}

// Chiamata all'avvio di una riproduzione (una volta per apertura del player).
export function logPlay(videoId) {
  const v = state.videos[videoId];
  const wt = watchEntry(videoId);
  wt.plays++;
  wt.last = Date.now();
  const d = dailyEntry();
  d.plays++;
  if (v?.isShort) d.shorts++;
  logEvent('play', { id: videoId, ch: v?.ch, title: v?.title, short: !!v?.isShort });
  state.meta.updatedAt = Date.now();
}

// Accumula secondi realmente guardati di un video.
export function logWatch(videoId, sec) {
  sec = Math.round(sec);
  if (!sec || sec < 0 || sec > 3600) return;
  const wt = watchEntry(videoId);
  wt.sec += sec;
  wt.last = Date.now();
  dailyEntry().sec += sec;
  state.meta.updatedAt = Date.now();
  saveLocal();
  cloudPush?.();
}

// ---------- sessioni d'uso dell'app ----------

let currentSession = null;

export function startSession() {
  currentSession = { t: Date.now(), dur: 0 };
  state.activity.sessions.unshift(currentSession);
  if (state.activity.sessions.length > 120) state.activity.sessions.length = 120;
  dailyEntry().opens++;
  logEvent('open');
}

export function sessionHeartbeat(sec) {
  if (!currentSession) return;
  currentSession.dur += sec;
  dailyEntry().appSec += sec;
  state.meta.updatedAt = Date.now();
  saveLocal();
  cloudPush?.();
}

// ---------- analisi per la pagina Statistiche ----------

export function analytics(days = 14) {
  const times = Object.entries(state.watchTime);
  let totalSec = 0, totalPlays = 0, videoSec = 0, shortSec = 0, videoPlays = 0, shortPlays = 0;
  const byChannel = {};
  for (const [, wt] of times) {
    totalSec += wt.sec || 0;
    totalPlays += wt.plays || 0;
    if (wt.short) { shortSec += wt.sec || 0; shortPlays += wt.plays || 0; }
    else { videoSec += wt.sec || 0; videoPlays += wt.plays || 0; }
    if (wt.ch) {
      const c = (byChannel[wt.ch] ||= { ch: wt.ch, sec: 0, plays: 0 });
      c.sec += wt.sec || 0; c.plays += wt.plays || 0;
    }
  }

  const topChannels = Object.values(byChannel)
    .map((c) => ({ ...c, title: state.channels[c.ch]?.title || 'Canale rimosso', thumb: state.channels[c.ch]?.thumb || '' }))
    .sort((a, b) => b.sec - a.sec);

  // serie temporale ultimi N giorni
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = Date.now() - i * 86400000;
    const k = dateKey(ts);
    const d = state.activity.daily[k] || { sec: 0, plays: 0, shorts: 0, opens: 0, appSec: 0 };
    const date = new Date(ts);
    series.push({
      key: k,
      label: date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }),
      weekday: date.toLocaleDateString('it-IT', { weekday: 'short' }),
      sec: d.sec || 0, plays: d.plays || 0, shorts: d.shorts || 0, videos: (d.plays || 0) - (d.shorts || 0),
      opens: d.opens || 0, appSec: d.appSec || 0,
    });
  }

  // distribuzione per fascia oraria (dai plays negli eventi)
  const hours = Array.from({ length: 24 }, () => 0);
  for (const e of state.activity.events) {
    if (e.type === 'play') hours[new Date(e.t).getHours()]++;
  }

  // streak di giorni consecutivi con attività
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const k = dateKey(Date.now() - i * 86400000);
    const d = state.activity.daily[k];
    if (d && ((d.plays || 0) > 0 || (d.appSec || 0) > 30)) streak++;
    else if (i === 0) continue; // oggi ancora senza attività: non spezza lo streak di ieri
    else break;
  }

  const appSecTotal = state.activity.sessions.reduce((s, x) => s + (x.dur || 0), 0);
  const activeDays = Object.values(state.activity.daily).filter((d) => (d.plays || 0) > 0 || (d.appSec || 0) > 30).length;

  return {
    totalSec, totalPlays, videoSec, shortSec, videoPlays, shortPlays,
    topChannels, series, hours, streak,
    appSecTotal, activeDays,
    sessions: state.activity.sessions.length,
    avgDaySec: activeDays ? Math.round(totalSec / activeDays) : 0,
    watchedDistinct: Object.keys(state.watched).length,
  };
}

export function recentActivity(limit = 40) {
  return state.activity.events.slice(0, limit);
}

export function clearActivity() {
  state.watchTime = {};
  state.activity = { daily: {}, events: [], sessions: [] };
  currentSession = null;
  // riapre subito una sessione, altrimenti il tempo nell'app non verrebbe più
  // conteggiato fino al ricaricamento della pagina
  startSession();
  touch();
  emit();
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

  // Pota la cache del canale (compresi gli esclusi dai filtri, o non verrebbero
  // mai eliminati). I contenuti a cui l'utente è "attaccato" (guarda dopo, in
  // corso, già visti) restano più a lungo: cancellarli subito svuotava la
  // cronologia e falsava i conteggi visti/shorts.
  const list = videosOf(channel.id, { includeExcluded: true });
  const keep = (v) => state.watchLater[v.id] || state.progress[v.id] || state.watched[v.id];
  for (const old of list.slice(MAX_CACHE_PER_CHANNEL)) {
    if (!keep(old)) delete state.videos[old.id];
  }
  // limite comunque invalicabile, per non far crescere lo storage all'infinito
  for (const old of list.slice(MAX_CACHE_PER_CHANNEL * 3)) {
    if (!state.watchLater[old.id] && !state.progress[old.id]) delete state.videos[old.id];
  }

  const ch = state.channels[channel.id];
  if (ch) { ch.lastFetch = Date.now(); ch.lastSource = source; }

  // aggiorna l'appartenenza alle playlist filtrate (vale anche per i video nuovi)
  await updatePlaylistMembership(channel);

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
  let watchedVideos = 0, watchedShorts = 0;
  for (const id of watchedEntries) {
    // videoInfo copre anche i video usciti dalla cache: senza, finivano tutti
    // conteggiati come "video" anche quando erano shorts
    const v = videoInfo(id);
    if (v?.isShort) watchedShorts++; else watchedVideos++;
  }
  // ore reali di visione dal tempo tracciato (fallback sulla durata dei visti)
  let seconds = Object.values(state.watchTime).reduce((s, wt) => s + (wt.sec || 0), 0);
  if (!seconds) {
    for (const id of watchedEntries) { const v = state.videos[id]; if (v?.dur) seconds += v.dur; }
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
  currentSession = null;
  startSession();
  // Senza questo, con l'accesso Google attivo il documento remoto (più recente)
  // rimetteva subito tutto al suo posto e l'azzeramento sembrava non funzionare.
  touch();
  emit();
}
