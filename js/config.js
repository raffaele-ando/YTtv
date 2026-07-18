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
// Vengono provati in ordine.
export const CORS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

// Numero massimo di video tenuti in cache per canale.
export const MAX_CACHE_PER_CHANNEL = 60;

// Aggiornamento automatico in background (minuti).
export const AUTO_REFRESH_MINUTES = 20;
