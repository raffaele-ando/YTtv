// ============================================================
// YTtv — configurazione
// ============================================================

export const APP_VERSION = '2.0.0';

// Chiave API di YouTube Data v3 (modificabile dalle Impostazioni).
// Consiglio: su Google Cloud Console limita questa chiave per referrer HTTP
// al dominio dove pubblichi il sito.
export const DEFAULT_API_KEY = 'AIzaSyB00UnUb9cI2_yV_e83eIizO5WVb5QxkQM';

// Proxy CORS usati per leggere i feed RSS di YouTube quando l'API
// non è disponibile (quota esaurita, chiave non valida, offline parziale…).
// Vengono provati in ordine; `parse` serve per i proxy che incartano la
// risposta in un JSON invece di restituire l'XML grezzo.
// Nota: corsproxy.io resta per ultimo perché sul piano gratuito risponde 403
// a tutto ciò che non è localhost, quindi non funziona sul sito pubblicato.
export const CORS_PROXIES = [
  { wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  {
    wrap: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
    parse: (text) => JSON.parse(text)?.contents || '',
  },
  { wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];

// Numero massimo di video tenuti in cache per canale.
export const MAX_CACHE_PER_CHANNEL = 60;

// Aggiornamento automatico in background (minuti).
export const AUTO_REFRESH_MINUTES = 20;
