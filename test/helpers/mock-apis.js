// Servidor HTTP local que imita Spotify Accounts, Spotify Web API e YouTube Data API v3.
//
// Bases (passe para o servidor sob teste):
//   SPOTIFY_ACCOUNTS_BASE = `${mock.url}/accounts`
//   SPOTIFY_API_BASE      = `${mock.url}/spotify/v1`
//   YOUTUBE_API_BASE      = `${mock.url}/youtube/v3`
//
// Fluxo PKCE: o teste segue o redirect do /auth/spotify/login até `${mock}/accounts/authorize?...`
// (pode acrescentar `mock_user=<nome>` à URL para dar nome ao usuário). O mock guarda o
// code_challenge e responde 302 para `redirect_uri?code=...&state=...`. O teste então chama o
// callback do servidor sob teste com esse code/state. No POST /api/token o mock exige
// code_verifier tal que base64url(sha256(verifier)) == code_challenge.

const http = require('http');
const crypto = require('crypto');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isoDuration(ms) {
  const s = Math.round(ms / 1000);
  return `PT${Math.floor(s / 60)}M${s % 60}S`;
}

function createMock() {
  const state = {
    requests: [], // { method, path, query, headers, body, rawBody, at }
    authorizations: new Map(), // code -> { challenge, method, clientId, redirectUri, user, scope, used }
    authorizeRequests: [],
    tokenRequests: [],
    accessTokens: new Map(), // token -> { user, kind: 'user'|'app' }
    refreshTokens: new Map(), // refresh -> user
    tokenExpiresIn: 3600, // configurável (ex.: 1 para forçar refresh)
    players: new Map(), // user -> { isPlaying, uri, progressMs, at, devices }
    playerCalls: [], // { user, op:'play'|'pause', uris, position_ms, deviceId, at }
    spotifySearches: [], // { q, limit, token, user, at }
    spotifyCatalog: [], // tracks no formato da API (sem external_ids)
    youtubeVideos: new Map(), // id -> { id, title, channelTitle, durationMs, embeddable }
    youtubeSearchOverride: null, // (q) => [ids]
    youtubeSearches: [],
    youtubeKey: 'fake',
    playerFailure: null, // (user, op) => { status, body } | null
  };

  let seq = 0;
  const newToken = (prefix) => `${prefix}-${++seq}-${crypto.randomBytes(6).toString('hex')}`;

  function player(user) {
    if (!state.players.has(user)) {
      state.players.set(user, {
        isPlaying: false,
        uri: null,
        progressMs: 0,
        at: Date.now(),
        devices: [{ id: `dev-${user}`, name: `Celular de ${user}`, type: 'Smartphone', is_active: true, volume_percent: 80 }],
      });
    }
    return state.players.get(user);
  }
  const progressOf = (p) => (p.isPlaying ? p.progressMs + (Date.now() - p.at) : p.progressMs);

  function send(res, status, body, headers = {}) {
    if (status === 204 || body === undefined) {
      res.writeHead(status, headers);
      return res.end();
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  }
  const apiError = (res, status, message, reason) => send(res, status, { error: { status, message, ...(reason ? { reason } : {}) } });

  function bearerUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return null;
    return state.accessTokens.get(m[1]) || null;
  }

  function mapSpotifyTrack(t) {
    // Formato da API em dev mode pós fev/2026: SEM external_ids.
    return {
      id: t.id,
      uri: `spotify:track:${t.id}`,
      name: t.name,
      duration_ms: t.durationMs,
      artists: t.artists.map((name) => ({ name })),
      album: { uri: `spotify:album:alb${t.id}`, name: t.album || '', images: [{ url: 'https://i.scdn.co/image/x640' }, { url: 'https://i.scdn.co/image/x300' }] },
    };
  }

  // ---------------- Accounts ----------------

  function handleAuthorize(req, res, url) {
    const q = Object.fromEntries(url.searchParams);
    state.authorizeRequests.push({ query: q, at: Date.now() });
    if (q.response_type !== 'code') return send(res, 400, 'response_type inválido');
    if (!q.client_id || !q.redirect_uri || !q.state) return send(res, 400, 'parâmetros faltando');
    const target = new URL(q.redirect_uri);
    if (q.mock_deny) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', q.state);
      return send(res, 302, undefined, { Location: target.toString() });
    }
    const code = newToken('code');
    state.authorizations.set(code, {
      challenge: q.code_challenge || null,
      method: q.code_challenge_method || null,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      scope: q.scope || '',
      user: q.mock_user || `user${seq}`,
      used: false,
    });
    target.searchParams.set('code', code);
    target.searchParams.set('state', q.state);
    send(res, 302, undefined, { Location: target.toString() });
  }

  function issueUserTokens(user) {
    const access = newToken('at');
    const refresh = newToken('rt');
    state.accessTokens.set(access, { user, kind: 'user' });
    state.refreshTokens.set(refresh, user);
    return { access_token: access, token_type: 'Bearer', expires_in: state.tokenExpiresIn, refresh_token: refresh, scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing' };
  }

  function handleToken(req, res, rawBody) {
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const entry = { headers: { ...req.headers }, params, at: Date.now(), status: 0 };
    state.tokenRequests.push(entry);
    const reply = (status, body) => {
      entry.status = status;
      send(res, status, body);
    };
    if (!/application\/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) {
      return reply(400, { error: 'invalid_request', error_description: 'content-type deve ser form-urlencoded' });
    }
    const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
    let basicId = null;
    let basicSecret = null;
    if (basic) [basicId, basicSecret] = Buffer.from(basic[1], 'base64').toString().split(':');

    if (params.grant_type === 'authorization_code') {
      const auth = state.authorizations.get(params.code);
      if (!auth || auth.used) return reply(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
      if (params.redirect_uri !== auth.redirectUri) return reply(400, { error: 'invalid_grant', error_description: 'Invalid redirect URI' });
      const clientId = params.client_id || basicId;
      if (clientId !== auth.clientId) return reply(400, { error: 'invalid_client', error_description: 'client_id não confere' });
      // PKCE: obrigatório (cliente público, sem secret)
      if (!auth.challenge || auth.method !== 'S256') return reply(400, { error: 'invalid_request', error_description: 'code_challenge S256 ausente no /authorize' });
      if (!params.code_verifier) return reply(400, { error: 'invalid_request', error_description: 'code_verifier required' });
      if (b64url(crypto.createHash('sha256').update(params.code_verifier).digest()) !== auth.challenge) {
        return reply(400, { error: 'invalid_grant', error_description: 'code_verifier was incorrect' });
      }
      auth.used = true;
      return reply(200, issueUserTokens(auth.user));
    }
    if (params.grant_type === 'refresh_token') {
      const user = state.refreshTokens.get(params.refresh_token);
      if (!user) return reply(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
      if (!(params.client_id || basicId)) return reply(400, { error: 'invalid_client', error_description: 'client_id ausente' });
      // Spotify (PKCE) pode rotacionar o refresh token
      state.refreshTokens.delete(params.refresh_token);
      return reply(200, issueUserTokens(user));
    }
    if (params.grant_type === 'client_credentials') {
      const id = basicId || params.client_id;
      const secret = basicSecret || params.client_secret;
      if (!id || !secret) return reply(400, { error: 'invalid_client', error_description: 'Invalid client' });
      const access = newToken('app');
      state.accessTokens.set(access, { user: null, kind: 'app' });
      return reply(200, { access_token: access, token_type: 'Bearer', expires_in: 3600 });
    }
    return reply(400, { error: 'unsupported_grant_type' });
  }

  // ---------------- Spotify Web API ----------------

  function handleSpotify(req, res, url, rawBody, path) {
    const who = bearerUser(req);
    if (!who) return apiError(res, 401, 'Invalid access token');

    if (req.method === 'GET' && path === '/search') {
      const q = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit') || 20);
      state.spotifySearches.push({ q, limit, type: url.searchParams.get('type'), token: req.headers.authorization.slice(7), user: who.user, kind: who.kind, at: Date.now() });
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) return apiError(res, 400, 'Invalid limit');
      // casamento simples: todas as palavras do nome da faixa aparecem na query
      const nq = normalize(q.replace(/\b(track|artist|album):/g, ' '));
      const hits = state.spotifyCatalog.filter((t) => {
        const words = normalize(t.name).split(' ');
        return words.every((w) => nq.split(' ').includes(w));
      });
      return send(res, 200, { tracks: { items: hits.slice(0, limit).map(mapSpotifyTrack), limit, total: hits.length } });
    }

    if (!who.user) return apiError(res, 401, 'Este endpoint exige token de usuário');
    const user = who.user;
    const p = player(user);

    if (state.playerFailure && path.startsWith('/me/player')) {
      const f = state.playerFailure(user, `${req.method} ${path}`);
      if (f) return send(res, f.status, f.body);
    }

    if (req.method === 'GET' && path === '/me/player/devices') return send(res, 200, { devices: p.devices });
    if (req.method === 'GET' && (path === '/me/player' || path === '/me/player/currently-playing')) {
      if (!p.uri) return send(res, 204);
      return send(res, 200, {
        device: p.devices.find((d) => d.is_active) || p.devices[0],
        is_playing: p.isPlaying,
        progress_ms: Math.round(progressOf(p)),
        timestamp: Date.now(),
        currently_playing_type: 'track',
        item: { uri: p.uri, id: p.uri.split(':').pop(), name: 'x', duration_ms: 600000 },
      });
    }
    if (req.method === 'GET' && path === '/me') return send(res, 200, { id: user, display_name: `Conta ${user}` });
    if (req.method === 'PUT' && path === '/me/player/play') {
      // Igual ao Spotify real: sem device_id e sem aparelho ativo -> 404 NO_ACTIVE_DEVICE;
      // device_id que não existe -> 404 Device not found.
      const wanted = url.searchParams.get('device_id');
      if (!wanted && !p.devices.some((d) => d.is_active)) {
        state.playerCalls.push({ user, op: 'play-failed', reason: 'NO_ACTIVE_DEVICE', at: Date.now() });
        return apiError(res, 404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE');
      }
      if (wanted && !p.devices.some((d) => d.id === wanted)) return apiError(res, 404, 'Device not found');
      if (wanted) for (const d of p.devices) d.is_active = d.id === wanted;
      let body = {};
      try {
        body = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return apiError(res, 400, 'Malformed json');
      }
      // Falha real do Spotify no Android (out/2026): `uris` responde 204 e não toca nada.
      if (p.ignoreUris && body.uris?.length) {
        state.playerCalls.push({ user, op: 'play-ignored', uris: body.uris, at: Date.now() });
        p.uri = null;
        p.isPlaying = false;
        return send(res, 204);
      }
      const trackUri = body.uris?.[0] || body.offset?.uri || null;
      state.playerCalls.push({ user, op: 'play', uris: trackUri ? [trackUri] : null, contextUri: body.context_uri || null, position_ms: body.position_ms, deviceId: url.searchParams.get('device_id'), at: Date.now() });
      if (trackUri) {
        p.uri = trackUri;
        p.progressMs = Number(body.position_ms) || 0;
      } else {
        p.progressMs = progressOf(p);
      }
      p.isPlaying = true;
      // startLagMs simula o celular real, que só começa a tocar ~1s depois do comando.
      p.at = Date.now() + (trackUri ? p.startLagMs || 0 : 0);
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/me/player/seek') {
      const pos = Number(url.searchParams.get('position_ms'));
      state.playerCalls.push({ user, op: 'seek', position_ms: pos, deviceId: url.searchParams.get('device_id'), at: Date.now() });
      if (!p.uri) return apiError(res, 404, 'Player command failed: No active device found', 'NO_ACTIVE_DEVICE');
      p.progressMs = pos;
      p.at = Date.now() + (p.seekLagMs || 0); // o seek também leva um instante para valer
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/me/player/pause') {
      state.playerCalls.push({ user, op: 'pause', deviceId: url.searchParams.get('device_id'), at: Date.now() });
      if (!p.isPlaying) return apiError(res, 403, 'Player command failed: Restriction violated', 'UNKNOWN');
      p.progressMs = progressOf(p);
      p.isPlaying = false;
      p.at = Date.now();
      return send(res, 204);
    }
    if (req.method === 'PUT' && path === '/me/player') {
      state.playerCalls.push({ user, op: 'transfer', body: rawBody, at: Date.now() });
      try {
        const id = JSON.parse(rawBody || '{}').device_ids?.[0];
        if (id) for (const d of p.devices) d.is_active = d.id === id;
      } catch {}
      return send(res, 204);
    }
    return apiError(res, 404, `mock: rota não implementada ${req.method} ${path}`);
  }

  // ---------------- YouTube Data API ----------------

  function videoResource(v) {
    return {
      kind: 'youtube#video',
      id: v.id,
      snippet: { title: v.title, channelTitle: v.channelTitle, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg` } } },
      contentDetails: { duration: isoDuration(v.durationMs) },
      status: { embeddable: v.embeddable !== false },
    };
  }

  function handleYoutube(req, res, url, path) {
    if (url.searchParams.get('key') !== state.youtubeKey) {
      return send(res, 400, { error: { code: 400, message: 'API key not valid.', errors: [{ reason: 'badRequest' }] } });
    }
    if (path === '/search') {
      const q = url.searchParams.get('q') || '';
      const max = Number(url.searchParams.get('maxResults') || 5);
      state.youtubeSearches.push({ q, maxResults: max, at: Date.now() });
      let ids;
      if (state.youtubeSearchOverride) ids = state.youtubeSearchOverride(q) || [];
      else {
        const nq = normalize(q).split(' ');
        ids = [...state.youtubeVideos.values()]
          .filter((v) => normalize(v.title).split(' ').filter((w) => w.length > 2).some((w) => nq.includes(w)))
          .map((v) => v.id);
      }
      return send(res, 200, { kind: 'youtube#searchListResponse', items: ids.slice(0, max).map((id) => ({ id: { kind: 'youtube#video', videoId: id } })) });
    }
    if (path === '/videos') {
      const ids = (url.searchParams.get('id') || '').split(',').filter(Boolean);
      const items = ids.map((id) => state.youtubeVideos.get(id)).filter(Boolean).map(videoResource);
      return send(res, 200, { kind: 'youtube#videoListResponse', items });
    }
    return send(res, 404, { error: { code: 404, message: 'not found' } });
  }

  // ---------------- YouTube InnerTube (modo sem chave) ----------------
  // Formato parecido com o do site: resultados aninhados em vários níveis, com ruído (anúncios,
  // canais, estreias sem duração) que o servidor precisa ignorar.

  const clock = (ms) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function videoRenderer(v) {
    return {
      videoRenderer: {
        videoId: v.id,
        title: { runs: [{ text: v.title }] },
        ownerText: { runs: [{ text: v.channelTitle }] },
        lengthText: { simpleText: clock(v.durationMs) },
        thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${v.id}/default.jpg`, width: 120 }, { url: `https://i.ytimg.com/vi/${v.id}/hq720.jpg`, width: 720 }] },
      },
    };
  }

  function handleInnertube(req, res, path, raw) {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { error: 'json' });
    }
    if (!body.context?.client?.clientName) return send(res, 400, { error: 'sem context' });
    if (path === '/search') {
      const q = body.query || '';
      state.youtubeSearches.push({ q, innertube: true, at: Date.now() });
      const nq = normalize(q).split(' ');
      const vids = [...state.youtubeVideos.values()].filter(
        (v) => v.id === q || normalize(v.title).split(' ').filter((w) => w.length > 2).some((w) => nq.includes(w))
      );
      const items = [
        { adSlotRenderer: { videoId: 'anuncio0001' } },
        { channelRenderer: { channelId: 'UCx', title: { simpleText: 'Canal' } } },
        { videoRenderer: { videoId: 'aovivo00001', title: { runs: [{ text: 'Ao vivo' }] } } }, // sem duração
        ...vids.map(videoRenderer),
      ];
      return send(res, 200, {
        contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } },
      });
    }
    if (path === '/player') {
      const v = state.youtubeVideos.get(body.videoId);
      if (!v) return send(res, 200, { playabilityStatus: { status: 'ERROR' } });
      return send(res, 200, {
        playabilityStatus: { status: 'OK', playableInEmbed: v.embeddable !== false },
        videoDetails: { videoId: v.id, title: v.title, author: v.channelTitle, lengthSeconds: String(Math.round(v.durationMs / 1000)), thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/x.jpg', width: 480 }] } },
      });
    }
    return send(res, 404, {});
  }

  // ---------------- servidor ----------------

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, rawBody: raw, at: Date.now() });
      try {
        if (url.pathname === '/accounts/authorize') return handleAuthorize(req, res, url);
        if (url.pathname === '/accounts/api/token' && req.method === 'POST') return handleToken(req, res, raw);
        if (url.pathname.startsWith('/spotify/v1/')) return handleSpotify(req, res, url, raw, url.pathname.slice('/spotify/v1'.length));
        if (url.pathname === '/youtube/oembed') {
          // Como o oEmbed real: 401 = incorporação desativada, 404 = vídeo inexistente.
          const id = new URL(url.searchParams.get('url') || 'http://x', 'http://x').searchParams.get('v');
          const v = state.youtubeVideos.get(id);
          if (!v) return send(res, 404, {});
          if (v.embeddable === false) return send(res, 401, {});
          return send(res, 200, { title: v.title, author_name: v.channelTitle });
        }
        if (url.pathname.startsWith('/youtubei/v1/')) return handleInnertube(req, res, url.pathname.slice('/youtubei/v1'.length), raw);
        if (url.pathname.startsWith('/youtube/v3/')) return handleYoutube(req, res, url, url.pathname.slice('/youtube/v3'.length));
        send(res, 404, { error: 'mock: rota desconhecida' });
      } catch (err) {
        send(res, 500, { error: String(err.stack || err) });
      }
    });
  });

  const mock = {
    state,
    server,
    url: null,
    get accountsBase() {
      return `${mock.url}/accounts`;
    },
    get spotifyApiBase() {
      return `${mock.url}/spotify/v1`;
    },
    get youtubeInnertubeBase() {
      return `${mock.url}/youtubei/v1`;
    },
    get youtubeOembedBase() {
      return `${mock.url}/youtube/oembed`;
    },
    get youtubeApiBase() {
      return `${mock.url}/youtube/v3`;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          mock.url = `http://127.0.0.1:${server.address().port}`;
          resolve(mock);
        });
      });
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
    // ---- configuração pelo teste ----
    addSpotifyTrack({ id, name, artists, durationMs, album = '' }) {
      state.spotifyCatalog.push({ id, name, artists: [].concat(artists), durationMs, album });
    },
    addYoutubeVideo({ id, title, channelTitle, durationMs, embeddable = true }) {
      state.youtubeVideos.set(id, { id, title, channelTitle, durationMs, embeddable });
    },
    player,
    setPlayer(user, patch) {
      const p = player(user);
      if (patch.progressMs === undefined && 'isPlaying' in patch) p.progressMs = progressOf(p);
      Object.assign(p, patch, { at: Date.now() });
    },
    playerCallsFor(user) {
      return state.playerCalls.filter((c) => c.user === user);
    },
    userForToken(token) {
      return state.accessTokens.get(token)?.user || null;
    },
    async waitFor(fn, { timeoutMs = 5000, intervalMs = 25, message = 'condição do mock' } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout (${timeoutMs} ms) esperando ${message}`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
  return mock;
}

module.exports = { createMock, b64url };
