// Integração com a Spotify Web API.
// - Login de cada participante: Authorization Code + PKCE (S256), feito pelo servidor.
//   Só o Client ID é necessário; nenhum client secret é enviado na troca de código nem no refresh.
// - Busca: token do próprio usuário (ou de alguém da sala). Client Credentials só como
//   fallback, e só se SPOTIFY_CLIENT_SECRET existir.
// URLs base e DATA_DIR são lidas a cada chamada (permite mocks nos testes).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  // Cápsula sonora
  'user-top-read',
  'user-read-recently-played',
];
const STATS_SCOPES = ['user-top-read', 'user-read-recently-played'];
const TOP_RANGES = ['short_term', 'medium_term', 'long_term'];
const SEARCH_MAX_LIMIT = 10; // limite da Web API em dev mode (fev/2026)
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const NEED_LOGIN_MSG = 'Conecte o Spotify para buscar no catálogo do Spotify.';

const trimSlash = (s) => String(s).replace(/\/+$/, '');
const accountsBase = () => trimSlash(process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com');
const apiBase = () => trimSlash(process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1');
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const configFile = () => path.join(dataDir(), 'config.json');
const tokensFile = () => path.join(dataDir(), 'spotify-tokens.json');

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- configuração (Client ID) ----------

let configCache = { file: null, mtimeMs: -1, data: {} };
function readConfig() {
  const file = configFile();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (configCache.file !== file || configCache.mtimeMs !== mtimeMs) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      data = {};
    }
    configCache = { file, mtimeMs, data };
  }
  return configCache.data;
}

function clientId() {
  const fromEnv = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  if (fromEnv) return fromEnv;
  const fromFile = readConfig().spotifyClientId;
  return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : null;
}

const clientSecret = () => (process.env.SPOTIFY_CLIENT_SECRET || '').trim() || null;

function isConfigured() {
  return Boolean(clientId());
}

function hasSecret() {
  return Boolean(clientId() && clientSecret());
}

function isValidClientId(id) {
  return typeof id === 'string' && CLIENT_ID_RE.test(id);
}

function saveClientId(id) {
  if (!isValidClientId(id)) throw new Error('Client ID inválido: precisa ter 32 caracteres hexadecimais.');
  const current = { ...readConfig() };
  current.spotifyClientId = id.toLowerCase();
  writeJsonAtomic(configFile(), current);
  configCache = { file: null, mtimeMs: -1, data: {} };
}

// ---------- PKCE ----------

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64)); // 86 caracteres (43–128 permitidos)
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authorizeUrl({ state, codeChallenge, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  return `${accountsBase()}/authorize?${params}`;
}

// Requisição ao endpoint de token. Sem header Authorization, exceto Client Credentials.
async function tokenRequest(params, { basicAuth = false } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (basicAuth) {
    headers.Authorization = 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
  }
  let res;
  try {
    res = await fetch(`${accountsBase()}/api/token`, { method: 'POST', headers, body: new URLSearchParams(params) });
  } catch (err) {
    throw new Error(`Não foi possível falar com o Spotify (${err.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Spotify recusou o login: ${body.error_description || body.error || res.status}`);
  }
  return body;
}

// ---------- token do app (fallback de busca, só com secret) ----------

let appToken = null;
async function getAppToken() {
  if (appToken && appToken.clientId === clientId() && appToken.expiresAt > Date.now() + 30_000) return appToken.value;
  const body = await tokenRequest({ grant_type: 'client_credentials' }, { basicAuth: true });
  appToken = { value: body.access_token, clientId: clientId(), expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
  return appToken.value;
}

// ---------- tokens dos usuários (persistidos em DATA_DIR) ----------

let store = { file: null, tokens: {} };
function tokens() {
  const file = tokensFile();
  if (store.file !== file) {
    let loaded = {};
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      loaded = {};
    }
    store = { file, tokens: loaded };
  }
  return store.tokens;
}

function persistTokens() {
  try {
    writeJsonAtomic(store.file || tokensFile(), tokens());
  } catch (err) {
    console.error('Falha ao salvar tokens do Spotify:', err.message);
  }
}

async function handleCallback(sid, code, { codeVerifier, redirectUri }) {
  const body = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId(),
    code_verifier: codeVerifier,
  });
  tokens()[sid] = {
    access: body.access_token,
    refresh: body.refresh_token || null,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
    clientId: clientId(),
    scope: body.scope || '',
  };
  persistTokens();
  accountName(sid).catch(() => {});
}

function isConnected(sid) {
  return Boolean(sid && tokens()[sid]);
}

function disconnect(sid) {
  if (!tokens()[sid]) return;
  delete tokens()[sid];
  persistTokens();
}

const refreshing = new Map(); // sid -> Promise (evita dois refresh simultâneos do mesmo token)

async function getUserToken(sid) {
  const t = tokens()[sid];
  if (!t) return null;
  if (t.expiresAt > Date.now() + 30_000) return t.access;
  if (refreshing.has(sid)) return refreshing.get(sid);
  const p = (async () => {
    if (!t.refresh) {
      disconnect(sid);
      throw new Error('Sessão do Spotify expirou. Entre com o Spotify de novo.');
    }
    try {
      const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() });
      t.access = body.access_token;
      if (body.refresh_token) t.refresh = body.refresh_token;
      if (body.scope) t.scope = body.scope;
      t.expiresAt = Date.now() + (body.expires_in || 3600) * 1000;
      persistTokens();
      return t.access;
    } catch (err) {
      disconnect(sid);
      throw new Error('Sessão do Spotify expirou. Entre com o Spotify de novo.');
    }
  })();
  refreshing.set(sid, p);
  try {
    return await p;
  } finally {
    refreshing.delete(sid);
  }
}

// Token para busca/resolver: primeiro sid conectado da lista → Client Credentials (se houver secret) → erro.
async function searchToken(candidateSids = []) {
  if (!isConfigured()) throw new Error('O Spotify não está configurado neste servidor.');
  const seen = new Set();
  for (const sid of candidateSids) {
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    if (!isConnected(sid)) continue;
    try {
      const token = await getUserToken(sid);
      if (token) return token;
    } catch {
      // token inválido: tenta o próximo
    }
  }
  if (hasSecret()) {
    try {
      return await getAppToken();
    } catch (err) {
      throw new Error(`${NEED_LOGIN_MSG} (${err.message})`);
    }
  }
  throw new Error(NEED_LOGIN_MSG);
}

// ---------- busca ----------

function mapTrack(t) {
  return {
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms || 0,
    isrc: t.external_ids?.isrc || null, // não vem mais em dev mode
    spotifyUri: t.uri,
    spotifyAlbumUri: t.album?.uri || null,
  };
}

// opts: { token } ou { tokenProvider: async () => token }
async function search(q, { limit = SEARCH_MAX_LIMIT, token, tokenProvider } = {}) {
  const tok = token || (tokenProvider ? await tokenProvider() : await searchToken([]));
  const lim = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(Number(limit)) || SEARCH_MAX_LIMIT));
  const url = `${apiBase()}/search?type=track&limit=${lim}&q=${encodeURIComponent(q)}`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  } catch (err) {
    throw new Error(`Busca no Spotify falhou: sem conexão (${err.message}).`);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Busca no Spotify falhou: sessão expirada. Entre com o Spotify de novo.');
    if (res.status === 403) throw new Error('Busca no Spotify recusada: sua conta precisa estar liberada no app (User Management).');
    if (res.status === 429) throw new Error('Muitas buscas no Spotify agora. Tente de novo em alguns segundos.');
    throw new Error(`Busca no Spotify falhou (${res.status}).`);
  }
  const body = await res.json().catch(() => ({}));
  return (body.tracks?.items || []).filter(Boolean).map(mapTrack);
}

// ---------- controle do player ----------

class SpotifyPlayerError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function userRequest(sid, method, pathAndQuery, body) {
  const token = await getUserToken(sid);
  if (!token) throw new SpotifyPlayerError('Spotify não conectado.', 401, 'NOT_CONNECTED');
  let res;
  try {
    res = await fetch(`${apiBase()}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new SpotifyPlayerError(`Sem conexão com o Spotify (${err.message}).`, 0, 'NETWORK');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const reason = data?.error?.reason || '';
    const raw = data?.error?.message || '';
    // "Pausar o que já está pausado" (403) é esperado e não merece aviso no terminal.
    const expected = res.status === 403 && pathAndQuery.startsWith('/me/player/pause');
    if (!expected) console.warn(`[spotify] ${method} ${pathAndQuery.split('?')[0]} -> ${res.status} ${reason} ${raw}`.trim());
    let msg = raw ? `Spotify: ${raw}` : `Erro ${res.status} do Spotify.`;
    if (reason === 'NO_ACTIVE_DEVICE' || (res.status === 404 && /device/i.test(raw))) {
      msg = 'Nenhum aparelho com o Spotify aberto foi encontrado.';
    }
    else if (reason === 'PREMIUM_REQUIRED') msg = 'Controlar o Spotify exige conta Premium.';
    else if (res.status === 403 && /registered/i.test(raw)) msg = 'Sua conta do Spotify não está liberada neste app. Peça ao dono do servidor para adicioná-la em User Management.';
    else if (res.status === 401) msg = 'Sessão do Spotify expirou. Entre com o Spotify de novo.';
    else if (res.status === 429) msg = 'Spotify limitou os comandos por alguns segundos. Tentando de novo…';
    throw new SpotifyPlayerError(msg, res.status, reason);
  }
  return data;
}

// ---------- cápsula sonora (mais ouvidos e histórico recente) ----------

// Logins antigos não pediram os escopos da cápsula: a pessoa precisa entrar de novo.
function hasStatsScopes(sid) {
  const t = tokens()[sid];
  if (!t) return false;
  if (t.scope === undefined) return true; // token de antes de guardarmos o escopo: deixa a API decidir
  const granted = new Set(String(t.scope).split(/\s+/));
  return STATS_SCOPES.every((s) => granted.has(s));
}

const smallestImage = (images, min = 160) => {
  const list = (images || []).filter((i) => i?.url);
  if (!list.length) return '';
  const fit = list.filter((i) => (i.width || 0) >= min).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (fit[0] || list[0]).url;
};

const statsTrack = (t) => ({
  id: t.id,
  title: t.name,
  artist: t.artists?.[0]?.name || '',
  artists: (t.artists || []).map((a) => a.name),
  art: smallestImage(t.album?.images, 64),
  durationMs: t.duration_ms || 0,
  url: t.external_urls?.spotify || '',
});

async function statsRequest(sid, pathAndQuery) {
  try {
    return await userRequest(sid, 'GET', pathAndQuery);
  } catch (err) {
    if (err.status === 403 && /scope/i.test(err.message)) err.reason = 'SCOPE';
    throw err;
  }
}

async function topItems(sid, range = 'short_term') {
  const tr = TOP_RANGES.includes(range) ? range : 'short_term';
  const [artists, tracks] = await Promise.all([
    statsRequest(sid, `/me/top/artists?time_range=${tr}&limit=20`),
    statsRequest(sid, `/me/top/tracks?time_range=${tr}&limit=50`),
  ]);
  return {
    artists: (artists?.items || []).map((a) => ({
      id: a.id,
      name: a.name,
      art: smallestImage(a.images),
      genres: (a.genres || []).slice(0, 3),
      url: a.external_urls?.spotify || '',
    })),
    tracks: (tracks?.items || []).filter((t) => t?.id).map(statsTrack),
  };
}

// Até 50 últimas reproduções (o Spotify só registra o que tocou por mais de ~30s).
async function recentlyPlayed(sid) {
  const data = await statsRequest(sid, '/me/player/recently-played?limit=50');
  return (data?.items || [])
    .filter((it) => it?.track?.id && it.played_at)
    .map((it) => ({ playedAt: Date.parse(it.played_at), ...statsTrack(it.track) }))
    .filter((it) => Number.isFinite(it.playedAt));
}

const deviceQuery = (deviceId) => (deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '');

const deviceNames = new Map(); // id -> nome legível, só para o log
const deviceLabel = (id) => deviceNames.get(id) || id;

const activeDevice = new Map(); // sid -> último aparelho que confirmou reprodução
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeState(st) {
  if (!st) return 'nada tocando na conta';
  return `aparelho ${st.device?.name || '?'}, ${st.is_playing ? 'tocando' : 'parado'}, faixa ${st.item?.uri || 'nenhuma'}`;
}

// Consulta /me/player algumas vezes até ver a faixa tocando no aparelho certo.
async function waitForPlayback(sid, uri, target, tries = 4, gapMs = 500) {
  let raw = null;
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    try {
      raw = await userRequest(sid, 'GET', '/me/player');
    } catch {
      raw = null;
    }
    const ok = raw && raw.is_playing && raw.item?.uri === uri && (!raw.device?.id || raw.device.id === target);
    if (ok) return { ok: true, raw };
  }
  return { ok: false, raw };
}

const isDeviceMissing = (err) => err?.reason === 'NO_ACTIVE_DEVICE' || err?.status === 404;

// Escolhe o aparelho para tocar quando o Spotify não tem um "ativo":
// o ativo, senão o celular, senão qualquer um que aceite controle remoto.
function pickDevice(devices) {
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  return (
    usable.find((d) => d.is_active) ||
    usable.find((d) => /smartphone/i.test(d.type || '')) ||
    usable[0] ||
    null
  );
}

async function accountName(sid) {
  const t = tokens()[sid];
  if (t?.accountName) return t.accountName;
  try {
    const me = await userRequest(sid, 'GET', '/me');
    const name = me?.display_name || me?.id || null;
    if (t && name) {
      t.accountName = name;
      persistTokens();
    }
    return name;
  } catch {
    return null;
  }
}

async function noDeviceError(sid, devices) {
  const name = await accountName(sid);
  const conta = name ? ` da conta "${name}"` : '';
  const msg = devices.length
    ? `Os aparelhos${conta} não aceitam controle remoto (${devices.map((d) => d.name).join(', ')}).`
    : `Nenhum aparelho${conta} está com o Spotify aberto. Confira se o celular está logado nessa mesma conta, abra o app e toque uma música.`;
  return new SpotifyPlayerError(msg, 404, 'NO_ACTIVE_DEVICE');
}

const player = {
  devices: async (sid) => {
    const devices = (await userRequest(sid, 'GET', '/me/player/devices'))?.devices || [];
    for (const d of devices) deviceNames.set(d.id, `"${d.name}" (${d.type})`);
    const list = devices.map((d) => `${d.name} (${d.type}${d.is_active ? ', ativo' : ''}${d.is_restricted ? ', sem controle remoto' : ''})`);
    console.log(`[spotify] aparelhos da conta ${tokens()[sid]?.accountName || '?'}: ${list.join('; ') || 'nenhum'}`);
    return devices;
  },
  state: (sid) => userRequest(sid, 'GET', '/me/player'),
  // Toca a faixa num aparelho específico e confere se ele realmente começou.
  // positionMs pode ser número ou função (recalculada a cada tentativa, porque cada uma leva tempo).
  // Retorna o id do aparelho usado (a sala passa a mandar sempre para ele).
  // stillWanted(): false quando já existe um comando mais novo; aí as novas tentativas param
  // (senão uma repetição atrasada deixa o aparelho tocando a faixa antiga).
  play: async (sid, deviceId, track, positionMs, stillWanted = () => true) => {
    const { uri, albumUri } = typeof track === 'string' ? { uri: track, albumUri: null } : track;
    const pos = () => Math.max(0, Math.round(typeof positionMs === 'function' ? positionMs() : positionMs));
    // Falha do Spotify (out/2026): no Android, play com `uris` responde 204 e não toca nada.
    // Tocar o álbum começando na faixa (context_uri + offset) funciona; `uris` fica de reserva.
    const bodies = [
      ...(albumUri ? [() => ({ context_uri: albumUri, offset: { uri }, position_ms: pos() })] : []),
      () => ({ uris: [uri], position_ms: pos() }),
    ];
    let attempt = 0;
    const playOn = (id) =>
      userRequest(sid, 'PUT', `/me/player/play?device_id=${encodeURIComponent(id)}`, bodies[Math.min(attempt, bodies.length - 1)]());

    // Sempre diz ao Spotify em qual aparelho tocar: sem isso ele escolhe sozinho
    // (às vezes o PC ou uma aba esquecida) ou responde "nenhum aparelho ativo".
    let target = deviceId;
    let devices = null;
    if (!target) {
      devices = await player.devices(sid);
      const pick = pickDevice(devices);
      if (!pick) throw await noDeviceError(sid, devices);
      target = pick.id;
    }

    // Celular que não é o aparelho "ativo" costuma aceitar o comando e ignorar.
    // Transferir a reprodução para ele antes resolve.
    const isActive = devices ? devices.find((d) => d.id === target)?.is_active : activeDevice.get(sid) === target;
    try {
      if (!isActive) await player.transfer(sid, target);
      await playOn(target);
    } catch (err) {
      if (!isDeviceMissing(err)) throw err;
      // O aparelho sumiu (app fechado, outro celular): escolhe outro da lista.
      devices = await player.devices(sid);
      const pick = pickDevice(devices.filter((d) => d.id !== target));
      if (!pick) throw await noDeviceError(sid, devices);
      target = pick.id;
      if (!pick.is_active) await player.transfer(sid, target);
      await playOn(target);
    }

    let state = await waitForPlayback(sid, uri, target);
    // Tenta as outras formas de comando (álbum -> faixa avulsa) e, por fim, transfere e repete.
    while (!state.ok && attempt < bodies.length) {
      if (!stillWanted()) return target;
      attempt++;
      const how = attempt < bodies.length ? 'como faixa avulsa' : 'depois de transferir';
      console.warn(`[spotify] ${deviceLabel(target)} não começou a tocar (${describeState(state.raw)}). Tentando ${how}…`);
      if (attempt >= bodies.length) await player.transfer(sid, target);
      await playOn(target);
      state = await waitForPlayback(sid, uri, target);
    }
    if (state.ok) {
      activeDevice.set(sid, target);
      console.log(`[spotify] tocando ${uri} em ${deviceLabel(target)}`);
    } else {
      console.warn(`[spotify] ${deviceLabel(target)} continua sem tocar (${describeState(state.raw)}).`);
      throw new SpotifyPlayerError(
        `O Spotify aceitou o comando, mas ${deviceLabel(target)} não começou a tocar. Deixe o app do Spotify aberto na tela do aparelho e tente de novo, ou escolha outro aparelho abaixo.`,
        409,
        'DEVICE_IGNORED'
      );
    }
    return target;
  },
  transfer: async (sid, id) => {
    await userRequest(sid, 'PUT', '/me/player', { device_ids: [id], play: false });
    activeDevice.set(sid, id);
    await sleep(600); // o aparelho leva um instante para assumir a reprodução
  },
  // Ajuste fino com a faixa já tocando: bem mais rápido e preciso que um novo play.
  seek: (sid, deviceId, positionMs) =>
    userRequest(sid, 'PUT', `/me/player/seek?position_ms=${Math.max(0, Math.round(positionMs))}${deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : ''}`),
  pause: async (sid, deviceId) => {
    try {
      await userRequest(sid, 'PUT', `/me/player/pause${deviceQuery(deviceId)}`);
    } catch (err) {
      // Já pausado (403) ou nenhum aparelho tocando (404): não há o que pausar.
      if (err.status !== 403 && !isDeviceMissing(err)) throw err;
    }
  },
};

module.exports = {
  SCOPES,
  SEARCH_MAX_LIMIT,
  NEED_LOGIN_MSG,
  clientId,
  isConfigured,
  hasSecret,
  isValidClientId,
  saveClientId,
  createPkce,
  authorizeUrl,
  handleCallback,
  accountName,
  cachedAccountName: (sid) => tokens()[sid]?.accountName || null,
  isConnected,
  disconnect,
  getUserToken,
  searchToken,
  search,
  hasStatsScopes,
  topItems,
  recentlyPlayed,
  player,
  SpotifyPlayerError,
};
