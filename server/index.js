// Carrega .env: usa dotenv se estiver instalado; senão o carregador nativo do Node (>= 20.12).
try {
  require('dotenv').config();
} catch {
  try {
    process.loadEnvFile?.(require('path').join(process.cwd(), '.env'));
  } catch {
    // sem .env: tudo bem
  }
}

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const spotify = require('./spotify');
const youtube = require('./youtube');
const resolver = require('./resolver');
const { createRoom, getRoom } = require('./rooms');
const { parseYoutubeUrl } = require('./matching');

const SID_RE = /^[a-f0-9-]{36}$/i;
const STATE_TTL_MS = 10 * 60_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Cabeçalhos de proxy/túnel: se presentes, a requisição veio de fora mesmo que o socket seja local
// (ex.: cloudflared). Só servem para NEGAR; nunca para conceder.
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];

function isLoopback(req) {
  if (!LOOPBACK.has(req.socket?.remoteAddress || '')) return false;
  return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

function createApp({ getBaseUrl }) {
  const app = express();
  const redirectUri = () => `${getBaseUrl()}/auth/spotify/callback`;

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/config', (req, res) => {
    const configured = spotify.isConfigured();
    res.json({
      spotify: configured,
      youtube: youtube.isConfigured(),
      youtubeMode: youtube.mode(),
      spotifySetup: {
        needed: !configured,
        redirectUri: redirectUri(),
        canSetup: !configured && isLoopback(req),
      },
    });
  });

  app.post('/api/setup', express.json({ limit: '4kb' }), (req, res) => {
    if (!isLoopback(req)) {
      return res.status(403).json({ ok: false, error: 'A configuração só pode ser feita no próprio computador do servidor (http://127.0.0.1).' });
    }
    if (spotify.isConfigured()) {
      return res.status(403).json({ ok: false, error: 'O Spotify já está configurado neste servidor.' });
    }
    const id = typeof req.body?.spotifyClientId === 'string' ? req.body.spotifyClientId.trim() : '';
    if (!spotify.isValidClientId(id)) {
      return res.status(400).json({ ok: false, error: 'Client ID inválido: copie os 32 caracteres (0-9, a-f) do painel do Spotify.' });
    }
    try {
      spotify.saveClientId(id);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: `Não foi possível salvar a configuração: ${err.message}` });
    }
    res.json({ ok: true });
  });

  // ---------- OAuth do Spotify (Authorization Code + PKCE) ----------

  const pendingStates = new Map(); // state -> { sid, room, intent, name, codeVerifier, redirectUri, expiresAt }
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pendingStates) if (v.expiresAt < now) pendingStates.delete(k);
  };

  app.get('/auth/spotify/login', (req, res) => {
    const sid = String(req.query.sid || '').toLowerCase();
    if (!spotify.isConfigured()) return res.status(503).send('Spotify ainda não foi configurado neste servidor.');
    if (!SID_RE.test(sid)) return res.status(400).send('Sessão inválida. Recarregue a página e tente de novo.');
    sweep();
    if (pendingStates.size > 5000) return res.status(429).send('Muitos logins em andamento. Tente de novo em alguns minutos.');
    const state = crypto.randomBytes(16).toString('hex');
    const { verifier, challenge } = spotify.createPkce();
    const intent = ['create', 'join'].includes(req.query.intent) ? req.query.intent : '';
    const uri = redirectUri();
    pendingStates.set(state, {
      sid,
      room: String(req.query.room || '').slice(0, 16),
      intent,
      name: String(req.query.name || '').slice(0, 30),
      codeVerifier: verifier,
      redirectUri: uri,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    res.redirect(spotify.authorizeUrl({ state, codeChallenge: challenge, redirectUri: uri }));
  });

  app.get('/auth/spotify/callback', async (req, res) => {
    const key = String(req.query.state || '');
    const pending = pendingStates.get(key);
    pendingStates.delete(key);
    const back = (status) => {
      const params = new URLSearchParams({ room: pending?.room || '', spotify: status });
      if (pending?.intent) params.set('intent', pending.intent);
      if (pending?.name) params.set('name', pending.name);
      res.redirect(`/?${params}`);
    };
    if (!pending || pending.expiresAt < Date.now()) return back('expired');
    if (req.query.error || !req.query.code) return back('denied');
    try {
      await spotify.handleCallback(pending.sid, String(req.query.code), {
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
      // Se o membro ainda está na sala (período de graça), já passa a ouvir pelo Spotify.
      const room = getRoom(pending.room);
      if (room?.members.has(pending.sid)) room.setPlatform(pending.sid, 'spotify');
      retryMissingSpotify(room, pending.sid);
      back('ok');
    } catch (err) {
      console.error('Login do Spotify falhou:', err.message);
      back('error');
    }
  });

  return app;
}

// ---------- Tempo real ----------

// Token para buscar no Spotify: o próprio → quem estiver conectado na sala → host → app (com secret).
function roomTokenProvider(sid, r) {
  return () => {
    const sids = [sid];
    if (r) {
      const members = [...r.members.keys()];
      const online = members.filter((s) => r.members.get(s).sockets.size > 0);
      sids.push(...online, ...members, r.hostSid);
    }
    return spotify.searchToken(sids);
  };
}

// Procura o equivalente na outra plataforma e atualiza a faixa (updateTrack emite estado para a sala toda).
function resolveInRoom(r, trackId, sid) {
  const t = r.queue.find((x) => x.id === trackId);
  if (!t) return Promise.resolve();
  if (!t.resolving) r.updateTrack(trackId, { resolving: true });
  const snapshot = { ...t };
  delete snapshot.matchErrors;
  return resolver
    .completeTrack(snapshot, { tokenProvider: roomTokenProvider(sid, r) })
    .then((done) => {
      const now = r.queue.find((x) => x.id === trackId) || {};
      const patch = { resolving: false, matchErrors: done.matchErrors };
      // Só preenche o que ainda falta (alguém pode ter corrigido o link enquanto isso).
      if (!now.youtubeId && done.youtubeId) patch.youtubeId = done.youtubeId;
      if (!now.spotifyUri && done.spotifyUri) {
        Object.assign(patch, { spotifyUri: done.spotifyUri, spotifyAlbumUri: done.spotifyAlbumUri || null, title: done.title, artist: done.artist, art: done.art });
      }
      if (!now.isrc && done.isrc) patch.isrc = done.isrc;
      if (!now.durationMs && done.durationMs) patch.durationMs = done.durationMs;
      return patch;
    })
    .catch((err) => ({ resolving: false, matchErrors: [err.message] }))
    .then((patch) => r.updateTrack(trackId, patch));
}

// Depois que alguém conecta o Spotify, tenta de novo as faixas atuais/próximas que ficaram sem spotifyUri.
function retryMissingSpotify(r, sid) {
  if (!r) return;
  const start = Math.max(0, r.index);
  for (const t of r.queue.slice(start)) {
    if (!t.spotifyUri && t.youtubeId && !t.resolving) resolveInRoom(r, t.id, sid);
  }
}

function attachSockets(io) {
  function emitRoom(room) {
    const base = { ...room.toJSON(), serverNow: Date.now() };
    for (const [sid, m] of room.members) {
      const you = {
        isHost: sid === room.hostSid,
        platform: m.platform,
        name: m.name,
        spotifyConnected: spotify.isConnected(sid),
        spotifyError: m.spotify.error,
        spotifyDeviceId: m.spotify.deviceId,
        spotifyAccount: spotify.cachedAccountName(sid),
      };
      for (const socketId of m.sockets) io.to(socketId).emit('state', { ...base, you });
    }
  }

  io.use((socket, next) => {
    const sid = socket.handshake.auth?.sid;
    if (!SID_RE.test(sid || '')) return next(new Error('sessão inválida'));
    socket.data.sid = String(sid).toLowerCase();
    next();
  });

  io.on('connection', (socket) => {
    const sid = socket.data.sid;
    let room = null;

    const safe = (fn) => async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const result = await fn(payload && typeof payload === 'object' ? payload : {});
        reply({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
      } catch (err) {
        reply({ ok: false, error: err.message || 'Erro inesperado.' });
      }
    };
    const requireRoom = () => {
      if (!room) throw new Error('Entre em uma sala primeiro.');
      return room;
    };
    const enter = (r, name) => {
      if (room && room !== r) room.leave(sid, socket.id);
      room = r;
      socket.join(r.code);
      r.join(sid, String(name || '').trim().slice(0, 30) || 'Convidado', socket.id);
      return { code: r.code };
    };
    const tokenProvider = (r) => roomTokenProvider(sid, r);

    socket.on('time', (_t, ack) => typeof ack === 'function' && ack(Date.now()));

    socket.on('room:create', safe(({ name }) => enter(createRoom(sid, emitRoom), name)));

    socket.on('room:join', safe(({ code, name }) => {
      const r = getRoom(code);
      if (!r) throw new Error('Sala não encontrada.');
      return enter(r, name);
    }));

    socket.on('platform:set', safe(({ platform }) => {
      if (!['spotify', 'youtube', 'none'].includes(platform)) throw new Error('Plataforma inválida.');
      if (platform === 'spotify' && !spotify.isConfigured()) throw new Error('O Spotify ainda não foi configurado neste servidor.');
      if (platform === 'spotify' && !spotify.isConnected(sid)) return { needsAuth: true };
      const r = requireRoom();
      r.setPlatform(sid, platform);
      if (platform === 'spotify') {
        retryMissingSpotify(r, sid);
        if (!spotify.cachedAccountName(sid)) spotify.accountName(sid).then((n) => n && emitRoom(r)).catch(() => {});
      }
    }));

    socket.on('spotify:devices', safe(async () => {
      if (!spotify.isConnected(sid)) throw new Error('Entre com o Spotify primeiro.');
      return { devices: await spotify.player.devices(sid) };
    }));
    socket.on('spotify:device', safe(({ deviceId }) => requireRoom().setSpotifyDevice(sid, typeof deviceId === 'string' ? deviceId : null)));
    socket.on('spotify:disconnect', safe(() => {
      spotify.disconnect(sid);
      room?.setPlatform(sid, 'none');
    }));

    socket.on('search', safe(async ({ q, source }) => {
      q = String(q || '').trim().slice(0, 120);
      if (!q) return { results: [] };
      const videoId = parseYoutubeUrl(q);
      const isLink = Boolean(videoId && q.length > 11);
      const wantsYoutube = source === 'youtube' || isLink;
      if (wantsYoutube && !youtube.isConfigured()) throw new Error('A busca no YouTube não está configurada no servidor (YOUTUBE_API_KEY).');
      if (isLink) return { results: await youtube.videosById([videoId]) };
      if (wantsYoutube) return { results: await youtube.search(q) };
      if (!spotify.isConfigured()) throw new Error('O Spotify ainda não foi configurado neste servidor.');
      return { results: await spotify.search(q, { tokenProvider: tokenProvider(room) }) };
    }));

    socket.on('queue:add', safe(async ({ track }) => {
      const r = requireRoom();
      if (!track || typeof track !== 'object') throw new Error('Faixa inválida.');
      const clean = {
        title: String(track.title || '').slice(0, 200),
        artist: String(track.artist || '').slice(0, 200),
        album: String(track.album || '').slice(0, 200),
        art: /^https:\/\//.test(track.art || '') ? String(track.art).slice(0, 500) : '',
        durationMs: Math.max(0, Math.min(Number(track.durationMs) || 0, 6 * 3600_000)),
        isrc: typeof track.isrc === 'string' && /^[A-Z0-9]{12}$/i.test(track.isrc) ? track.isrc.toUpperCase() : null,
        spotifyUri: /^spotify:track:[A-Za-z0-9]+$/.test(track.spotifyUri || '') ? track.spotifyUri : null,
        youtubeId: /^[\w-]{11}$/.test(track.youtubeId || '') ? track.youtubeId : null,
        spotifyAlbumUri: /^spotify:album:[A-Za-z0-9]+$/.test(track.spotifyAlbumUri || '') ? track.spotifyAlbumUri : null,
      };
      if (!clean.spotifyUri && !clean.youtubeId) throw new Error('Faixa inválida.');
      const name = r.members.get(sid)?.name || '';
      const added = r.addTrack({ ...clean, resolving: true }, name);
      resolveInRoom(r, added.id, sid);
      return { id: added.id };
    }));

    socket.on('queue:fixYoutube', safe(async ({ trackId, url }) => {
      const id = parseYoutubeUrl(url);
      if (!id) throw new Error('Link do YouTube inválido.');
      requireRoom().updateTrack(trackId, { youtubeId: id });
    }));

    // O player do YouTube de alguém recusou o vídeo (gravadora bloqueou fora do youtube.com,
    // vídeo removido…). Troca pelo próximo melhor vídeo para a sala inteira.
    socket.on('queue:youtubeFailed', safe(async ({ trackId, youtubeId, code }) => {
      const r = requireRoom();
      const t = r.queue.find((x) => x.id === trackId);
      if (!t || !youtubeId || t.youtubeId !== youtubeId) return { ignored: true }; // já trocado
      if (![100, 101, 150].includes(Number(code))) return { ignored: true }; // erro do player, não do vídeo
      console.warn(`[youtube] vídeo ${youtubeId} recusado pelo player (erro ${code}) em "${t.title}". Procurando outro…`);
      resolver.blockVideo(youtubeId);
      const tried = [...(t.youtubeTried || []), youtubeId].slice(-10);
      r.updateTrack(trackId, { youtubeId: null, youtubeTried: tried, resolving: true });
      let next = null;
      try {
        next = await resolver.findOnYoutube(t, { exclude: tried });
      } catch (err) {
        console.warn(`[youtube] nova busca falhou: ${err.message}`);
      }
      const now = r.queue.find((x) => x.id === trackId);
      if (!now) return { replacement: null };
      if (now.youtubeId) return { replacement: now.youtubeId }; // alguém colou um link enquanto isso
      r.updateTrack(trackId, {
        youtubeId: next,
        resolving: false,
        matchErrors: next ? [] : ['Nenhum vídeo desta música no YouTube pode tocar fora do youtube.com. Cole outro link com 🔗.'],
      });
      if (next) console.log(`[youtube] "${t.title}" agora usa o vídeo ${next}`);
      return { replacement: next };
    }));

    socket.on('queue:remove', safe(({ trackId }) => requireRoom().removeTrack(trackId)));
    socket.on('queue:move', safe(({ trackId, delta }) => requireRoom().moveTrack(trackId, delta > 0 ? 1 : -1)));

    socket.on('player:play', safe(() => requireRoom().play()));
    socket.on('player:pause', safe(() => requireRoom().pause()));
    socket.on('player:next', safe(() => requireRoom().next()));
    socket.on('player:prev', safe(() => requireRoom().prev()));
    socket.on('player:seek', safe(({ ms }) => requireRoom().seek(Number(ms) || 0)));
    socket.on('player:jump', safe(({ index }) => {
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0) throw new Error('Posição inválida na fila.');
      requireRoom().jumpTo(i);
    }));

    socket.on('disconnect', () => room?.leave(sid, socket.id));
  });
}

async function start({ port } = {}) {
  const wanted = port ?? (Number(process.env.PORT) || 3000);
  let actualPort = wanted;
  const getBaseUrl = () => (process.env.BASE_URL || `http://127.0.0.1:${actualPort}`).replace(/\/+$/, '');

  const app = createApp({ getBaseUrl });
  const server = http.createServer(app);
  const io = new Server(server);
  attachSockets(io);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, () => {
      server.off('error', reject);
      resolve();
    });
  });
  actualPort = server.address().port;

  let closing = null;
  const close = () => {
    if (!closing) {
      closing = new Promise((resolve) => {
        io.disconnectSockets(true);
        // io.close() fecha o engine e o servidor HTTP.
        io.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    return closing;
  };

  return { server, io, port: actualPort, close };
}

module.exports = { start };

if (require.main === module) {
  start()
    .then(({ port }) => {
      const base = (process.env.BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
      console.log(`Jam Sync em http://localhost:${port}  (BASE_URL=${base})`);
      if (!spotify.isConfigured()) {
        console.warn(`! Spotify sem Client ID — abra http://127.0.0.1:${port} neste computador para configurar (ou defina SPOTIFY_CLIENT_ID).`);
      }
      if (youtube.mode() === 'site') console.log('YouTube sem chave: usando a busca do próprio site (sem cota). Para a API oficial, defina YOUTUBE_API_KEY.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
