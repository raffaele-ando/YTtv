// ============================================================
// YTtv — accesso dati: YouTube Data API v3 + fallback feed RSS
// ============================================================

import { CORS_PROXIES, DEFAULT_API_KEY } from './config.js';
import { parseISODuration, probeVerticalThumb } from './utils.js';

let apiKey = DEFAULT_API_KEY;
export function setApiKey(key) { apiKey = (key || '').trim() || DEFAULT_API_KEY; }

export class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function yt(endpoint, params = {}) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('key', apiKey);
  // senza timeout una rete lenta bloccherebbe l'interfaccia e il fallback RSS
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || '';
    const msg = data?.error?.message || `Errore API (${res.status})`;
    throw new ApiError(msg, reason || res.status);
  }
  return data;
}

// ---------- risoluzione canale ----------

function channelFromApiItem(item) {
  const sn = item.snippet || {};
  return {
    id: item.id,
    title: sn.title || 'Canale',
    handle: sn.customUrl || '',
    description: sn.description || '',
    thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
    banner: item.brandingSettings?.image?.bannerExternalUrl || '',
    uploads: item.contentDetails?.relatedPlaylists?.uploads || '',
    subs: item.statistics?.hiddenSubscriberCount ? null : (item.statistics?.subscriberCount ?? null),
    videoCount: item.statistics?.videoCount ?? null,
  };
}

const CH_PARTS = 'snippet,contentDetails,statistics,brandingSettings';

export async function getChannelById(id) {
  const data = await yt('channels', { part: CH_PARTS, id });
  const item = data.items?.[0];
  if (!item) throw new ApiError('Canale non trovato', 'notFound');
  return channelFromApiItem(item);
}

export async function getChannelByHandle(handle) {
  const h = handle.startsWith('@') ? handle : `@${handle}`;
  const data = await yt('channels', { part: CH_PARTS, forHandle: h });
  const item = data.items?.[0];
  if (!item) throw new ApiError(`Nessun canale trovato per ${h}`, 'notFound');
  return channelFromApiItem(item);
}

export async function getChannelByUsername(username) {
  const data = await yt('channels', { part: CH_PARTS, forUsername: username });
  const item = data.items?.[0];
  if (!item) throw new ApiError('Canale non trovato', 'notFound');
  return channelFromApiItem(item);
}

// Interpreta qualsiasi input: link, @tag, ID o nome.
// Ritorna { kind: 'channel', channel } oppure { kind: 'search', results: [...] }.
export async function resolveChannelInput(input) {
  const q = input.trim();
  if (!q) throw new ApiError('Inserisci un canale', 'empty');

  // ID canale diretto
  if (/^UC[\w-]{22}$/.test(q)) {
    return { kind: 'channel', channel: await getChannelById(q) };
  }

  // URL YouTube
  const urlMatch = q.match(/(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(channel\/(UC[\w-]{22})|@([\w.\-]+)|user\/([\w.\-]+)|c\/([\w.\-]+))/i);
  if (urlMatch) {
    if (urlMatch[2]) return { kind: 'channel', channel: await getChannelById(urlMatch[2]) };
    if (urlMatch[3]) return { kind: 'channel', channel: await getChannelByHandle(urlMatch[3]) };
    if (urlMatch[4]) return { kind: 'channel', channel: await getChannelByUsername(urlMatch[4]) };
    if (urlMatch[5]) return { kind: 'search', results: await searchChannels(urlMatch[5]) };
  }

  // @handle
  if (q.startsWith('@')) {
    try {
      return { kind: 'channel', channel: await getChannelByHandle(q) };
    } catch {
      return { kind: 'search', results: await searchChannels(q.slice(1)) };
    }
  }

  // nome libero → ricerca
  return { kind: 'search', results: await searchChannels(q) };
}

export async function searchChannels(query, max = 8) {
  const data = await yt('search', {
    part: 'snippet', type: 'channel', q: query, maxResults: max,
  });
  const ids = (data.items || []).map((i) => i.id?.channelId).filter(Boolean);
  if (!ids.length) return [];
  const full = await yt('channels', { part: CH_PARTS, id: ids.join(','), maxResults: 50 });
  const byId = new Map((full.items || []).map((i) => [i.id, channelFromApiItem(i)]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// ---------- video di un canale ----------

function classifyShort(durationSec, title = '') {
  if (durationSec > 0 && durationSec <= 63) return true;
  if (durationSec <= 183 && /#short/i.test(title)) return true;
  return false;
}

// Percorso primario: API (playlist "uploads" → dettagli video in batch)
export async function fetchChannelVideosAPI(channel, max = 25) {
  let uploads = channel.uploads;
  if (!uploads) {
    const fresh = await getChannelById(channel.id);
    uploads = fresh.uploads;
  }
  if (!uploads) throw new ApiError('Playlist upload non trovata', 'noUploads');

  const pl = await yt('playlistItems', {
    part: 'contentDetails', playlistId: uploads, maxResults: Math.min(max, 50),
  });
  const ids = (pl.items || [])
    .map((i) => i.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];

  const det = await yt('videos', {
    part: 'snippet,contentDetails,statistics,liveStreamingDetails',
    id: ids.join(','), maxResults: 50,
  });

  return (det.items || []).map((v) => {
    const dur = parseISODuration(v.contentDetails?.duration || '');
    const isLive = v.snippet?.liveBroadcastContent === 'live';
    const isUpcoming = v.snippet?.liveBroadcastContent === 'upcoming';
    return {
      id: v.id,
      ch: channel.id,
      title: v.snippet?.title || '',
      pub: v.snippet?.publishedAt || '',
      dur,
      views: v.statistics?.viewCount ?? null,
      isShort: classifyShort(dur, v.snippet?.title),
      ambiguous: dur > 63 && dur <= 185 && !classifyShort(dur, v.snippet?.title),
      live: isLive,
      upcoming: isUpcoming,
      src: 'api',
    };
  }).filter((v) => !v.upcoming);
}

// Fallback: feed RSS ufficiale di YouTube (niente chiave API richiesta)
export async function fetchChannelVideosRSS(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let xmlText = null;
  let lastErr = null;

  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(feedUrl), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.includes('<feed')) { xmlText = text; break; }
      throw new Error('Risposta non valida');
    } catch (e) {
      lastErr = e;
    }
  }
  if (!xmlText) throw new ApiError(`Feed RSS non raggiungibile: ${lastErr?.message || ''}`, 'rss');

  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const YT_NS = 'http://www.youtube.com/xml/schemas/2015';
  const MEDIA_NS = 'http://search.yahoo.com/mrss/';
  const entries = [...doc.getElementsByTagName('entry')];

  return entries.map((entry) => {
    const vid = entry.getElementsByTagNameNS(YT_NS, 'videoId')[0]?.textContent;
    if (!vid) return null;
    const title = entry.getElementsByTagName('title')[0]?.textContent || '';
    const pub = entry.getElementsByTagName('published')[0]?.textContent || '';
    const stats = entry.getElementsByTagNameNS(MEDIA_NS, 'statistics')[0];
    return {
      id: vid,
      ch: channelId,
      title,
      pub,
      dur: 0, // il feed RSS non espone la durata
      views: stats?.getAttribute('views') ?? null,
      isShort: /#short/i.test(title),
      ambiguous: !/#short/i.test(title), // da verificare con la miniatura verticale
      live: false,
      src: 'rss',
    };
  }).filter(Boolean);
}

// Strategia combinata: API prima, RSS come rete di sicurezza.
export async function fetchChannelVideos(channel, max = 25) {
  try {
    const videos = await fetchChannelVideosAPI(channel, max);
    return { videos, source: 'api' };
  } catch (apiErr) {
    try {
      const videos = await fetchChannelVideosRSS(channel.id);
      return { videos, source: 'rss', apiError: apiErr };
    } catch (rssErr) {
      throw apiErr instanceof ApiError ? apiErr : rssErr;
    }
  }
}

// Per i video con classificazione incerta (durata 1–3 min o provenienti da RSS)
// verifica l'esistenza della miniatura verticale, che solo gli Shorts hanno.
export async function refineShortsDetection(videos, onUpdate) {
  const pending = videos.filter((v) => v.ambiguous && !v.probed);
  const CHUNK = 6;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK);
    await Promise.all(batch.map(async (v) => {
      const vertical = await probeVerticalThumb(v.id);
      v.probed = true;
      v.ambiguous = false;
      if (vertical) v.isShort = true;
    }));
    onUpdate?.();
  }
}

// ---------- ricerca globale su YouTube ----------

export async function searchYouTube(query, max = 12) {
  const data = await yt('search', {
    part: 'snippet', q: query, maxResults: max, type: 'video,channel',
  });
  return (data.items || []).map((i) => {
    if (i.id?.channelId) {
      return {
        type: 'channel',
        id: i.id.channelId,
        title: i.snippet?.title || '',
        thumb: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || '',
        description: i.snippet?.description || '',
      };
    }
    return {
      type: 'video',
      id: i.id?.videoId,
      chId: i.snippet?.channelId,
      chTitle: i.snippet?.channelTitle || '',
      title: i.snippet?.title || '',
      pub: i.snippet?.publishedAt || '',
    };
  }).filter((r) => r.id);
}
