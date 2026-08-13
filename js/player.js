// ============================================================
// YTtv — player integrato (video in stile film + shorts verticali)
// Tutto si riproduce dentro il sito, mai su youtube.com.
// ============================================================

import {
  $, esc, icon, fmtDuration, fmtViews, timeAgo,
  thumbHQ, thumbShort, thumbShortHQ, toast,
} from './utils.js';
import {
  state, isWatched, isWatchLater, markWatched, toggleWatchLater,
  saveProgress, progressOf, unwatched, logPlay, logWatch, videoInfo,
} from './store.js';

// Misura i secondi effettivamente guardati (solo mentre è in riproduzione).
function makeMeter(videoId) {
  let last = 0, playing = false;
  return {
    start() { if (!playing) { playing = true; last = Date.now(); } },
    stop() { this.flush(); playing = false; },
    flush() {
      if (!playing) return;
      const now = Date.now();
      const delta = (now - last) / 1000;
      last = now;
      if (delta >= 1) logWatch(videoId, Math.min(30, delta));
    },
  };
}

// ---------- caricamento IFrame API ----------

let ytApiPromise = null;
function loadYTApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

// ============================================================
// PLAYER VIDEO (modale cinematografica)
// ============================================================

let filmPlayer = null;
let filmTracker = null;
let filmMeter = null;
let currentVideoId = null;
let onCloseCb = null;
let filmKeyHandler = null;

function stopTracker() {
  clearInterval(filmTracker);
  filmTracker = null;
}

function trackProgress(player, videoId) {
  stopTracker();
  filmTracker = setInterval(() => {
    try {
      filmMeter?.flush();
      const t = player.getCurrentTime?.();
      const d = player.getDuration?.();
      if (t && d) saveProgress(videoId, t, d);
    } catch { /* player smontato */ }
  }, 5000);
}

export function closePlayer() {
  stopTracker();
  filmMeter?.stop();
  filmMeter = null;
  try { filmPlayer?.destroy(); } catch { /* già distrutto */ }
  filmPlayer = null;
  currentVideoId = null;
  $('#player-root').innerHTML = '';
  document.body.style.overflow = '';
  // senza questa rimozione ogni apertura del player lasciava un listener
  // "Escape" attaccato al documento per sempre
  if (filmKeyHandler) { document.removeEventListener('keydown', filmKeyHandler); filmKeyHandler = null; }
  onCloseCb?.();
  onCloseCb = null;
}

export async function openPlayer(videoId, { onClose } = {}) {
  // videoInfo copre anche i video non più in cache o arrivati da un altro
  // dispositivo (cronologia e attività recente sincronizzate)
  const v = videoInfo(videoId);
  if (!v) return;
  if (v.isShort) { openShortsPlayer([videoId], 0, { onClose }); return; }

  onCloseCb = onClose || null;
  currentVideoId = videoId;
  const ch = state.channels[v.ch];
  const root = $('#player-root');
  document.body.style.overflow = 'hidden';

  const nextUp = unwatched({ shorts: false }).filter((x) => x.id !== videoId).slice(0, 10);

  root.innerHTML = `
    <div class="player-overlay" id="film-overlay">
      <button class="player-close" id="film-close" aria-label="Chiudi player">${icon('x', 20)}</button>
      <div class="player-sheet">
        <div class="player-stage"><div id="film-stage"></div></div>
        <div class="player-info">
          <h2 class="player-title">${esc(v.title)}</h2>
          <div class="player-meta">
            ${v.views != null ? `<span>${fmtViews(v.views)} visualizzazioni</span><span>·</span>` : ''}
            <span>${timeAgo(v.pub)}</span>
            ${v.dur ? `<span>·</span><span>${fmtDuration(v.dur)}</span>` : ''}
          </div>
          <div class="player-row">
            ${ch ? `
              <a class="player-ch" href="#/channel/${ch.id}" id="film-ch">
                <img src="${esc(ch.thumb)}" alt="" loading="lazy">
                <b>${esc(ch.title)}</b>
              </a>` : ''}
            <div class="player-actions">
              <button class="btn btn-sm ${isWatched(videoId) ? 'btn-primary' : 'btn-ghost'}" id="film-watched">
                ${icon('check', 16)} ${isWatched(videoId) ? 'Visto' : 'Segna come visto'}
              </button>
              <button class="btn btn-sm btn-ghost" id="film-wl">
                ${icon('clock', 16)} ${isWatchLater(videoId) ? 'In "Dopo"' : 'Guarda dopo'}
              </button>
            </div>
          </div>
        </div>
        ${nextUp.length ? `
          <div class="player-next">
            <h4>Prossimi da vedere</h4>
            <div class="row-scroller" id="film-next">
              ${nextUp.map((n) => `
                <div class="vcard" data-next="${n.id}">
                  <div class="vcard-thumb">
                    <img src="${thumbHQ(n.id)}" alt="" loading="lazy">
                    ${n.dur ? `<span class="dur">${fmtDuration(n.dur)}</span>` : ''}
                    <div class="play-hint"><span>${icon('play', 26)}</span></div>
                  </div>
                  <div class="vcard-body">
                    <div>
                      <p class="vcard-title">${esc(n.title)}</p>
                      <div class="vcard-meta"><span class="ch-name">${esc(state.channels[n.ch]?.title || '')}</span></div>
                    </div>
                  </div>
                </div>`).join('')}
            </div>
          </div>` : ''}
      </div>
    </div>`;

  const overlay = $('#film-overlay');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePlayer(); });
  $('#film-close').addEventListener('click', closePlayer);
  $('#film-ch')?.addEventListener('click', () => closePlayer());

  $('#film-watched').addEventListener('click', (e) => {
    const now = !isWatched(videoId);
    markWatched(videoId, now);
    e.currentTarget.className = `btn btn-sm ${now ? 'btn-primary' : 'btn-ghost'}`;
    e.currentTarget.innerHTML = `${icon('check', 16)} ${now ? 'Visto' : 'Segna come visto'}`;
    toast(now ? 'Segnato come visto' : 'Segnato come da vedere');
  });
  $('#film-wl').addEventListener('click', (e) => {
    const on = toggleWatchLater(videoId);
    e.currentTarget.innerHTML = `${icon('clock', 16)} ${on ? 'In "Dopo"' : 'Guarda dopo'}`;
    toast(on ? 'Aggiunto a "Guarda dopo"' : 'Rimosso da "Guarda dopo"');
  });
  $('#film-next')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-next]');
    if (!card) return;
    closePlayer();
    openPlayer(card.dataset.next);
  });

  if (filmKeyHandler) document.removeEventListener('keydown', filmKeyHandler);
  filmKeyHandler = (e) => { if (e.key === 'Escape') closePlayer(); };
  document.addEventListener('keydown', filmKeyHandler);

  await loadYTApi();
  if (currentVideoId !== videoId || !$('#film-stage')) return;

  const resume = progressOf(videoId);
  filmMeter = makeMeter(videoId);
  let logged = false;
  filmPlayer = new YT.Player('film-stage', {
    videoId,
    playerVars: {
      autoplay: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1,
      start: resume?.t && resume.t > 10 ? resume.t : 0,
      origin: location.origin,
    },
    events: {
      onReady: (ev) => trackProgress(ev.target, videoId),
      onStateChange: (ev) => {
        if (ev.data === YT.PlayerState.PLAYING) {
          if (!logged) { logPlay(videoId); logged = true; }
          filmMeter?.start();
        } else if (ev.data === YT.PlayerState.PAUSED || ev.data === YT.PlayerState.BUFFERING) {
          filmMeter?.stop();
        } else if (ev.data === YT.PlayerState.ENDED) {
          filmMeter?.stop();
          markWatched(videoId, true);
          toast('Video completato ✓');
          if (state.settings.autoplayNext && nextUp.length) {
            closePlayer();
            openPlayer(nextUp[0].id);
          }
        }
      },
    },
  });
}

// ============================================================
// PLAYER SHORTS (verticale, immersivo, swipe)
// ============================================================

let shortsPlayer = null;
let shortsQueue = [];
let shortsIndex = 0;
let shortsCloseCb = null;
let shortsTracker = null;
let shortsKeyHandler = null;

function shortRailHTML(id) {
  const ch = state.channels[videoInfo(id)?.ch];
  return `
    <div class="shorts-rail">
      <button class="railbtn ${isWatched(id) ? 'on' : ''}" id="sh-watched">
        <span>${icon('check', 21)}</span><small>Visto</small>
      </button>
      <button class="railbtn ${isWatchLater(id) ? 'on-wl' : ''}" id="sh-wl">
        <span>${icon('clock', 21)}</span><small>Dopo</small>
      </button>
      ${ch ? `
        <button class="railbtn" id="sh-ch">
          <span style="overflow:hidden;padding:0">
            <img src="${esc(ch.thumb)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:99px">
          </span><small>Canale</small>
        </button>` : ''}
    </div>`;
}

function renderShortFrame(direction = '') {
  const id = shortsQueue[shortsIndex];
  const v = videoInfo(id);
  if (!v) { closeShortsPlayer(); return; }
  const ch = state.channels[v.ch];

  $('#shorts-backdrop-img').src = thumbHQ(id);
  $('#shorts-counter').textContent = `${shortsIndex + 1} / ${shortsQueue.length}`;
  $('#shorts-prev').disabled = shortsIndex === 0;
  $('#shorts-next-btn').disabled = shortsIndex >= shortsQueue.length - 1;

  const frame = $('#shorts-frame');
  frame.className = `shorts-frame ${direction}`;
  frame.innerHTML = `
    <div id="shorts-stage"></div>
    <div class="scrim"></div>
    <div class="shorts-caption">
      ${ch ? `
        <a class="ch" href="#/channel/${ch.id}" id="sh-caption-ch">
          <img src="${esc(ch.thumb)}" alt=""><b>${esc(ch.title)}</b>
        </a>` : ''}
      <p class="title">${esc(v.title)}</p>
      <div class="meta">${v.views != null ? `${fmtViews(v.views)} visualizzazioni · ` : ''}${timeAgo(v.pub)}</div>
    </div>
    ${shortRailHTML(id)}`;

  $('#sh-caption-ch')?.addEventListener('click', () => closeShortsPlayer());
  $('#sh-ch')?.addEventListener('click', () => {
    const chId = v.ch;
    closeShortsPlayer();
    location.hash = `#/channel/${chId}`;
  });
  $('#sh-watched').addEventListener('click', (e) => {
    const now = !isWatched(id);
    markWatched(id, now);
    e.currentTarget.classList.toggle('on', now);
  });
  $('#sh-wl').addEventListener('click', (e) => {
    const on = toggleWatchLater(id);
    e.currentTarget.classList.toggle('on-wl', on);
  });

  clearInterval(shortsTracker);
  try { shortsPlayer?.destroy(); } catch { /* ok */ }
  let logged = false;
  let stateNow = -1;
  shortsPlayer = new YT.Player('shorts-stage', {
    videoId: id,
    playerVars: {
      autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, loop: 1,
      playlist: id, controls: 1, origin: location.origin,
    },
    events: {
      onStateChange: (ev) => {
        stateNow = ev.data;
        if (ev.data === YT.PlayerState.PLAYING && !logged) { logPlay(id); logged = true; }
      },
      onReady: () => {
        // uno short si considera visto dopo 10s o al termine; nel frattempo
        // accumuliamo il tempo di visione solo mentre è effettivamente in play
        // (prima contava anche in pausa reale, in buffering o con l'autoplay
        // bloccato, gonfiando le statistiche di chi lasciava aperto il player)
        let seen = 0;
        shortsTracker = setInterval(() => {
          if (stateNow !== YT.PlayerState.PLAYING) return;
          seen += 1;
          logWatch(id, 1);
          if (seen >= 10 && !isWatched(id)) {
            markWatched(id, true);
            $('#sh-watched')?.classList.add('on');
          }
        }, 1000);
      },
    },
  });
}

function shortsGo(delta) {
  const next = shortsIndex + delta;
  if (next < 0 || next >= shortsQueue.length) return;
  shortsIndex = next;
  renderShortFrame(delta > 0 ? 'swipe-up' : 'swipe-down');
}

export function closeShortsPlayer() {
  clearInterval(shortsTracker);
  shortsTracker = null;
  try { shortsPlayer?.destroy(); } catch { /* ok */ }
  shortsPlayer = null;
  shortsQueue = [];
  shortsIndex = 0;
  $('#shorts-root').innerHTML = '';
  document.body.style.overflow = '';
  if (shortsKeyHandler) { document.removeEventListener('keydown', shortsKeyHandler); shortsKeyHandler = null; }
  shortsCloseCb?.();
  shortsCloseCb = null;
}

export async function openShortsPlayer(queue, index = 0, { onClose } = {}) {
  if (!queue.length) return;
  shortsQueue = queue;
  shortsIndex = index;
  shortsCloseCb = onClose || null;
  document.body.style.overflow = 'hidden';

  const root = $('#shorts-root');
  root.innerHTML = `
    <div class="shorts-overlay" id="shorts-overlay">
      <div class="shorts-backdrop"><img id="shorts-backdrop-img" alt=""></div>
      <div class="shorts-counter" id="shorts-counter"></div>
      <button class="player-close shorts-close" id="shorts-close" aria-label="Chiudi">${icon('x', 20)}</button>
      <div class="shorts-stage-wrap">
        <div class="shorts-frame" id="shorts-frame"></div>
        <div class="shorts-nav">
          <button id="shorts-prev" aria-label="Short precedente">${icon('up', 24)}</button>
          <button id="shorts-next-btn" aria-label="Short successivo">${icon('down', 24)}</button>
        </div>
      </div>
    </div>`;

  $('#shorts-close').addEventListener('click', closeShortsPlayer);
  $('#shorts-prev').addEventListener('click', () => shortsGo(-1));
  $('#shorts-next-btn').addEventListener('click', () => shortsGo(1));

  shortsKeyHandler = (e) => {
    if (e.key === 'Escape') closeShortsPlayer();
    if (e.key === 'ArrowUp') { e.preventDefault(); shortsGo(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); shortsGo(1); }
  };
  document.addEventListener('keydown', shortsKeyHandler);

  // swipe verticale su mobile
  let touchY = null;
  const overlay = $('#shorts-overlay');
  overlay.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    if (touchY == null) return;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dy) > 60) shortsGo(dy < 0 ? 1 : -1);
    touchY = null;
  }, { passive: true });

  // rotellina su desktop
  let wheelLock = 0;
  overlay.addEventListener('wheel', (e) => {
    const now = Date.now();
    if (now - wheelLock < 500 || Math.abs(e.deltaY) < 25) return;
    wheelLock = now;
    shortsGo(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  await loadYTApi();
  if (!$('#shorts-frame')) return;
  renderShortFrame();
}

// miniatura degli shorts con fallback progressivo
export function shortThumbHTML(id, alt = '') {
  return `<img src="${thumbShort(id)}" alt="${esc(alt)}" loading="lazy"
    onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${thumbShortHQ(id)}'}else if(this.dataset.f==1){this.dataset.f=2;this.src='${thumbHQ(id)}'}">`;
}
