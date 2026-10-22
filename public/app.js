'use strict';

// ---------- utilidades ----------

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>',
};

// ---------- sessão ----------

let sid = store.get('sid');
if (!sid || !/^[a-f0-9-]{36}$/.test(sid)) {
  sid = crypto.randomUUID ? crypto.randomUUID() : fallbackUuid();
  store.set('sid', sid);
}
function fallbackUuid() {
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

const params = new URLSearchParams(location.search);
let config = { spotify: false, youtube: false };
let state = null;
let roomCode = null;
let searchSource = 'spotify';

const socket = io({ auth: { sid } });

function call(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(15000).emit(event, payload, (err, res) => {
      if (err) return resolve({ ok: false, error: 'Sem resposta do servidor.' });
      resolve(res);
    });
  });
}

// ---------- relógio sincronizado com o servidor ----------

let clockOffset = 0;
let bestRtt = Infinity;

async function syncClock(samples = 5) {
  bestRtt = Infinity;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const serverTime = await new Promise((res) => socket.timeout(3000).emit('time', t0, (err, t) => res(err ? null : t)));
    const t1 = Date.now();
    if (serverTime == null) continue;
    const rtt = t1 - t0;
    if (rtt < bestRtt) {
      bestRtt = rtt;
      clockOffset = serverTime - (t0 + rtt / 2);
    }
  }
}
const serverNow = () => Date.now() + clockOffset;

function expectedPosition() {
  if (!state || state.index < 0) return 0;
  return state.playing ? state.positionMs + (serverNow() - state.updatedAt) : state.positionMs;
}

const currentTrack = () => (state && state.index >= 0 ? state.queue[state.index] : null);

// ---------- entrar / sair ----------

async function enterRoom(event, payload) {
  const name = $('nameInput').value.trim() || store.get('name') || 'Convidado';
  store.set('name', name);
  const res = await call(event, { ...payload, name });
  if (!res.ok) {
    $('homeError').textContent = res.error;
    $('homeError').hidden = false;
    store.del('room');
    showHome();
    return false;
  }
  roomCode = res.code;
  store.set('room', roomCode);
  history.replaceState(null, '', `/?room=${roomCode}`);
  $('roomCode').textContent = roomCode;
  $('home').hidden = true;
  $('room').hidden = false;
  return true;
}

function showHome() {
  $('room').hidden = true;
  $('home').hidden = false;
}

$('createBtn').onclick = () => enterRoom('room:create', {});
$('joinBtn').onclick = () => enterRoom('room:join', { code: $('codeInput').value.trim().toUpperCase() });
$('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinBtn').click());
$('leaveBtn').onclick = () => {
  store.del('room');
  roomCode = null;
  state = null;
  stopYoutube();
  history.replaceState(null, '', '/');
  location.reload();
};

$('shareBtn').onclick = async () => {
  const url = `${location.origin}/?room=${roomCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Jam Sync', text: `Entra na minha jam! Código ${roomCode}`, url }); } catch {}
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copiado!');
  } catch {
    toast(url);
  }
};

// ---------- conexão ----------

socket.on('connect', async () => {
  $('connDot').classList.add('on');
  await syncClock();
  const code = roomCode || params.get('room') || store.get('room');
  if (code) {
    const ok = await enterRoom('room:join', { code });
    if (ok) handleSpotifyReturn();
  }
});

socket.on('disconnect', () => $('connDot').classList.remove('on'));
socket.on('connect_error', () => $('connDot').classList.remove('on'));

setInterval(() => socket.connected && syncClock(3), 30000);

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (socket.connected) await syncClock(3);
  syncYoutube(true);
  updateWakeLock();
});

function handleSpotifyReturn() {
  const sp = params.get('spotify');
  if (!sp) return;
  params.delete('spotify');
  history.replaceState(null, '', `/?room=${roomCode}`);
  if (sp === 'ok') {
    call('platform:set', { platform: 'spotify' });
    toast('Spotify conectado!');
  } else if (sp === 'denied') toast('Autorização do Spotify cancelada.');
  else toast('Não foi possível conectar o Spotify. Tente de novo.');
}

socket.on('state', (s) => {
  state = s;
  render();
  syncYoutube(true);
  updateWakeLock();
});

// ---------- controles ----------

$('playBtn').onclick = () => {
  // O toque também serve de "gesto do usuário" para liberar o áudio do YouTube no iOS.
  if (state?.you.platform === 'youtube' && ytPlayer?.playVideo && !state.playing) ytPlayer.playVideo();
  call(state?.playing ? 'player:pause' : 'player:play');
};
$('nextBtn').onclick = () => call('player:next');
$('prevBtn').onclick = () => call('player:prev');
$('bar').onclick = (e) => {
  const t = currentTrack();
  if (!t?.durationMs) return;
  const rect = $('bar').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  call('player:seek', { ms: ratio * t.durationMs });
};

document.querySelectorAll('.listen .seg').forEach((btn) => {
  btn.onclick = async () => {
    const platform = btn.dataset.platform;
    if (platform === 'spotify' && !config.spotify) return toast('Spotify não está configurado no servidor.');
    if (platform === 'youtube' && !config.youtube) toast('Sem chave do YouTube: só faixas com link do YouTube vão tocar.');
    if (platform === 'youtube') ensureYoutubeApi();
    const res = await call('platform:set', { platform });
    if (res.needsAuth) {
      location.href = `/auth/spotify/login?sid=${encodeURIComponent(sid)}&room=${encodeURIComponent(roomCode)}`;
    } else if (!res.ok) toast(res.error);
  };
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'search') $('searchInput').focus();
  };
});

// ---------- busca ----------

function setSource(src) {
  searchSource = src;
  document.querySelectorAll('#sourceSeg .seg').forEach((b) => b.classList.toggle('active', b.dataset.source === src));
  $('sourceHint').textContent =
    src === 'youtube'
      ? 'Buscas no YouTube gastam cota da API (≈100 por dia). Prefira o Spotify ou cole um link.'
      : 'Dica: cole um link do YouTube para adicionar um vídeo direto.';
}
document.querySelectorAll('#sourceSeg .seg').forEach((b) => (b.onclick = () => setSource(b.dataset.source)));

let lastResults = [];
$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchInput').blur();
  $('searchList').innerHTML = '<li class="muted center">Buscando…</li>';
  const res = await call('search', { q, source: searchSource });
  if (!res.ok) {
    $('searchList').innerHTML = `<li class="error">${esc(res.error)}</li>`;
    return;
  }
  lastResults = res.results;
  if (!lastResults.length) {
    $('searchList').innerHTML = '<li class="muted center">Nada encontrado.</li>';
    return;
  }
  $('searchList').innerHTML = lastResults
    .map(
      (t, i) => `
      <li class="item">
        ${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div class="info">
          <div class="t">${esc(t.title)}</div>
          <div class="a">${esc(t.artist)} · ${fmt(t.durationMs)}</div>
        </div>
        <div class="actions"><button class="add-btn" data-add="${i}" aria-label="Adicionar">${ICON.plus}</button></div>
      </li>`
    )
    .join('');
};

$('searchList').onclick = async (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const track = lastResults[+btn.dataset.add];
  btn.disabled = true;
  const res = await call('queue:add', { track });
  toast(res.ok ? `“${track.title}” na fila` : res.error);
};

// ---------- fila ----------

$('queueList').onclick = async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  const action = e.target.closest('[data-act]')?.dataset.act;
  if (action === 'remove') return call('queue:remove', { trackId: id });
  if (action === 'up') return call('queue:move', { trackId: id, delta: -1 });
  if (action === 'down') return call('queue:move', { trackId: id, delta: 1 });
  if (action === 'fix') {
    const url = prompt('Cole o link do vídeo certo no YouTube:');
    if (url) {
      const res = await call('queue:fixYoutube', { trackId: id, url });
      if (!res.ok) toast(res.error);
    }
    return;
  }
  call('player:jump', { index: +li.dataset.index });
};

// ---------- render ----------

function badge(kind, on, resolving) {
  const label = kind === 'sp' ? 'Spotify' : 'YouTube';
  if (on) return `<span class="badge ${kind} on">${label}</span>`;
  if (resolving) return `<span class="badge ${kind}">${label}</span>`;
  return `<span class="badge ${kind} off">${label}</span>`;
}

function render() {
  if (!state) return;
  const t = currentTrack();

  // Tocando agora
  $('title').textContent = t ? t.title : 'Nada tocando';
  $('artist').textContent = t ? t.artist : 'Adicione músicas na aba Buscar';
  // SVG não tem a propriedade .hidden — usa o atributo.
  $('icPlay').toggleAttribute('hidden', state.playing);
  $('icPause').toggleAttribute('hidden', !state.playing);
  $('tDur').textContent = fmt(t?.durationMs);

  const showYt = state.you.platform === 'youtube' && t?.youtubeId;
  $('ytWrap').hidden = !showYt;
  $('art').hidden = showYt || !t?.art;
  if (t?.art && $('art').src !== t.art) $('art').src = t.art;

  // Plataforma
  document.querySelectorAll('.listen .seg').forEach((b) => b.classList.toggle('active', b.dataset.platform === state.you.platform));
  renderPlatformStatus(t);

  // Fila
  $('queueEmpty').hidden = state.queue.length > 0;
  $('queueList').innerHTML = state.queue
    .map((q, i) => {
      const cls = i === state.index ? 'current' : i < state.index ? 'played' : '';
      const canMove = i > state.index;
      return `
      <li class="item ${cls}" data-id="${esc(q.id)}" data-index="${i}">
        ${q.art ? `<img src="${esc(q.art)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div class="info">
          <div class="t">${esc(q.title)}</div>
          <div class="a">${esc(q.artist)}${q.addedBy ? ` · por ${esc(q.addedBy)}` : ''}</div>
          <div class="badges">
            ${badge('sp', q.spotifyUri, q.resolving)}${badge('yt', q.youtubeId, q.resolving)}
            ${q.resolving ? '<span class="spinner" title="Procurando nas plataformas"></span>' : ''}
          </div>
        </div>
        <div class="actions">
          ${canMove ? `<button data-act="up" aria-label="Subir">${ICON.up}</button><button data-act="down" aria-label="Descer">${ICON.down}</button>` : ''}
          <button data-act="fix" aria-label="Corrigir vídeo do YouTube">${ICON.link}</button>
          <button data-act="remove" aria-label="Remover">${ICON.x}</button>
        </div>
      </li>`;
    })
    .join('');

  // Pessoas
  const online = state.members.filter((m) => m.online || m.platform === 'spotify');
  $('peopleCount').textContent = online.length ? `(${online.length})` : '';
  const platformName = { spotify: 'Spotify', youtube: 'YouTube', none: 'só controlando' };
  $('peopleList').innerHTML = state.members
    .map(
      (m) => `
      <li class="item ${m.online ? '' : 'offline'}">
        <div class="avatar ${m.platform}">${esc((m.name || '?')[0].toUpperCase())}</div>
        <div class="info">
          <div class="t">${esc(m.name)}</div>
          <div class="a">${platformName[m.platform]}${m.online ? '' : ' · app fechado'}${m.spotifyError ? ` · ⚠ ${esc(m.spotifyError)}` : ''}</div>
        </div>
      </li>`
    )
    .join('');
}

function renderPlatformStatus(t) {
  const el = $('platformStatus');
  const you = state.you;
  if (you.platform === 'spotify') {
    const msg = you.spotifyError
      ? `<div class="warn">⚠ ${esc(you.spotifyError)}</div>`
      : `<div class="ok">Tocando no seu app do Spotify — pode bloquear a tela.</div>`;
    el.innerHTML = `${msg}
      <div class="status-row">
        <select id="deviceSelect"><option value="">Dispositivo ativo</option></select>
        <button class="link-btn" id="refreshDevices">Atualizar</button>
        <a class="link-btn" href="https://open.spotify.com" target="_blank" rel="noopener">Abrir Spotify</a>
      </div>
      <button class="link-btn" id="spDisconnect">Desconectar Spotify</button>`;
    $('refreshDevices').onclick = loadDevices;
    $('deviceSelect').onchange = (e) => call('spotify:device', { deviceId: e.target.value });
    $('spDisconnect').onclick = () => call('spotify:disconnect');
    fillDevices();
  } else if (you.platform === 'youtube') {
    el.innerHTML = t && !t.youtubeId && !t.resolving
      ? '<div class="warn">⚠ Esta faixa não foi encontrada no YouTube. Use o botão de link na fila para corrigir.</div>'
      : '<div class="muted">Mantenha o app aberto e a tela ligada — o YouTube para em segundo plano.</div>';
  } else {
    el.innerHTML = '';
  }
}

let devicesCache = [];
async function loadDevices() {
  const res = await call('spotify:devices');
  if (!res.ok) return toast(res.error);
  devicesCache = res.devices;
  fillDevices();
  if (!devicesCache.length) toast('Nenhum dispositivo. Abra o Spotify e toque algo.');
}
function fillDevices() {
  const sel = $('deviceSelect');
  if (!sel) return;
  const current = state.you.spotifyDeviceId || '';
  const known = devicesCache.some((d) => d.id === current);
  sel.innerHTML =
    '<option value="">Dispositivo ativo</option>' +
    (current && !known ? `<option value="${esc(current)}">Dispositivo escolhido</option>` : '') +
    devicesCache.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.type)})</option>`).join('');
  sel.value = current;
}

// Barra de progresso local (suave, sem esperar o servidor).
setInterval(() => {
  const t = currentTrack();
  if (!t) {
    $('barFill').style.width = '0';
    $('tCur').textContent = '0:00';
    return;
  }
  const pos = Math.min(expectedPosition(), t.durationMs || Infinity);
  $('tCur').textContent = fmt(pos);
  $('barFill').style.width = t.durationMs ? `${(pos / t.durationMs) * 100}%` : '0';
}, 250);

// ---------- YouTube ----------

let ytPlayer = null;
let ytReady = false;
let ytApiLoading = false;
let ytLoadedId = null;
let ytLastSeek = 0;
let ytStuckSince = 0;
let ytEverPlayed = false;

function ensureYoutubeApi() {
  if (ytApiLoading) return;
  ytApiLoading = true;
  window.onYouTubeIframeAPIReady = () => {
    ytPlayer = new YT.Player('ytPlayer', {
      width: '100%',
      height: '100%',
      playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          syncYoutube(true);
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            ytEverPlayed = true;
            $('ytHint').hidden = true;
          }
        },
        onError: (e) => toast(`O YouTube recusou este vídeo (erro ${e.data}). Corrija o link na fila.`),
      },
    });
  };
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}

function stopYoutube() {
  if (ytReady && ytLoadedId) {
    ytPlayer.stopVideo();
    ytLoadedId = null;
  }
  $('ytHint').hidden = true;
}

const DRIFT_TOLERANCE_S = 0.8;
const SEEK_COOLDOWN_MS = 3000;

function syncYoutube(force = false) {
  if (!state) return;
  if (state.you.platform !== 'youtube') return stopYoutube();
  ensureYoutubeApi();
  if (!ytReady) return;

  const t = currentTrack();
  if (!t || !t.youtubeId) return stopYoutube();

  const expected = expectedPosition() / 1000;
  const S = YT.PlayerState;

  if (ytLoadedId !== t.youtubeId) {
    ytLoadedId = t.youtubeId;
    ytLastSeek = Date.now();
    if (state.playing) ytPlayer.loadVideoById({ videoId: t.youtubeId, startSeconds: expected });
    else ytPlayer.cueVideoById({ videoId: t.youtubeId, startSeconds: expected });
    return;
  }

  const ps = ytPlayer.getPlayerState();
  const cur = ytPlayer.getCurrentTime() || 0;
  const now = Date.now();

  if (state.playing) {
    if (t.durationMs && expected * 1000 >= t.durationMs) return; // servidor já vai trocar de faixa
    if (ps !== S.PLAYING && ps !== S.BUFFERING) {
      ytPlayer.seekTo(expected, true);
      ytPlayer.playVideo();
      ytLastSeek = now;
      // Se não começa a tocar, provavelmente o navegador bloqueou o autoplay.
      if (!ytStuckSince) ytStuckSince = now;
      if (now - ytStuckSince > 1500 && !ytEverPlayed) $('ytHint').hidden = false;
      return;
    }
    ytStuckSince = 0;
    if (ps === S.PLAYING && Math.abs(cur - expected) > DRIFT_TOLERANCE_S && (force || now - ytLastSeek > SEEK_COOLDOWN_MS)) {
      // Pequeno avanço para compensar o tempo que o seek leva para bufferizar.
      ytPlayer.seekTo(expected + 0.15, true);
      ytLastSeek = now;
    }
  } else {
    ytStuckSince = 0;
    $('ytHint').hidden = true;
    if (ps === S.PLAYING || ps === S.BUFFERING) ytPlayer.pauseVideo();
    if (Math.abs(cur - expected) > DRIFT_TOLERANCE_S) ytPlayer.seekTo(expected, true);
  }
}

setInterval(() => syncYoutube(false), 1000);

// Mantém a tela ligada enquanto o YouTube toca (ele pausa com a tela apagada).
let wakeLock = null;
async function updateWakeLock() {
  const want = state?.you.platform === 'youtube' && state.playing && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

// ---------- início ----------

(async function init() {
  $('nameInput').value = store.get('name') || '';
  const code = params.get('room');
  if (code) $('codeInput').value = code;
  try {
    config = await (await fetch('/api/config')).json();
  } catch {}
  setSource(config.spotify ? 'spotify' : 'youtube');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
