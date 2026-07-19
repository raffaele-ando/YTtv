// ============================================================
// YTtv — app principale: router + viste
// ============================================================

import { AUTO_REFRESH_MINUTES, APP_VERSION } from './config.js';
import {
  $, $$, esc, icon, toast, confirmModal, debounce,
  fmtDuration, fmtViews, fmtSubs, timeAgo, isNew, thumbHQ, thumbMax,
} from './utils.js';
import {
  state, loadLocal, onChange, emit,
  channelList, addChannel, removeChannel, videosOf, allVideos,
  unwatched, continueWatching, watchLaterList, historyList,
  isWatched, isWatchLater, progressOf, markWatched, toggleWatchLater,
  refreshAll, refreshChannel, refreshStatus, searchLocal, stats,
  updateSettings, exportJSON, importJSON, resetAll,
  channelFilterInfo, isExcluded, setChannelFilter,
} from './store.js';
import { resolveChannelInput, searchChannels } from './api.js';
import { openPlayer, openShortsPlayer, shortThumbHTML } from './player.js';
import { cloud, initCloud, signIn, signOutUser, onAuthChange } from './cloud.js';
import { isFirebaseConfigured } from './firebase-config.js';

// ============================================================
// Componenti
// ============================================================

function chAvatar(chId) {
  return state.channels[chId]?.thumb || '';
}

function vcardHTML(v, { showChannel = true } = {}) {
  const watched = isWatched(v.id);
  const wl = isWatchLater(v.id);
  const prog = progressOf(v.id);
  const pct = prog && v.dur ? Math.min(100, Math.round((prog.t / v.dur) * 100)) : (prog?.d ? Math.min(100, Math.round((prog.t / prog.d) * 100)) : 0);
  const ch = state.channels[v.ch];
  return `
  <article class="vcard ${watched ? 'is-watched' : ''}" data-id="${v.id}" tabindex="0">
    <div class="vcard-thumb">
      <img src="${thumbHQ(v.id)}" alt="" loading="lazy">
      ${v.live ? '<span class="live-badge">Live</span>' : (v.dur ? `<span class="dur">${fmtDuration(v.dur)}</span>` : '')}
      ${watched ? `<span class="watched-tag">${icon('check', 13)} Visto</span>` : ''}
      <div class="play-hint"><span>${icon('play', 26)}</span></div>
      ${pct > 0 && !watched ? `<div class="progressbar"><i style="width:${pct}%"></i></div>` : ''}
      <div class="vcard-actions">
        <button class="qbtn ${watched ? 'on' : ''}" data-act="watched" title="${watched ? 'Segna da vedere' : 'Segna come visto'}">${icon('check', 16)}</button>
        <button class="qbtn ${wl ? 'on-wl' : ''}" data-act="wl" title="Guarda dopo">${icon('clock', 16)}</button>
      </div>
    </div>
    <div class="vcard-body">
      ${showChannel && ch ? `<img class="ch-avatar" src="${esc(ch.thumb)}" alt="" loading="lazy">` : ''}
      <div>
        <p class="vcard-title">${esc(v.title)}</p>
        <div class="vcard-meta">
          ${showChannel && ch ? `<a class="ch-name" href="#/channel/${ch.id}" data-stop>${esc(ch.title)}</a><span>·</span>` : ''}
          ${v.views != null ? `<span>${fmtViews(v.views)} visual.</span><span>·</span>` : ''}
          <span>${timeAgo(v.pub)}</span>
          ${isNew(v.pub) && !watched ? '<span style="color:var(--ok);font-weight:700">· Nuovo</span>' : ''}
        </div>
      </div>
    </div>
  </article>`;
}

function scardHTML(v) {
  const watched = isWatched(v.id);
  const ch = state.channels[v.ch];
  return `
  <article class="scard ${watched ? 'is-watched' : ''}" data-sid="${v.id}" tabindex="0">
    <div class="scard-thumb">
      ${shortThumbHTML(v.id, v.title)}
      <span class="s-badge">${icon('bolt', 11)} Short</span>
      ${watched ? `<span class="watched-tag">${icon('check', 13)}</span>` : ''}
      <div class="scard-info">
        <p class="scard-title">${esc(v.title)}</p>
        <div class="scard-meta">
          ${ch ? `<img src="${esc(ch.thumb)}" alt="">` : ''}
          <span>${v.views != null ? `${fmtViews(v.views)} · ` : ''}${timeAgo(v.pub)}</span>
        </div>
      </div>
    </div>
  </article>`;
}

function rowHTML(id, title, iconName, inner, { count = null, seeAll = null, shorts = false, queue = null } = {}) {
  if (!inner) return '';
  return `
  <section class="row">
    <h2 class="section-title ${shorts ? 'is-shorts' : ''}">
      ${icon(iconName, 20)} ${esc(title)}
      ${count != null ? `<span class="count">${count}</span>` : ''}
      ${seeAll ? `<a class="see-all" href="${seeAll}">Vedi tutto ${icon('right', 14)}</a>` : ''}
    </h2>
    <div style="position:relative">
      <button class="row-arrow left" data-arrow="-1" aria-label="Scorri a sinistra">${icon('left', 30)}</button>
      <div class="row-scroller ${shorts ? 'shorts-row' : ''}" id="${id}" ${queue ? `data-queue="${queue}"` : ''}>${inner}</div>
      <button class="row-arrow right" data-arrow="1" aria-label="Scorri a destra">${icon('right', 30)}</button>
    </div>
  </section>`;
}

function emptyHTML(iconName, title, text, cta = '') {
  return `
  <div class="empty">
    <div class="art">${icon(iconName, 42)}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${cta}
  </div>`;
}

function skeletonRows() {
  const card = `<div><div class="skel skel-thumb"></div><div class="skel skel-line"></div><div class="skel skel-line w60"></div></div>`;
  return `
    <div class="page">
      <div class="row-scroller" style="padding-left:0;padding-right:0">${card.repeat(5)}</div>
      <div style="height:26px"></div>
      <div class="row-scroller" style="padding-left:0;padding-right:0">${card.repeat(5)}</div>
    </div>`;
}

// ============================================================
// Viste
// ============================================================

const view = $('#view');

function renderHome() {
  const chs = channelList();
  if (!chs.length) {
    view.innerHTML = `<div class="page" style="padding-top:12vh">${emptyHTML(
      'film', 'Benvenuto su YTtv',
      'La tua TV personale con i canali YouTube che ami. Aggiungi il primo canale per iniziare: bastano il nome, il @tag o il link.',
      `<a class="btn btn-accent" href="#/channels">${icon('plus', 20)} Aggiungi un canale</a>`
    )}</div>`;
    return;
  }

  const hideWatched = state.settings.hideWatchedHome;
  const toWatch = unwatched({ shorts: false });
  const newShorts = unwatched({ shorts: true });
  const cont = continueWatching();
  const later = watchLaterList();
  const hero = toWatch[0] || allVideos({ shorts: false })[0];

  let html = '';

  if (hero) {
    const hch = state.channels[hero.ch];
    html += `
    <section class="hero">
      <div class="hero-bg">
        <img src="${thumbMax(hero.id)}" alt="" onerror="this.src='${thumbHQ(hero.id)}'">
      </div>
      <div class="hero-content">
        ${hch ? `<a class="hero-channel" href="#/channel/${hch.id}"><img src="${esc(hch.thumb)}" alt="">${esc(hch.title)}</a>` : ''}
        <h1 class="hero-title">${esc(hero.title)}</h1>
        <div class="hero-meta">
          ${isNew(hero.pub) ? '<span class="new-badge">● Nuovo</span>' : ''}
          <span>${timeAgo(hero.pub)}</span>
          ${hero.dur ? `<span>· ${fmtDuration(hero.dur)}</span>` : ''}
          ${hero.views != null ? `<span>· ${fmtViews(hero.views)} visualizzazioni</span>` : ''}
        </div>
        <div class="hero-actions">
          <button class="btn btn-primary" data-hero-play="${hero.id}">${icon('play', 20)} Riproduci</button>
          <button class="btn btn-soft" data-hero-watched="${hero.id}">${icon('check', 20)} Già visto</button>
        </div>
      </div>
    </section>`;
  } else {
    html += `<div style="height:calc(var(--topbar-h) + 10px)"></div>`;
  }

  if (cont.length) {
    html += rowHTML('row-cont', 'Continua a guardare', 'play',
      cont.slice(0, 15).map((v) => vcardHTML(v)).join(''), { count: cont.length });
  }

  if (toWatch.length) {
    const rest = toWatch.slice(1, 21);
    if (rest.length) {
      html += rowHTML('row-towatch', 'Da vedere', 'film',
        rest.map((v) => vcardHTML(v)).join(''),
        { count: toWatch.length, seeAll: '#/videos' });
    }
  }

  if (newShorts.length) {
    html += rowHTML('row-shorts', 'Shorts da vedere', 'bolt',
      newShorts.slice(0, 20).map((v) => scardHTML(v)).join(''),
      { count: newShorts.length, seeAll: '#/shorts', shorts: true, queue: newShorts.map((v) => v.id).join(',') });
  }

  if (later.length) {
    html += rowHTML('row-later', 'Guarda dopo', 'clock',
      later.slice(0, 15).map((v) => (v.isShort ? scardHTML(v) : vcardHTML(v))).join(''), { count: later.length });
  }

  // una riga per canale
  for (const ch of chs) {
    let vids = videosOf(ch.id).filter((v) => !v.isShort);
    if (hideWatched) {
      const un = vids.filter((v) => !isWatched(v.id));
      if (!un.length) continue;
      vids = un;
    }
    if (!vids.length) continue;
    html += rowHTML(`row-ch-${ch.id}`, ch.title, 'film',
      vids.slice(0, 15).map((v) => vcardHTML(v, { showChannel: false })).join(''),
      { seeAll: `#/channel/${ch.id}` });
  }

  if (!toWatch.length && !newShorts.length && !cont.length) {
    html += emptyHTML('check', 'Tutto visto!', 'Non ci sono nuovi video dai tuoi canali. Prova ad aggiornare o aggiungi altri canali.',
      `<button class="btn btn-ghost" onclick="document.getElementById('btn-refresh').click()">${icon('refresh', 18)} Aggiorna ora</button>`);
  }

  view.innerHTML = html;

  $('[data-hero-play]')?.addEventListener('click', (e) => openPlayer(e.currentTarget.dataset.heroPlay, { onClose: renderRoute }));
  $('[data-hero-watched]')?.addEventListener('click', (e) => {
    markWatched(e.currentTarget.dataset.heroWatched, true);
    toast('Segnato come visto');
    renderHome();
  });
}

// ---------------- Video ----------------

let videosFilter = { mode: 'unseen', ch: 'all' };

function renderVideos() {
  const chs = channelList();
  let list = allVideos({ shorts: false });
  if (videosFilter.ch !== 'all') list = list.filter((v) => v.ch === videosFilter.ch);
  if (videosFilter.mode === 'unseen') list = list.filter((v) => !isWatched(v.id));
  if (videosFilter.mode === 'seen') list = list.filter((v) => isWatched(v.id));
  if (videosFilter.mode === 'later') list = list.filter((v) => isWatchLater(v.id));

  view.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">Video</h1>
        <p class="page-sub">${list.length} video ${videosFilter.mode === 'unseen' ? 'da vedere' : ''}</p>
      </div>
      <button class="btn btn-ghost btn-sm" id="mark-all" ${!list.length || videosFilter.mode !== 'unseen' ? 'hidden' : ''}>${icon('check', 16)} Segna tutti come visti</button>
    </div>
    <div class="chips" id="v-chips">
      <button class="chip ${videosFilter.mode === 'unseen' ? 'active' : ''}" data-mode="unseen">Da vedere</button>
      <button class="chip ${videosFilter.mode === 'all' ? 'active' : ''}" data-mode="all">Tutti</button>
      <button class="chip ${videosFilter.mode === 'seen' ? 'active' : ''}" data-mode="seen">Visti</button>
      <button class="chip ${videosFilter.mode === 'later' ? 'active' : ''}" data-mode="later">Guarda dopo</button>
      <span style="flex:none;width:1px;background:var(--stroke);margin:4px 4px"></span>
      <button class="chip ${videosFilter.ch === 'all' ? 'active' : ''}" data-ch="all">Tutti i canali</button>
      ${chs.map((c) => `<button class="chip ${videosFilter.ch === c.id ? 'active' : ''}" data-ch="${c.id}">${esc(c.title)}</button>`).join('')}
    </div>
    ${list.length
      ? `<div class="vgrid">${list.map((v) => vcardHTML(v)).join('')}</div>`
      : emptyHTML('film', 'Nessun video qui', videosFilter.mode === 'unseen' ? 'Hai visto tutto! Aggiorna per cercare nuovi video.' : 'Cambia filtro o aggiungi altri canali.')}
  </div>`;

  $('#v-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.mode) videosFilter.mode = chip.dataset.mode;
    if (chip.dataset.ch) videosFilter.ch = chip.dataset.ch;
    renderVideos();
  });

  $('#mark-all')?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Segnare tutto come visto?',
      message: `${list.length} video verranno segnati come visti.`,
      okLabel: 'Segna tutti',
    });
    if (!ok) return;
    list.forEach((v) => markWatched(v.id, true));
    toast('Tutti i video segnati come visti');
    renderVideos();
  });
}

// ---------------- Shorts ----------------

let shortsFilter = 'unseen';

function renderShorts() {
  let list = allVideos({ shorts: true });
  if (shortsFilter === 'unseen') list = list.filter((v) => !isWatched(v.id));
  if (shortsFilter === 'seen') list = list.filter((v) => isWatched(v.id));

  view.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title" style="display:flex;align-items:center;gap:10px"><span style="color:var(--shorts)">${icon('bolt', 30)}</span> Shorts</h1>
        <p class="page-sub">${list.length} shorts ${shortsFilter === 'unseen' ? 'da vedere' : ''} · esperienza verticale, dentro il sito</p>
      </div>
      ${list.length ? `<button class="btn btn-accent btn-sm" id="shorts-playall" style="background:var(--shorts);box-shadow:0 6px 24px var(--shorts-soft)">${icon('play', 16)} Riproduci tutti</button>` : ''}
    </div>
    <div class="chips" id="s-chips">
      <button class="chip ${shortsFilter === 'unseen' ? 'active' : ''}" data-f="unseen">Da vedere</button>
      <button class="chip ${shortsFilter === 'all' ? 'active' : ''}" data-f="all">Tutti</button>
      <button class="chip ${shortsFilter === 'seen' ? 'active' : ''}" data-f="seen">Visti</button>
    </div>
    ${list.length
      ? `<div class="sgrid" data-queue="${list.map((v) => v.id).join(',')}">${list.map((v) => scardHTML(v)).join('')}</div>`
      : emptyHTML('bolt', 'Nessuno short', shortsFilter === 'unseen' ? 'Hai visto tutti gli shorts dei tuoi canali!' : 'I tuoi canali non hanno shorts recenti.')}
  </div>`;

  $('#s-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    shortsFilter = chip.dataset.f;
    renderShorts();
  });
  $('#shorts-playall')?.addEventListener('click', () => {
    openShortsPlayer(list.map((v) => v.id), 0, { onClose: renderRoute });
  });
}

// ---------------- Ricerca ----------------

let lastSearchQuery = '';

function renderSearch(query = '') {
  lastSearchQuery = query;
  view.innerHTML = `
  <div class="page">
    <div class="search-hero">
      <h1 class="page-title" style="margin-bottom:16px">Cerca</h1>
      <form class="addbox" id="search-form">
        ${icon('search', 20)}
        <input id="search-input" type="search" placeholder="Video e canali tuoi, o tutta YouTube: nome, @tag, link…" value="${esc(query)}" autocomplete="off">
        <button class="btn btn-accent btn-sm" type="submit">Cerca</button>
      </form>
      <p class="hint">Cerca tra i tuoi contenuti e su tutta YouTube. Incolla un link o un @tag per aggiungere subito un canale.</p>
      <div id="search-results"></div>
    </div>
  </div>`;

  const input = $('#search-input');
  const form = $('#search-form');
  input.focus();

  const run = debounce(() => doSearch(input.value, false), 350);
  input.addEventListener('input', run);
  form.addEventListener('submit', (e) => { e.preventDefault(); doSearch(input.value, true); });

  if (query) doSearch(query, true);
}

async function doSearch(query, includeYouTube) {
  const box = $('#search-results');
  if (!box) return;
  const q = query.trim();
  lastSearchQuery = q;
  const topInput = $('#topsearch-input');
  if (topInput && topInput.value !== q) topInput.value = q;
  if (!q) { box.innerHTML = ''; return; }

  const local = searchLocal(q);
  let html = '';

  if (local.channels.length) {
    html += `<div class="search-section"><h3>${icon('users', 17)} I tuoi canali</h3>
      <div class="result-list">${local.channels.map((c) => `
        <a class="result-item" href="#/channel/${c.id}">
          <img src="${esc(c.thumb)}" alt="">
          <div class="info"><b>${esc(c.title)}</b><span>${esc(c.handle || '')}</span></div>
          ${icon('right', 20)}
        </a>`).join('')}
      </div></div>`;
  }

  if (local.videos.length) {
    html += `<div class="search-section"><h3>${icon('film', 17)} Nei tuoi video</h3>
      <div class="vgrid">${local.videos.slice(0, 12).map((v) => vcardHTML(v)).join('')}</div></div>`;
  }

  const ytBoxId = 'yt-global-results';
  html += `<div class="search-section"><h3>${icon('search', 17)} Su YouTube</h3><div id="${ytBoxId}">
    ${includeYouTube ? `<div class="skel" style="height:70px;border-radius:14px"></div>` : `<button class="btn btn-ghost" id="btn-yt-search">${icon('search', 18)} Cerca "${esc(q)}" su YouTube</button>`}
  </div></div>`;

  box.innerHTML = html;
  $('#btn-yt-search')?.addEventListener('click', () => doSearch(q, true));

  if (!includeYouTube) return;

  const ytBox = $(`#${ytBoxId}`);
  try {
    // input tipo link/@tag → risoluzione diretta canale
    const looksDirect = q.startsWith('@') || /youtube\.com|^UC[\w-]{22}$/.test(q);
    let results;
    if (looksDirect) {
      const r = await resolveChannelInput(q);
      results = r.kind === 'channel' ? [{ ...r.channel, type: 'channel' }] : r.results.map((c) => ({ ...c, type: 'channel' }));
    } else {
      results = (await searchChannels(q, 8)).map((c) => ({ ...c, type: 'channel' }));
    }
    if (lastSearchQuery !== q || !$(`#${ytBoxId}`)) return;
    if (!results.length) {
      ytBox.innerHTML = `<p class="hint">Nessun canale trovato su YouTube per "${esc(q)}".</p>`;
      return;
    }
    ytBox.innerHTML = `<div class="result-list">${results.map((c) => `
      <div class="result-item">
        <img src="${esc(c.thumb)}" alt="">
        <div class="info"><b>${esc(c.title)}</b><span>${esc(c.handle || c.description || '')}${c.subs != null ? ` · ${fmtSubs(c.subs)}` : ''}</span></div>
        ${state.channels[c.id]
          ? `<span class="badge-ok">${icon('check', 14)} Aggiunto</span>`
          : `<button class="btn btn-accent btn-sm" data-add-ch="${c.id}">${icon('plus', 16)} Aggiungi</button>`}
      </div>`).join('')}</div>`;

    ytBox.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-add-ch]');
      if (!btn) return;
      const chData = results.find((r) => r.id === btn.dataset.addCh);
      if (!chData) return;
      btn.disabled = true;
      btn.textContent = 'Aggiungo…';
      await addChannelFlow(chData);
      btn.outerHTML = `<span class="badge-ok">${icon('check', 14)} Aggiunto</span>`;
    });
  } catch (err) {
    if ($(`#${ytBoxId}`)) {
      ytBox.innerHTML = `<p class="hint" style="color:#ff6961">Ricerca YouTube non disponibile: ${esc(err.message)}. I contenuti locali restano consultabili.</p>`;
    }
  }
}

// ---------------- Canali ----------------

async function addChannelFlow(channel) {
  const added = addChannel(channel);
  if (!added) { toast('Canale già presente'); return; }
  toast(`Aggiunto: ${channel.title}`);
  try {
    await refreshChannel(channel);
    emit();
    toast(`${videosOf(channel.id).length} video caricati da ${channel.title}`);
  } catch (e) {
    toast(`Canale aggiunto, ma non riesco a leggere i video: ${e.message}`, 'err');
  }
}

function renderChannels() {
  const chs = channelList();
  view.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">I tuoi canali</h1>
        <p class="page-sub">${chs.length} ${chs.length === 1 ? 'canale seguito' : 'canali seguiti'}</p>
      </div>
    </div>
    <form class="addbox" id="add-form">
      ${icon('plus', 20)}
      <input id="add-input" type="text" placeholder="Aggiungi canale: nome, @tag o link YouTube…" autocomplete="off">
      <button class="btn btn-accent btn-sm" type="submit">Aggiungi</button>
    </form>
    <p class="hint">Esempi: <b>@breakingitaly</b> · <b>youtube.com/@marcomontemagno</b> · <b>Geopop</b></p>
    <div id="add-results"></div>
    ${chs.length
      ? `<div class="chgrid" style="margin-top:10px">${chs.map((c) => {
          const vids = videosOf(c.id);
          const unseen = vids.filter((v) => !isWatched(v.id)).length;
          const shorts = vids.filter((v) => v.isShort).length;
          const hiddenCount = videosOf(c.id, { includeExcluded: true }).length - vids.length;
          const filterOn = Boolean(channelFilterInfo(c) || c.noShorts);
          return `
          <div class="chcard" data-chid="${c.id}">
            <div class="chcard-top" data-open>
              <img src="${esc(c.thumb)}" alt="" loading="lazy">
              <div>
                <h3 class="chcard-name">${esc(c.title)}</h3>
                <div class="chcard-handle">${esc(c.handle || '')}${c.subs != null ? ` · ${fmtSubs(c.subs)}` : ''}</div>
              </div>
            </div>
            <div class="chcard-stats">
              ${unseen ? `<span class="unseen">${unseen} da vedere</span>` : `<span>Tutto visto ✓</span>`}
              <span>${vids.length - shorts} video</span>
              <span>${shorts} shorts</span>
              ${filterOn ? `<span style="color:var(--warn)" title="Questo canale ha filtri attivi${hiddenCount ? `: ${hiddenCount} contenuti nascosti` : ''}">${icon('filter', 11)} filtro${hiddenCount ? ` · ${hiddenCount} nascosti` : ''}</span>` : ''}
              ${c.lastSource === 'rss' ? `<span title="Ultimo aggiornamento via feed RSS">RSS</span>` : ''}
            </div>
            <div class="chcard-actions">
              <button class="btn btn-ghost btn-sm" data-open style="flex:1">${icon('play', 16)} Apri</button>
              <button class="btn ${filterOn ? 'btn-accent' : 'btn-ghost'} btn-sm" data-filter title="Filtri: scegli quali contenuti vedere">${icon('filter', 16)}</button>
              <button class="btn btn-ghost btn-sm" data-refresh title="Aggiorna canale">${icon('refresh', 16)}</button>
              <button class="btn btn-danger btn-sm" data-remove title="Rimuovi canale">${icon('trash', 16)}</button>
            </div>
          </div>`;
        }).join('')}</div>`
      : emptyHTML('users', 'Nessun canale ancora', 'Aggiungi i canali YouTube che vuoi seguire: controllerò io quando pubblicano nuovi video e shorts.')}
  </div>`;

  const form = $('#add-form');
  const input = $('#add-input');
  const resultsBox = $('#add-results');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    resultsBox.innerHTML = `<div class="skel" style="height:70px;border-radius:14px;margin-bottom:16px"></div>`;
    try {
      const r = await resolveChannelInput(q);
      if (r.kind === 'channel') {
        resultsBox.innerHTML = '';
        input.value = '';
        await addChannelFlow(r.channel);
        renderChannels();
      } else {
        if (!r.results.length) {
          resultsBox.innerHTML = `<p class="hint" style="color:#ff6961">Nessun canale trovato per "${esc(q)}".</p>`;
          return;
        }
        resultsBox.innerHTML = `<div class="result-list" style="margin-bottom:20px">${r.results.map((c) => `
          <div class="result-item">
            <img src="${esc(c.thumb)}" alt="">
            <div class="info"><b>${esc(c.title)}</b><span>${esc(c.handle || '')}${c.subs != null ? ` · ${fmtSubs(c.subs)}` : ''}</span></div>
            ${state.channels[c.id]
              ? `<span class="badge-ok">${icon('check', 14)} Aggiunto</span>`
              : `<button class="btn btn-accent btn-sm" data-pick="${c.id}">${icon('plus', 16)} Aggiungi</button>`}
          </div>`).join('')}</div>`;
        resultsBox.onclick = async (ev) => {
          const btn = ev.target.closest('[data-pick]');
          if (!btn) return;
          const ch = r.results.find((x) => x.id === btn.dataset.pick);
          btn.disabled = true;
          await addChannelFlow(ch);
          renderChannels();
        };
      }
    } catch (err) {
      resultsBox.innerHTML = `<p class="hint" style="color:#ff6961">${esc(err.message)}</p>`;
    }
  });

  // il listener va sul contenitore appena creato, non su #view (che è permanente)
  $('.chgrid')?.addEventListener('click', channelCardHandler);
}

async function channelCardHandler(e) {
  const card = e.target.closest('.chcard');
  if (!card) return;
  const id = card.dataset.chid;
  const ch = state.channels[id];
  if (!ch) return;

  if (e.target.closest('[data-remove]')) {
    const ok = await confirmModal({
      title: `Rimuovere ${ch.title}?`,
      message: 'Il canale e i suoi video spariranno dalla tua TV. La cronologia dei visti resta salvata.',
      okLabel: 'Rimuovi', danger: true,
    });
    if (ok) { removeChannel(id); toast(`Rimosso: ${ch.title}`); renderChannels(); }
    return;
  }
  if (e.target.closest('[data-filter]')) {
    openFilterEditor(ch, renderChannels);
    return;
  }
  if (e.target.closest('[data-refresh]')) {
    const btn = e.target.closest('[data-refresh]');
    btn.classList.add('spin');
    try {
      const src = await refreshChannel(ch);
      emit();
      toast(`${ch.title} aggiornato (${src === 'api' ? 'API' : 'feed RSS'})`);
    } catch (err) { toast(`Errore: ${err.message}`, 'err'); }
    renderChannels();
    return;
  }
  if (e.target.closest('[data-open]')) {
    location.hash = `#/channel/${id}`;
  }
}

// ---------------- Filtri per canale ----------------
// Es.: di un canale che pubblica più rubriche/podcast, tieni solo quella che
// vuoi seguire. Le regole si applicano da sole anche ai video futuri.

function openFilterEditor(ch, onSaved) {
  const all = videosOf(ch.id, { includeExcluded: true });
  const f = ch.filters || { mode: 'all', terms: [] };
  const root = $('#modal-root');

  root.innerHTML = `
  <div class="modal-overlay" id="flt-overlay">
    <div class="modal-card" style="width:min(540px,100%)">
      <h3>${icon('filter', 19)} Filtri per ${esc(ch.title)}</h3>
      <p>Scegli cosa vedere di questo canale. I contenuti esclusi spariscono da Home, Video, Shorts e contatori — automaticamente, anche per i video futuri.</p>
      <div class="field">
        <label for="flt-mode">Modalità</label>
        <select id="flt-mode">
          <option value="all" ${!channelFilterInfo(ch) ? 'selected' : ''}>Mostra tutto il canale</option>
          <option value="include" ${f.mode === 'include' ? 'selected' : ''}>Mostra SOLO i contenuti che corrispondono</option>
          <option value="exclude" ${f.mode === 'exclude' ? 'selected' : ''}>NASCONDI i contenuti che corrispondono</option>
        </select>
      </div>
      <div class="field" id="flt-terms-field" ${!channelFilterInfo(ch) ? 'style="opacity:.45"' : ''}>
        <label for="flt-terms">Parole nel titolo (separate da virgola)</label>
        <input type="text" id="flt-terms" value="${esc((f.terms || []).join(', '))}" placeholder="es. Podcast, Ep., Ci pensiamo lunedì">
        <div class="note">Confronto sul titolo, maiuscole/minuscole indifferenti. Basta che una parola corrisponda.</div>
      </div>
      <div class="switch-row">
        <div class="sw-label"><b>Nascondi tutti gli Shorts del canale</b><span>Utile se di questo canale vuoi solo i video lunghi</span></div>
        <label class="switch"><input type="checkbox" id="flt-noshorts" ${ch.noShorts ? 'checked' : ''}><i></i></label>
      </div>
      <p class="hint" id="flt-preview" style="margin:12px 0 16px"></p>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" id="flt-cancel">Annulla</button>
        <button class="btn btn-primary btn-sm" id="flt-save">${icon('check', 16)} Salva filtri</button>
      </div>
    </div>
  </div>`;

  const modeEl = $('#flt-mode');
  const termsEl = $('#flt-terms');
  const noShortsEl = $('#flt-noshorts');

  const readForm = () => ({
    mode: modeEl.value,
    terms: termsEl.value.split(',').map((t) => t.trim()).filter(Boolean),
    noShorts: noShortsEl.checked,
  });

  const preview = () => {
    const { mode, terms, noShorts } = readForm();
    $('#flt-terms-field').style.opacity = mode === 'all' ? '.45' : '1';
    const lower = terms.map((t) => t.toLowerCase());
    const visible = all.filter((v) => {
      if (noShorts && v.isShort) return false;
      if (mode === 'all' || !lower.length) return true;
      const m = lower.some((k) => v.title.toLowerCase().includes(k));
      return mode === 'include' ? m : !m;
    });
    const hidden = all.length - visible.length;
    $('#flt-preview').innerHTML = hidden
      ? `Anteprima sugli ultimi ${all.length} contenuti in cache: <b style="color:var(--text)">${visible.length} visibili</b> · <b style="color:#ff6961">${hidden} nascosti</b>`
      : `Anteprima: tutti i ${all.length} contenuti in cache resterebbero visibili.`;
  };
  preview();

  modeEl.addEventListener('change', preview);
  termsEl.addEventListener('input', preview);
  noShortsEl.addEventListener('change', preview);

  const close = () => { root.innerHTML = ''; };
  $('#flt-overlay').addEventListener('click', (e) => { if (e.target.id === 'flt-overlay') close(); });
  $('#flt-cancel').addEventListener('click', close);
  $('#flt-save').addEventListener('click', () => {
    setChannelFilter(ch.id, readForm());
    close();
    toast('Filtri salvati: si applicano da soli anche ai prossimi video');
    onSaved?.();
  });
}

// ---------------- Dettaglio canale ----------------

let chDetailTab = 'videos';

function renderChannelDetail(chId) {
  const ch = state.channels[chId];
  if (!ch) { location.hash = '#/channels'; return; }
  const everything = videosOf(chId, { includeExcluded: true });
  const hidden = everything.filter((v) => isExcluded(v));
  const vids = videosOf(chId).filter((v) => !v.isShort);
  const shorts = videosOf(chId).filter((v) => v.isShort);
  const unseen = [...vids, ...shorts].filter((v) => !isWatched(v.id)).length;
  if (chDetailTab === 'hidden' && !hidden.length) chDetailTab = 'videos';
  const list = chDetailTab === 'videos' ? vids : shorts;
  const filterOn = Boolean(channelFilterInfo(ch) || ch.noShorts);

  view.innerHTML = `
  <div class="page" style="padding-left:0;padding-right:0;padding-top:0">
    <div class="ch-hero">
      <div class="ch-hero-banner">${ch.banner ? `<img src="${esc(ch.banner)}" alt="">` : `<img src="${esc(ch.thumb)}" alt="">`}</div>
      <div class="ch-hero-inner">
        <img src="${esc(ch.thumb)}" alt="">
        <div>
          <h1>${esc(ch.title)}</h1>
          <div class="meta">
            ${ch.handle ? `<span>${esc(ch.handle)}</span>` : ''}
            ${ch.subs != null ? `<span>${fmtSubs(ch.subs)}</span>` : ''}
            ${unseen ? `<span style="color:var(--accent-hi);font-weight:700">${unseen} da vedere</span>` : '<span style="color:var(--ok)">Tutto visto ✓</span>'}
            ${ch.lastFetch ? `<span>agg. ${timeAgo(ch.lastFetch)}</span>` : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn ${filterOn ? 'btn-accent' : 'btn-ghost'} btn-sm" id="chd-filter">${icon('filter', 16)} Filtri${filterOn ? ' attivi' : ''}</button>
          <button class="btn btn-ghost btn-sm" id="chd-refresh">${icon('refresh', 16)} Aggiorna</button>
          <button class="btn btn-ghost btn-sm" id="chd-markall">${icon('check', 16)} Tutto visto</button>
        </div>
      </div>
    </div>
    <div style="padding:20px var(--page-x) 0">
      <div class="chips">
        <button class="chip ${chDetailTab === 'videos' ? 'active' : ''}" data-tab="videos">${icon('film', 15)} Video <span style="opacity:.6">${vids.length}</span></button>
        <button class="chip ${chDetailTab === 'shorts' ? 'active' : ''}" data-tab="shorts">${icon('bolt', 15)} Shorts <span style="opacity:.6">${shorts.length}</span></button>
        ${hidden.length ? `<button class="chip ${chDetailTab === 'hidden' ? 'active' : ''}" data-tab="hidden">${icon('eyeoff', 15)} Nascosti dal filtro <span style="opacity:.6">${hidden.length}</span></button>` : ''}
      </div>
      ${chDetailTab === 'hidden'
        ? `<p class="hint" style="margin-top:0">Questi contenuti sono esclusi dalle regole del filtro: non compaiono in Home, nei contatori né tra i "da vedere". Modifica i filtri per recuperarli.</p>
           ${hidden.filter((v) => !v.isShort).length ? `<div class="vgrid" style="margin-bottom:26px">${hidden.filter((v) => !v.isShort).map((v) => vcardHTML(v, { showChannel: false })).join('')}</div>` : ''}
           ${hidden.filter((v) => v.isShort).length ? `<div class="sgrid" data-queue="${hidden.filter((v) => v.isShort).map((v) => v.id).join(',')}">${hidden.filter((v) => v.isShort).map((v) => scardHTML(v)).join('')}</div>` : ''}`
        : (list.length
            ? (chDetailTab === 'videos'
                ? `<div class="vgrid">${list.map((v) => vcardHTML(v, { showChannel: false })).join('')}</div>`
                : `<div class="sgrid" data-queue="${list.map((v) => v.id).join(',')}">${list.map((v) => scardHTML(v)).join('')}</div>`)
            : emptyHTML(chDetailTab === 'videos' ? 'film' : 'bolt', 'Niente qui',
                filterOn && everything.length
                  ? 'I filtri attivi nascondono tutti i contenuti di questa sezione. Controlla la scheda "Nascosti dal filtro".'
                  : `Questo canale non ha ${chDetailTab === 'videos' ? 'video' : 'shorts'} recenti in cache.`))}
    </div>
  </div>`;

  $$('.chip[data-tab]').forEach((c) => c.addEventListener('click', () => {
    chDetailTab = c.dataset.tab;
    renderChannelDetail(chId);
  }));
  $('#chd-filter').addEventListener('click', () => openFilterEditor(ch, () => renderChannelDetail(chId)));
  $('#chd-refresh').addEventListener('click', async (e) => {
    e.currentTarget.classList.add('spin');
    try {
      const src = await refreshChannel(ch);
      toast(`Aggiornato (${src === 'api' ? 'API' : 'RSS'})`);
    } catch (err) { toast(err.message, 'err'); }
    renderChannelDetail(chId);
  });
  $('#chd-markall').addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Tutto visto?', message: `Tutti i contenuti di ${ch.title} verranno segnati come visti.`, okLabel: 'Conferma' });
    if (!ok) return;
    [...vids, ...shorts].forEach((v) => markWatched(v.id, true));
    toast('Canale segnato come tutto visto');
    renderChannelDetail(chId);
  });
}

// ---------------- Profilo ----------------

function renderProfile() {
  const s = stats();
  const hist = historyList(40);
  const configured = isFirebaseConfigured();
  const u = cloud.user;

  view.innerHTML = `
  <div class="page">
    <h1 class="page-title" style="margin-bottom:20px">Profilo</h1>

    <div class="profile-hero">
      ${u?.photo ? `<img class="pic" src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : `<div class="pic-fallback">${icon('user', 40)}</div>`}
      <div>
        <h2>${u ? esc(u.name) : 'Ospite'}</h2>
        <div class="mail">${u ? esc(u.email) : 'Accedi con Google per sincronizzare tutto su ogni dispositivo'}</div>
        <div class="syncline ${u ? 'on' : ''}">
          <span class="led"></span>
          ${u
            ? `Sync cloud attivo${cloud.lastSync ? ` · ${timeAgo(cloud.lastSync)}` : ''}`
            : configured ? 'Solo su questo dispositivo' : 'Cloud non configurato · vedi Impostazioni'}
        </div>
      </div>
      <div class="actions">
        ${u
          ? `<button class="btn btn-ghost btn-sm" id="prof-logout">Esci</button>`
          : configured
            ? `<button class="btn btn-google" id="prof-login"><svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg> Accedi con Google</button>`
            : `<a class="btn btn-ghost btn-sm" href="#/settings">${icon('gear', 16)} Configura il cloud</a>`}
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><div class="num">${s.channels}</div><div class="lbl">Canali</div></div>
      <div class="stat-card accent"><div class="num">${s.toWatch}</div><div class="lbl">Video da vedere</div></div>
      <div class="stat-card shorts"><div class="num">${s.toWatchShorts}</div><div class="lbl">Shorts da vedere</div></div>
      <div class="stat-card ok"><div class="num">${s.watchedVideos}</div><div class="lbl">Video visti</div></div>
      <div class="stat-card ok"><div class="num">${s.watchedShorts}</div><div class="lbl">Shorts visti</div></div>
      <div class="stat-card"><div class="num">${s.hours}</div><div class="lbl">Ore guardate</div></div>
    </div>

    <h2 class="section-title" style="margin-left:0">${icon('clock', 20)} Cronologia</h2>
    ${hist.length
      ? `<div class="history-list">${hist.map((h) => `
          <div class="history-item" data-hist="${h.id}">
            <div class="th ${h.video.isShort ? 'vertical' : ''}">
              ${h.video.isShort ? shortThumbHTML(h.id) : `<img src="${thumbHQ(h.id)}" alt="" loading="lazy">`}
            </div>
            <div class="info">
              <b>${esc(h.video.title)}</b>
              <span>${esc(state.channels[h.video.ch]?.title || '')} · visto ${timeAgo(h.at)}${h.video.isShort ? ' · Short' : ''}</span>
            </div>
            <button class="qbtn" data-unwatch title="Segna come non visto">${icon('x', 16)}</button>
          </div>`).join('')}</div>`
      : `<p class="hint">Ancora niente: quello che guardi comparirà qui (e su tutti i tuoi dispositivi).</p>`}
  </div>`;

  $('#prof-login')?.addEventListener('click', async () => {
    try { await signIn(); } catch (e) { toast(e.message, 'err'); }
  });
  $('#prof-logout')?.addEventListener('click', async () => {
    await signOutUser();
    toast('Sei uscito. I dati restano su questo dispositivo.');
    renderProfile();
  });

  $('.history-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    if (e.target.closest('[data-unwatch]')) {
      markWatched(item.dataset.hist, false);
      toast('Segnato come da vedere');
      renderProfile();
      return;
    }
    openPlayer(item.dataset.hist, { onClose: renderRoute });
  });
}

// ---------------- Impostazioni ----------------

function renderSettings() {
  const st = state.settings;
  const configured = isFirebaseConfigured();

  view.innerHTML = `
  <div class="page">
    <h1 class="page-title" style="margin-bottom:20px">Impostazioni</h1>
    <div class="settings-grid">

      <div class="setting-card">
        <h3>${icon('key', 19)} YouTube Data API</h3>
        <p>La chiave API serve per cercare canali e leggere durate, visualizzazioni e shorts. Se non funziona, uso automaticamente i feed RSS.</p>
        <div class="field">
          <label for="set-apikey">Chiave API</label>
          <input type="password" id="set-apikey" value="${esc(st.apiKey)}" placeholder="Lascia vuoto per usare la chiave integrata">
          <div class="note">Suggerimento: su Google Cloud Console limita la chiave al dominio del sito (restrizione per referrer HTTP).</div>
        </div>
        <div class="field">
          <label for="set-max">Video per canale ad ogni aggiornamento</label>
          <input type="number" id="set-max" min="5" max="50" value="${st.maxPerChannel}">
        </div>
        <button class="btn btn-primary btn-sm" id="save-api">Salva</button>
      </div>

      <div class="setting-card">
        <h3>${icon('cloud', 19)} Cloud e account Google</h3>
        ${configured
          ? `<p>Firebase configurato <span class="badge-ok">✓</span> — accedi dal Profilo per sincronizzare canali, visti e preferenze su tutti i dispositivi, in tempo reale.</p>
             ${cloud.user ? `<p>Connesso come <b>${esc(cloud.user.email)}</b> <span class="badge-ok">sync attivo</span></p>` : ''}
             ${cloud.error ? `<p class="badge-err">Errore sync: ${esc(cloud.error)}</p>` : ''}`
          : `<p><span class="badge-warn">Cloud non ancora configurato.</span> Il sito funziona comunque: tutto viene salvato su questo dispositivo. Per il login Google e la sincronizzazione multi-dispositivo servono 5 minuti:</p>
             <ol style="color:var(--text-2);font-size:13.5px;line-height:1.9;margin:0 0 14px;padding-left:20px">
               <li>Crea un progetto gratuito su <b>console.firebase.google.com</b></li>
               <li>Aggiungi una App Web e copia la configurazione</li>
               <li>Incollala nel file <b>js/firebase-config.js</b> del sito</li>
               <li>Abilita <b>Authentication → Google</b> e crea un database <b>Firestore</b></li>
             </ol>
             <p>Le istruzioni complete (con le regole di sicurezza) sono nel file stesso e nel README.</p>`}
      </div>

      <div class="setting-card">
        <h3>${icon('gear', 19)} Esperienza</h3>
        <div class="switch-row">
          <div class="sw-label"><b>Aggiornamento automatico</b><span>Controlla nuovi video ogni ${AUTO_REFRESH_MINUTES} minuti mentre il sito è aperto</span></div>
          <label class="switch"><input type="checkbox" id="set-autorefresh" ${st.autoRefresh ? 'checked' : ''}><i></i></label>
        </div>
        <div class="switch-row">
          <div class="sw-label"><b>Riproduzione continua</b><span>Al termine di un video parte il prossimo da vedere</span></div>
          <label class="switch"><input type="checkbox" id="set-autoplay" ${st.autoplayNext ? 'checked' : ''}><i></i></label>
        </div>
        <div class="switch-row">
          <div class="sw-label"><b>Nascondi i visti in Home</b><span>Le righe dei canali mostrano solo i video da vedere</span></div>
          <label class="switch"><input type="checkbox" id="set-hidewatched" ${st.hideWatchedHome ? 'checked' : ''}><i></i></label>
        </div>
      </div>

      <div class="setting-card">
        <h3>${icon('download', 19)} I tuoi dati</h3>
        <p>Esporta un backup completo (canali, visti, guarda dopo, impostazioni) o importalo su un altro dispositivo.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" id="btn-export">${icon('download', 16)} Esporta backup</button>
          <button class="btn btn-ghost btn-sm" id="btn-import">${icon('upload', 16)} Importa backup</button>
          <input type="file" id="import-file" accept="application/json" hidden>
          <button class="btn btn-danger btn-sm" id="btn-reset">${icon('trash', 16)} Azzera tutto</button>
        </div>
      </div>

      <div class="setting-card">
        <h3>${icon('info', 19)} Info</h3>
        <p>YTtv v${APP_VERSION} — la tua TV personale per YouTube.<br>
        Fonte dati: YouTube Data API v3 con fallback automatico sui feed RSS ufficiali ${icon('rss', 13)}.<br>
        Ultimo aggiornamento contenuti: ${state.meta.lastRefresh ? timeAgo(state.meta.lastRefresh) : 'mai'}.</p>
      </div>
    </div>
  </div>`;

  $('#save-api').addEventListener('click', () => {
    updateSettings({
      apiKey: $('#set-apikey').value.trim(),
      maxPerChannel: Math.max(5, Math.min(50, +$('#set-max').value || 25)),
    });
    toast('Impostazioni salvate');
  });
  $('#set-autorefresh').addEventListener('change', (e) => updateSettings({ autoRefresh: e.target.checked }));
  $('#set-autoplay').addEventListener('change', (e) => updateSettings({ autoplayNext: e.target.checked }));
  $('#set-hidewatched').addEventListener('change', (e) => updateSettings({ hideWatchedHome: e.target.checked }));

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yttv-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup esportato');
  });
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      importJSON(await file.text());
      toast('Backup importato e unito ai dati attuali');
      renderSettings();
    } catch (err) { toast(`Import fallito: ${err.message}`, 'err'); }
  });
  $('#btn-reset').addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Azzerare tutto?',
      message: 'Canali, cronologia e impostazioni su questo dispositivo verranno eliminati. Non tocca i dati già nel cloud.',
      okLabel: 'Azzera', danger: true,
    });
    if (ok) { resetAll(); toast('Dati azzerati'); location.hash = '#/home'; }
  });
}

// ============================================================
// Router
// ============================================================

const routes = {
  home: renderHome,
  videos: renderVideos,
  shorts: renderShorts,
  search: () => renderSearch(lastSearchQuery),
  channels: renderChannels,
  profile: renderProfile,
  settings: renderSettings,
};

let currentRoute = 'home';

function renderRoute() {
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, param] = hash.split('/');
  currentRoute = name;

  $$('.topnav a, .tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });

  window.scrollTo({ top: 0 });

  if (name === 'channel' && param) { renderChannelDetail(param); return; }
  (routes[name] || renderHome)();
}

// ============================================================
// Interazioni globali
// ============================================================

// click su card video/shorts + azioni rapide (delegato)
document.addEventListener('click', (e) => {
  // link dentro le card non devono aprire il player
  if (e.target.closest('[data-stop]')) { e.stopPropagation(); return; }

  const arrowBtn = e.target.closest('[data-arrow]');
  if (arrowBtn) {
    const scroller = arrowBtn.parentElement.querySelector('.row-scroller');
    scroller?.scrollBy({ left: scroller.clientWidth * 0.85 * +arrowBtn.dataset.arrow, behavior: 'smooth' });
    return;
  }

  const qbtn = e.target.closest('.qbtn[data-act]');
  if (qbtn) {
    const card = qbtn.closest('[data-id]');
    if (!card) return;
    const id = card.dataset.id;
    if (qbtn.dataset.act === 'watched') {
      const now = !isWatched(id);
      markWatched(id, now);
      toast(now ? 'Segnato come visto' : 'Segnato come da vedere');
      renderRoute();
    } else if (qbtn.dataset.act === 'wl') {
      const on = toggleWatchLater(id);
      toast(on ? 'Aggiunto a "Guarda dopo"' : 'Rimosso da "Guarda dopo"');
      renderRoute();
    }
    return;
  }

  const scard = e.target.closest('.scard[data-sid]');
  if (scard) {
    const container = scard.closest('[data-queue]');
    const queue = container ? container.dataset.queue.split(',') : [scard.dataset.sid];
    const idx = Math.max(0, queue.indexOf(scard.dataset.sid));
    openShortsPlayer(queue, idx, { onClose: renderRoute });
    return;
  }

  const vcard = e.target.closest('.vcard[data-id]');
  if (vcard && !e.target.closest('a')) {
    openPlayer(vcard.dataset.id, { onClose: renderRoute });
  }
});

// tastiera: invio su card focalizzata
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const card = document.activeElement;
  if (card?.matches?.('.vcard[data-id]')) openPlayer(card.dataset.id, { onClose: renderRoute });
  if (card?.matches?.('.scard[data-sid]')) card.click();
});

// topbar: sfondo su scroll
window.addEventListener('scroll', () => {
  $('#topbar').classList.toggle('scrolled', window.scrollY > 24);
}, { passive: true });

// ricerca dalla topbar
const topSearchInput = $('#topsearch-input');
$('#topsearch').addEventListener('submit', (e) => e.preventDefault());
topSearchInput.addEventListener('input', debounce(() => {
  const q = topSearchInput.value;
  lastSearchQuery = q;
  if (currentRoute !== 'search') location.hash = '#/search';
  else {
    const pageInput = $('#search-input');
    if (pageInput && pageInput.value !== q) { pageInput.value = q; }
    doSearchFromTop(q);
  }
}, 350));
topSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    lastSearchQuery = topSearchInput.value;
    if (currentRoute !== 'search') location.hash = '#/search';
  }
});
function doSearchFromTop(q) {
  const pageInput = $('#search-input');
  if (pageInput) pageInput.dispatchEvent(new Event('input'));
}

// aggiorna
const refreshBtn = $('#btn-refresh');
refreshBtn.addEventListener('click', async () => {
  if (refreshStatus.running) return;
  if (!channelList().length) { toast('Aggiungi prima un canale', 'err'); return; }
  refreshBtn.classList.add('spin');
  const res = await refreshAll();
  refreshBtn.classList.remove('spin');
  const newCount = unwatched({}).length;
  if (res.errors.length) {
    toast(`Aggiornato con ${res.errors.length} ${res.errors.length === 1 ? 'errore' : 'errori'} (${res.errors[0].channel})`, 'err');
  } else {
    toast(`Aggiornato · ${newCount} contenuti da vedere`);
  }
  renderRoute();
});

// menu avatar
const avatarBtn = $('#btn-avatar');
const avatarMenu = $('#avatar-menu');
avatarBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  avatarMenu.hidden = !avatarMenu.hidden;
  if (!avatarMenu.hidden) refreshAvatarMenu();
});
document.addEventListener('click', (e) => {
  if (!avatarMenu.hidden && !e.target.closest('.avatar-menu')) avatarMenu.hidden = true;
});

function refreshAvatarMenu() {
  const head = $('#avatar-menu-head');
  const authBtn = $('#menu-auth-btn');
  const u = cloud.user;
  if (u) {
    head.innerHTML = `<div class="name">${esc(u.name)}</div><div class="mail">${esc(u.email)}</div>`;
    authBtn.innerHTML = `${icon('x', 17)} Esci`;
    authBtn.onclick = async () => { await signOutUser(); avatarMenu.hidden = true; toast('Sei uscito'); };
  } else {
    head.innerHTML = `<div class="name">Ospite</div><div class="mail">${isFirebaseConfigured() ? 'Accedi per il sync multi-dispositivo' : 'Dati salvati su questo dispositivo'}</div>`;
    if (isFirebaseConfigured()) {
      authBtn.innerHTML = `${icon('user', 17)} Accedi con Google`;
      authBtn.onclick = async () => {
        avatarMenu.hidden = true;
        try { await signIn(); } catch (err) { toast(err.message, 'err'); }
      };
    } else {
      authBtn.innerHTML = `${icon('cloud', 17)} Configura il cloud`;
      authBtn.onclick = () => { avatarMenu.hidden = true; location.hash = '#/settings'; };
    }
  }
}

function updateAvatarButton() {
  const u = cloud.user;
  avatarBtn.innerHTML = u?.photo
    ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar-fallback">${icon('user', 20)}</span>`;
}

// ============================================================
// Avvio
// ============================================================

async function boot() {
  loadLocal();
  window.addEventListener('hashchange', renderRoute);

  if (!location.hash) location.hash = '#/home';
  renderRoute();

  onChange((what) => {
    // ridisegna quando arrivano dati da altri dispositivi o si affinano gli shorts
    if (['remote-merge', 'shorts-refined', 'auth'].includes(what)) {
      updateAvatarButton();
      renderRoute();
    }
  });

  onAuthChange((u) => {
    updateAvatarButton();
    if (u) toast(`Ciao ${u.name.split(' ')[0]}! Sync cloud attivo`);
  });

  initCloud();

  // primo caricamento / aggiornamento automatico in background
  const chs = channelList();
  if (chs.length) {
    const stale = Date.now() - (state.meta.lastRefresh || 0) > 5 * 60 * 1000;
    if (stale) {
      refreshBtn.classList.add('spin');
      await refreshAll();
      refreshBtn.classList.remove('spin');
      renderRoute();
    }
  }

  setInterval(() => {
    if (state.settings.autoRefresh && !document.hidden && channelList().length) {
      refreshAll().then(() => renderRoute());
    }
  }, AUTO_REFRESH_MINUTES * 60 * 1000);
}

boot();
