'use strict';

// ---------- utilidades ----------

const $ = (id) => document.getElementById(id);

// localStorage com reserva em sessionStorage (Safari privado, armazenamento bloqueado etc.).
const store = {
  get(k) {
    try { const v = localStorage.getItem(k); if (v != null) return v; } catch {}
    try { return sessionStorage.getItem(k); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch {}
    try { sessionStorage.setItem(k, v); } catch {}
  },
  del(k) {
    try { localStorage.removeItem(k); } catch {}
    try { sessionStorage.removeItem(k); } catch {}
  },
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
  toastTimer = setTimeout(() => (el.hidden = true), 3600);
}

const ICON = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/></svg>',
};

// ---------- sessão ----------

const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fallbackUuid() {
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
  );
}

// crypto.randomUUID só existe em contexto seguro (https/localhost); no IP da rede local usa a reserva.
let sid = store.get('sid');
if (!sid || !SID_RE.test(sid)) {
  sid = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : fallbackUuid();
}
store.set('sid', sid);

const params = new URLSearchParams(location.search);
let config = { spotify: false, youtube: false, spotifySetup: { needed: false, redirectUri: '', canSetup: false } };
let state = null;
let roomCode = null;
let searchSource = 'spotify';

const socket = io({ auth: { sid } });

function call(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(15000).emit(event, payload, (err, res) => {
      if (err) return resolve({ ok: false, error: 'Sem resposta do servidor.' });
      resolve(res || { ok: false, error: 'Resposta inválida do servidor.' });
    });
  });
}

// ---------- configuração do servidor ----------

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const c = await res.json();
    config = {
      spotify: !!c.spotify,
      youtube: !!c.youtube,
      spotifySetup: { needed: false, redirectUri: '', canSetup: false, ...(c.spotifySetup || {}) },
    };
  } catch {}
  renderHome();
  setSource(config.spotify ? 'spotify' : 'youtube');
  return config;
}
const configReady = loadConfig();

function renderHome() {
  const sp = config.spotify;
  const setup = config.spotifySetup || {};
  $('createSpotifyBtn').hidden = !sp;
  $('joinSpotifyBtn').hidden = !sp;
  $('createBtn').classList.toggle('primary', !sp);
  $('createBtn').textContent = sp ? 'Criar jam sem Spotify (YouTube)' : 'Criar uma jam';
  $('setupCard').hidden = !(setup.needed && setup.canSetup);
  $('spotifyNotice').hidden = !(setup.needed && !setup.canSetup);
  $('redirectUri').textContent = setup.redirectUri || `${location.origin}/auth/spotify/callback`;
}

$('copyRedirectBtn').onclick = async () => {
  const text = $('redirectUri').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Endereço copiado!');
  } catch {
    // Sem clipboard (http na rede local): seleciona o texto para copiar manualmente.
    const range = document.createRange();
    range.selectNodeContents($('redirectUri'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selecionado — copie com Ctrl+C / Cmd+C.');
  }
};

$('setupForm').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('setupError');
  err.hidden = true;
  const id = $('clientIdInput').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    err.textContent = 'O Client ID tem 32 letras e números (0-9, a-f). Confira se copiou o Client ID, não o Secret.';
    err.hidden = false;
    return;
  }
  $('saveSetupBtn').disabled = true;
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyClientId: id }),
    });
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok || !body.ok) {
      err.textContent =
        body.error ||
        (res.status === 403
          ? 'Só dá para configurar pelo próprio computador do servidor (ou ele já foi configurado).'
          : res.status === 400
            ? 'Client ID inválido.'
            : 'Não foi possível salvar. Tente de novo.');
      err.hidden = false;
    } else {
      toast('Spotify configurado! Agora é só criar a jam.');
      $('clientIdInput').value = '';
    }
  } catch {
    err.textContent = 'Sem conexão com o servidor.';
    err.hidden = false;
  }
  $('saveSetupBtn').disabled = false;
  await loadConfig();
};

// ---------- relógio sincronizado com o servidor ----------

let clockOffset = 0;
let clockSynced = false;

// Estima a diferença de relógio pela amostra de menor ida-e-volta (evento 'time').
async function syncClock(samples = 5) {
  let best = Infinity;
  let offset = null;
  for (let i = 0; i < samples; i++) {
    if (!socket.connected) break;
    const t0 = Date.now();
    const serverTime = await new Promise((res) => socket.timeout(3000).emit('time', t0, (err, t) => res(err ? null : t)));
    const t1 = Date.now();
    if (typeof serverTime !== 'number') continue;
    const rtt = t1 - t0;
    if (rtt < best) {
      best = rtt;
      offset = serverTime - (t0 + rtt / 2);
    }
  }
  if (offset != null) {
    clockOffset = offset;
    clockSynced = true;
  }
}
const serverNow = () => Date.now() + clockOffset;

function expectedPosition() {
  if (!state || state.index < 0) return 0;
  return state.playing ? state.positionMs + (serverNow() - state.updatedAt) : state.positionMs;
}

const currentTrack = () => (state && state.index >= 0 ? state.queue[state.index] : null);

// ---------- entrar / sair ----------

function getName() {
  const name = $('nameInput').value.trim() || store.get('name') || 'Convidado';
  store.set('name', name);
  return name;
}

function showHomeError(msg) {
  $('homeError').textContent = msg;
  $('homeError').hidden = !msg;
}

async function enterRoom(event, payload) {
  const res = await call(event, { ...payload, name: getName() });
  if (!res.ok) {
    showHomeError(res.error || 'Não foi possível entrar na sala.');
    store.del('room');
    roomCode = null;
    state = null;
    stopYoutube();
    showHome();
    return false;
  }
  roomCode = res.code;
  store.set('room', roomCode);
  history.replaceState(null, '', `/?room=${encodeURIComponent(roomCode)}`);
  $('roomCode').textContent = roomCode;
  showHomeError('');
  $('home').hidden = true;
  $('room').hidden = false;
  if (state) {
    render();
    syncYoutube(true);
  }
  return true;
}

function showHome() {
  $('room').hidden = true;
  $('home').hidden = false;
}

function readCode() {
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) {
    showHomeError('Digite o código da sala.');
    $('codeInput').focus();
    return null;
  }
  return code;
}

// Leva para o login do Spotify; o servidor devolve intent/name/room no retorno.
function spotifyLogin({ intent, room }) {
  const name = getName();
  store.set('pendingAuth', JSON.stringify({ intent, room: room || '', name, at: Date.now() }));
  const q = new URLSearchParams({ sid, intent });
  if (room) q.set('room', room);
  if (name) q.set('name', name);
  location.href = `/auth/spotify/login?${q}`;
}

let busy = false;
async function once(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; }
}

$('createBtn').onclick = () =>
  once(async () => {
    ensureYoutubeApi(); // aproveita o toque para já carregar o player
    if (await enterRoom('room:create', {})) await selectPlatform('youtube');
  });

$('joinBtn').onclick = () =>
  once(async () => {
    const code = readCode();
    if (!code) return;
    ensureYoutubeApi();
    if (await enterRoom('room:join', { code })) await selectPlatform('youtube');
  });

$('createSpotifyBtn').onclick = () => {
  if (!config.spotify) return toast('O Spotify ainda não foi configurado neste servidor.');
  spotifyLogin({ intent: 'create' });
};

$('joinSpotifyBtn').onclick = () =>
  once(async () => {
    if (!config.spotify) return toast('O Spotify ainda não foi configurado neste servidor.');
    const code = readCode();
    if (!code) return;
    // Entra antes de sair para o login: valida o código e guarda o lugar na sala.
    const res = await call('room:join', { code, name: getName() });
    if (!res.ok) return showHomeError(res.error || 'Sala não encontrada.');
    store.set('room', res.code);
    spotifyLogin({ intent: 'join', room: res.code });
  });

$('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinBtn').click();
});

$('leaveBtn').onclick = () => {
  store.del('room');
  store.del('pendingAuth');
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

let booted = false;

socket.on('connect', async () => {
  $('connDot').classList.add('on');
  await syncClock();
  if (!booted) {
    booted = true;
    await boot();
    return;
  }
  // Reconexão: volta para a mesma sala com o mesmo sid e o mesmo nome.
  if (roomCode) await enterRoom('room:join', { code: roomCode });
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

async function boot() {
  await configReady;
  const sp = params.get('spotify');
  if (sp) return handleSpotifyReturn(sp);

  const linkRoom = (params.get('room') || '').trim().toUpperCase();
  const saved = (store.get('room') || '').toUpperCase();
  if (linkRoom && linkRoom !== saved) {
    // Link de convite: deixa a pessoa escolher nome e onde ouvir.
    showInvite(linkRoom);
    return;
  }
  const code = linkRoom || saved;
  if (code) await enterRoom('room:join', { code });
}

function showInvite(code) {
  $('codeInput').value = code;
  $('joinLabel').textContent = `Você foi convidado para a jam ${code}`;
  if (!$('nameInput').value) $('nameInput').focus();
}

const SPOTIFY_MSG = {
  denied: 'Login no Spotify cancelado. Tente de novo ou entre ouvindo pelo YouTube.',
  expired: 'O login do Spotify demorou demais e expirou. Toque no botão de novo.',
  error: 'Não foi possível conectar ao Spotify agora. Tente de novo em instantes.',
};

function readPendingAuth() {
  let p = null;
  try { p = JSON.parse(store.get('pendingAuth') || 'null'); } catch {}
  store.del('pendingAuth');
  if (!p || typeof p !== 'object' || Date.now() - (p.at || 0) > 20 * 60 * 1000) return {};
  return p;
}

async function handleSpotifyReturn(sp) {
  const pending = readPendingAuth();
  const intent = params.get('intent') || pending.intent || '';
  const name = params.get('name') || pending.name || '';
  if (name) {
    $('nameInput').value = name;
    store.set('name', name);
  }
  let room = (params.get('room') || pending.room || '').trim().toUpperCase();
  if (!room && intent !== 'create') room = (store.get('room') || '').toUpperCase();

  if (sp === 'ok') {
    let ok = false;
    if (intent === 'create' && !room) ok = await enterRoom('room:create', {});
    else if (room) ok = await enterRoom('room:join', { code: room });
    else {
      history.replaceState(null, '', '/');
      toast('Spotify conectado! Crie uma jam ou entre com um código.');
      return;
    }
    if (!ok) return; // enterRoom já mostrou o erro e limpou a URL
    const res = await call('platform:set', { platform: 'spotify' });
    if (res.ok && !res.needsAuth) toast('Spotify conectado! A música vai tocar no seu app do Spotify.');
    else toast(res.error || 'O Spotify não confirmou o login. Tente de novo.');
    return;
  }

  const msg = SPOTIFY_MSG[sp] || SPOTIFY_MSG.error;
  if (intent === 'create' || intent === 'join' || !room) {
    // Fica na tela inicial para tentar de novo ou seguir pelo YouTube.
    history.replaceState(null, '', room ? `/?room=${encodeURIComponent(room)}` : '/');
    if (room) showInvite(room);
    showHomeError(msg);
    return;
  }
  // Veio de dentro da sala (troca de plataforma): volta para ela.
  if (await enterRoom('room:join', { code: room })) toast(msg);
}

// Obs.: o servidor emite o primeiro 'state' antes do ack de room:join/create chegar,
// então não dá para descartar estados enquanto roomCode ainda é null.
socket.on('state', (s) => {
  if (!clockSynced && typeof s.serverNow === 'number') clockOffset = s.serverNow - Date.now();
  state = s;
  render();
  syncYoutube(true);
  updateWakeLock();
});

// ---------- controles ----------

$('playBtn').onclick = () => {
  if (!state) return;
  if (state.you.platform === 'youtube' && ytPlayer?.playVideo) {
    // O toque também serve de "gesto do usuário" para liberar o áudio do YouTube (iOS/Chrome).
    if (state.playing && ytBlocked()) {
      // A sala já está tocando, só este aparelho está mudo: libera o som em vez de pausar todo mundo.
      unlockYoutube();
      return;
    }
    if (!state.playing) ytPlayer.playVideo();
  }
  call(state.playing ? 'player:pause' : 'player:play');
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

async function selectPlatform(platform) {
  if (platform === 'spotify' && !config.spotify) return toast('O Spotify ainda não foi configurado neste servidor.');
  if (platform === 'youtube') {
    ensureYoutubeApi();
    if (!config.youtube) toast('Sem chave do YouTube no servidor: só faixas com link do YouTube vão tocar.');
  }
  const res = await call('platform:set', { platform });
  if (res.needsAuth) spotifyLogin({ intent: 'join', room: roomCode });
  else if (!res.ok) toast(res.error);
}

document.querySelectorAll('.listen .seg').forEach((btn) => {
  btn.onclick = () => selectPlatform(btn.dataset.platform);
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
  document.querySelectorAll('#sourceSeg .seg').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === src);
    b.setAttribute('aria-pressed', String(b.dataset.source === src));
  });
  $('sourceHint').textContent =
    src === 'youtube'
      ? config.spotify && config.youtubeMode === 'api'
        ? 'Buscas no YouTube gastam cota da API (≈100 por dia). Prefira o Spotify ou cole um link.'
        : 'Dica: cole um link do YouTube para adicionar um vídeo direto.'
      : 'Dica: cole um link do YouTube para adicionar um vídeo direto.';
}
document.querySelectorAll('#sourceSeg .seg').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.source === 'spotify' && !config.spotify) return toast('O Spotify ainda não foi configurado neste servidor.');
    setSource(b.dataset.source);
  };
});

let lastResults = [];
$('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchInput').blur();
  $('searchList').innerHTML = '<li class="muted center">Buscando…</li>';
  const res = await call('search', { q, source: searchSource });
  if (!res.ok) {
    const needsLogin = /conecte o spotify/i.test(res.error || '');
    $('searchList').innerHTML = `<li class="error" id="searchError">
        <div>${esc(res.error)}</div>
        ${needsLogin
          ? `<div class="status-row" style="justify-content:center">
               <button class="btn spotify-btn small" id="searchConnectBtn" type="button">Conectar Spotify</button>
               <button class="btn small" id="searchYoutubeBtn" type="button">Buscar no YouTube</button>
             </div>`
          : ''}
      </li>`;
    if (needsLogin) {
      $('searchConnectBtn').onclick = () => spotifyLogin({ intent: 'join', room: roomCode });
      $('searchYoutubeBtn').onclick = () => {
        setSource('youtube');
        $('searchForm').requestSubmit();
      };
    }
    return;
  }
  lastResults = res.results || [];
  if (!lastResults.length) {
    $('searchList').innerHTML = '<li class="muted center">Nada encontrado.</li>';
    return;
  }
  $('searchList').innerHTML = lastResults
    .map(
      (t, i) => `
      <li class="item result" data-result-index="${i}">
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
  if (!track) return;
  btn.disabled = true;
  const res = await call('queue:add', { track });
  if (!res.ok) btn.disabled = false;
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
  $('playBtn').dataset.playing = String(!!state.playing);
  $('playBtn').setAttribute('aria-label', state.playing ? 'Pausar' : 'Tocar');
  $('tDur').textContent = fmt(t?.durationMs);

  const showYt = !!(state.you.platform === 'youtube' && t?.youtubeId);
  $('ytWrap').hidden = !showYt;
  $('art').hidden = showYt || !t?.art;
  if (t?.art && $('art').src !== t.art) $('art').src = t.art;

  // Plataforma
  document.querySelectorAll('.listen .seg').forEach((b) => {
    const on = b.dataset.platform === state.you.platform;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  renderPlatformStatus(t);

  // Fila
  $('queueEmpty').hidden = state.queue.length > 0;
  $('queueList').innerHTML = state.queue
    .map((q, i) => {
      const cls = i === state.index ? 'current' : i < state.index ? 'played' : '';
      const canMove = i > state.index;
      return `
      <li class="item ${cls}" data-id="${esc(q.id)}" data-track-id="${esc(q.id)}" data-index="${i}">
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
        <div class="avatar ${esc(m.platform)}">${esc((m.name || '?')[0].toUpperCase())}</div>
        <div class="info">
          <div class="t">${esc(m.name)}</div>
          <div class="a">${platformName[m.platform] || ''}${m.online ? '' : ' · app fechado'}${m.spotifyError ? ` · ⚠ ${esc(m.spotifyError)}` : ''}</div>
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
    const account = you.spotifyAccount ? `<div class="muted">Conectado como <b>${esc(you.spotifyAccount)}</b></div>` : '';
    // Não recria o seletor de dispositivo a cada atualização (fecharia o menu aberto).
    if (el.dataset.mode === 'spotify' && $('deviceSelect')) {
      el.querySelector('.sp-msg').innerHTML = msg + account;
      if (document.activeElement !== $('deviceSelect')) fillDevices();
      return;
    }
    el.dataset.mode = 'spotify';
    el.innerHTML = `<div class="sp-msg">${msg}${account}</div>
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
    return;
  }
  el.dataset.mode = you.platform;
  if (you.platform === 'youtube') {
    if (ON_IP_HOST) {
      const alt = location.hostname === '127.0.0.1' || location.hostname === '[::1]' ? `${location.protocol}//localhost:${location.port}${location.pathname}${location.search}` : null;
      el.innerHTML = `<div class="warn">⚠ O YouTube não toca em páginas abertas por endereço IP (${esc(location.hostname)}).
        ${alt ? `Abra por <a class="link-btn" href="${esc(alt)}">localhost</a>.` : 'Use o endereço com nome (https://…).'}</div>`;
    } else if (t && !t.youtubeId && t.resolving) el.innerHTML = '<div class="muted">Procurando esta faixa no YouTube…</div>';
    else if (t && !t.youtubeId) el.innerHTML = '<div class="warn">⚠ Esta faixa não foi encontrada no YouTube. Use o botão de link na fila para corrigir.</div>';
    else el.innerHTML = '<div class="muted">Mantenha o app aberto e a tela ligada — o YouTube para em segundo plano.</div>';
  } else {
    el.innerHTML = '';
  }
}

let devicesCache = [];
async function loadDevices() {
  const res = await call('spotify:devices');
  if (!res.ok) return toast(res.error);
  devicesCache = res.devices || [];
  fillDevices();
  if (!devicesCache.length) toast('Nenhum dispositivo. Abra o Spotify e toque algo.');
}
function fillDevices() {
  const sel = $('deviceSelect');
  if (!sel || !state) return;
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
let ytLoadedKey = null; // faixa (id da fila + vídeo) carregada no player
let ytCuedAt = 0; // posição (s) usada no último cue com a sala pausada
let ytErrorKey = null; // faixa que o YouTube recusou — não insiste nela
let ytLastCmd = 0; // último seek/play/load enviado
let ytStuckSince = 0; // desde quando deveria estar tocando e não está

// O player embutido do YouTube recusa (erro 150) qualquer vídeo quando a página é aberta por IP.
const ON_IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(location.hostname);

// O Spotify fica a ~0,1s da sala; acima de 0,2s a diferença entre os dois já dá para ouvir.
const DRIFT_TOLERANCE_S = 0.2;
const SEEK_COOLDOWN_MS = 3000;
const RETRY_PLAY_MS = 1500;
const BLOCKED_HINT_MS = 2500;

function ensureYoutubeApi() {
  if (ytApiLoading) return;
  ytApiLoading = true;
  const create = () => {
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
            ytStuckSince = 0;
            $('ytHint').hidden = true;
          }
        },
        onError: (e) => {
          if (ytErrorKey === ytLoadedKey) return;
          ytErrorKey = ytLoadedKey;
          $('ytHint').hidden = true;
          const [trackId, youtubeId] = String(ytLoadedKey || '').split(':');
          if (ON_IP_HOST) {
            // Recusa causada pelo endereço da página, não pelo vídeo: não descarta o vídeo para a sala.
            render();
          } else if ([100, 101, 150].includes(e.data) && trackId && youtubeId) {
            // Vídeo bloqueado fora do youtube.com (comum em gravadoras): o servidor troca por outro.
            toast('Este vídeo não pode tocar aqui. Procurando outra versão no YouTube…');
            call('queue:youtubeFailed', { trackId, youtubeId, code: e.data });
          } else {
            toast(`O YouTube recusou este vídeo (erro ${e.data}). Corrija o link na fila.`);
          }
        },
      },
    });
  };
  if (window.YT && window.YT.Player) return create();
  window.onYouTubeIframeAPIReady = create;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.onerror = () => {
    ytApiLoading = false; // tenta de novo na próxima sincronização
    s.remove();
  };
  document.head.appendChild(s);
}

function stopYoutube() {
  if (ytReady && ytLoadedKey) ytPlayer.stopVideo();
  ytLoadedKey = null;
  ytStuckSince = 0;
  $('ytHint').hidden = true;
}

// Sala tocando, mas o player deste aparelho não sai do lugar (autoplay bloqueado).
function ytBlocked() {
  if (!ytReady || !ytLoadedKey) return false;
  const ps = ytPlayer.getPlayerState();
  return ps !== YT.PlayerState.PLAYING && ps !== YT.PlayerState.BUFFERING;
}

// Precisa rodar dentro de um toque do usuário.
function unlockYoutube() {
  if (!ytReady) return;
  try { ytPlayer.unMute(); } catch {}
  ytPlayer.seekTo(expectedPosition() / 1000, true);
  ytPlayer.playVideo();
  ytLastCmd = Date.now();
}
$('ytHint').onclick = unlockYoutube;

function syncYoutube(force = false) {
  if (!state || !roomCode) return;
  if (state.you.platform !== 'youtube') return stopYoutube();
  ensureYoutubeApi();
  if (!ytReady) return;

  const t = currentTrack();
  if (!t || !t.youtubeId) return stopYoutube(); // sem vídeo (ou ainda resolvendo): espera o próximo 'state'

  const S = YT.PlayerState;
  const key = `${t.id}:${t.youtubeId}`;
  const expected = Math.max(0, expectedPosition() / 1000);
  const now = Date.now();

  // Troca de faixa (ou a faixa ganhou/mudou o youtubeId): carrega já na posição certa.
  if (key !== ytLoadedKey) {
    ytLoadedKey = key;
    ytErrorKey = null;
    ytLastCmd = now;
    ytStuckSince = state.playing ? now : 0;
    $('ytHint').hidden = true;
    if (state.playing) ytPlayer.loadVideoById({ videoId: t.youtubeId, startSeconds: expected });
    else {
      ytPlayer.cueVideoById({ videoId: t.youtubeId, startSeconds: expected });
      ytCuedAt = expected;
    }
    return;
  }
  if (ytErrorKey === key) return;

  const ps = ytPlayer.getPlayerState();
  const cur = ytPlayer.getCurrentTime() || 0;
  const dur = ytPlayer.getDuration() || 0;

  if (state.playing) {
    // Fim da faixa (no Spotify ou no vídeo): o servidor é quem troca; não fica reiniciando o vídeo.
    if ((t.durationMs && expected * 1000 >= t.durationMs - 300) || (dur > 1 && expected >= dur - 0.5)) {
      ytStuckSince = 0;
      $('ytHint').hidden = true;
      return;
    }
    if (ps === S.PLAYING) {
      ytStuckSince = 0;
      $('ytHint').hidden = true;
      const cooldown = force ? 1000 : SEEK_COOLDOWN_MS;
      if (Math.abs(cur - expected) > DRIFT_TOLERANCE_S && now - ytLastCmd > cooldown) {
        // Pequeno avanço para compensar o tempo que o seek leva para bufferizar.
        ytPlayer.seekTo(expected + 0.15, true);
        ytLastCmd = now;
      }
      return;
    }
    if (ps === S.BUFFERING) return;
    // Pausado / parado / cued / terminou: tenta tocar, sem martelar enquanto carrega.
    if (!ytStuckSince) ytStuckSince = now;
    if (now - ytLastCmd > RETRY_PLAY_MS) {
      if (Math.abs(cur - expected) > DRIFT_TOLERANCE_S) ytPlayer.seekTo(expected, true);
      ytPlayer.playVideo();
      ytLastCmd = now;
    }
    // Se não começa a tocar, o navegador bloqueou o autoplay (iOS): pede um toque.
    $('ytHint').hidden = now - ytStuckSince < BLOCKED_HINT_MS;
  } else {
    ytStuckSince = 0;
    $('ytHint').hidden = true;
    if (ps === S.PLAYING || ps === S.BUFFERING) {
      ytPlayer.pauseVideo();
      ytLastCmd = now;
      return;
    }
    if (ps === S.PAUSED) {
      // seekTo com o player pausado continua pausado.
      if (Math.abs(cur - expected) > DRIFT_TOLERANCE_S) ytPlayer.seekTo(expected, true);
    } else if (Math.abs(ytCuedAt - expected) > DRIFT_TOLERANCE_S) {
      // Em CUED/UNSTARTED/ENDED o seekTo começaria a tocar: re-cue na nova posição.
      ytPlayer.cueVideoById({ videoId: t.youtubeId, startSeconds: expected });
      ytCuedAt = expected;
    }
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

(function init() {
  $('nameInput').value = params.get('name') || store.get('name') || '';
  const code = params.get('room');
  if (code) $('codeInput').value = code.toUpperCase();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
