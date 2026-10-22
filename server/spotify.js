// Integração com a Spotify Web API:
// - Client Credentials para busca (não depende de nenhum usuário)
// - Authorization Code para controlar o player de cada participante (Spotify Connect)

const fs = require('fs');
const path = require('path');

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];
const TOKENS_FILE = path.join(__dirname, '..', 'data', 'spotify-tokens.json');

const clientId = () => process.env.SPOTIFY_CLIENT_ID;
const clientSecret = () => process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = () => `${process.env.BASE_URL}/auth/spotify/callback`;

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify token: ${body.error_description || body.error || res.status}`);
  return body;
}

// ---------- Token do app (busca) ----------

let appToken = null;
async function getAppToken() {
  if (appToken && appToken.expiresAt > Date.now() + 30_000) return appToken.value;
  const body = await tokenRequest({ grant_type: 'client_credentials' });
  appToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return appToken.value;
}

function mapTrack(t) {
  return {
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms,
    isrc: t.external_ids?.isrc || null,
    spotifyUri: t.uri,
  };
}

async function search(q, limit = 10) {
  const token = await getAppToken();
  const url = `${API}/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Busca Spotify falhou (${res.status})`);
  const body = await res.json();
  return (body.tracks?.items || []).map(mapTrack);
}

// ---------- Tokens dos usuários ----------

let userTokens = {};
try {
  userTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
} catch {
  userTokens = {};
}

let saveTimer = null;
function persistTokens() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(userTokens));
  }, 200);
}

function authorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri(),
    state,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

async function handleCallback(sid, code) {
  const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  userTokens[sid] = {
    access: body.access_token,
    refresh: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  persistTokens();
}

function isConnected(sid) {
  return Boolean(userTokens[sid]);
}

function disconnect(sid) {
  delete userTokens[sid];
  persistTokens();
}

async function getUserToken(sid) {
  const t = userTokens[sid];
  if (!t) return null;
  if (t.expiresAt > Date.now() + 30_000) return t.access;
  try {
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
    t.access = body.access_token;
    if (body.refresh_token) t.refresh = body.refresh_token;
    t.expiresAt = Date.now() + body.expires_in * 1000;
    persistTokens();
    return t.access;
  } catch (err) {
    disconnect(sid);
    throw err;
  }
}

class SpotifyPlayerError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

async function userRequest(sid, method, pathAndQuery, body) {
  const token = await getUserToken(sid);
  if (!token) throw new SpotifyPlayerError('Spotify não conectado', 401, 'NOT_CONNECTED');
  const res = await fetch(`${API}${pathAndQuery}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const reason = data?.error?.reason || '';
    let msg = data?.error?.message || `Erro ${res.status}`;
    if (res.status === 404 || reason === 'NO_ACTIVE_DEVICE') msg = 'Abra o app do Spotify no celular e toque qualquer música uma vez.';
    if (reason === 'PREMIUM_REQUIRED') msg = 'Controlar o Spotify exige conta Premium.';
    throw new SpotifyPlayerError(msg, res.status, reason);
  }
  return data;
}

const deviceQuery = (deviceId) => (deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '');

const player = {
  devices: async (sid) => (await userRequest(sid, 'GET', '/me/player/devices'))?.devices || [],
  state: (sid) => userRequest(sid, 'GET', '/me/player'),
  play: (sid, deviceId, uri, positionMs) =>
    userRequest(sid, 'PUT', `/me/player/play${deviceQuery(deviceId)}`, {
      uris: [uri],
      position_ms: Math.max(0, Math.round(positionMs)),
    }),
  pause: async (sid, deviceId) => {
    try {
      await userRequest(sid, 'PUT', `/me/player/pause${deviceQuery(deviceId)}`);
    } catch (err) {
      // Já pausado retorna 403 RESTRICTION_VIOLATED — ignorar.
      if (err.status !== 403) throw err;
    }
  },
};

module.exports = { isConfigured, search, authorizeUrl, handleCallback, isConnected, disconnect, player, SpotifyPlayerError };
