require('dotenv').config();

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

const PORT = Number(process.env.PORT) || 3000;
process.env.BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/config', (_req, res) => {
  res.json({ spotify: spotify.isConfigured(), youtube: youtube.isConfigured() });
});

// ---------- OAuth do Spotify ----------

const SID_RE = /^[a-f0-9-]{36}$/;
const pendingStates = new Map(); // state -> { sid, room, expiresAt }

app.get('/auth/spotify/login', (req, res) => {
  const { sid, room } = req.query;
  if (!spotify.isConfigured()) return res.status(503).send('Spotify não configurado no servidor (.env).');
  if (!SID_RE.test(sid || '')) return res.status(400).send('Sessão inválida.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { sid, room: String(room || ''), expiresAt: Date.now() + 10 * 60_000 });
  res.redirect(spotify.authorizeUrl(state));
});

app.get('/auth/spotify/callback', async (req, res) => {
  const pending = pendingStates.get(req.query.state);
  pendingStates.delete(req.query.state);
  const back = (params) => res.redirect(`/?${new URLSearchParams({ room: pending?.room || '', ...params })}`);
  if (!pending || pending.expiresAt < Date.now()) return back({ spotify: 'expired' });
  if (req.query.error) return back({ spotify: 'denied' });
  try {
    await spotify.handleCallback(pending.sid, req.query.code);
    const room = getRoom(pending.room);
    if (room?.members.has(pending.sid)) room.setPlatform(pending.sid, 'spotify');
    back({ spotify: 'ok' });
  } catch (err) {
    console.error(err);
    back({ spotify: 'error' });
  }
});

// ---------- Tempo real ----------

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
    };
    for (const socketId of m.sockets) io.to(socketId).emit('state', { ...base, you });
  }
}

io.use((socket, next) => {
  const sid = socket.handshake.auth?.sid;
  if (!SID_RE.test(sid || '')) return next(new Error('sessão inválida'));
  socket.data.sid = sid;
  next();
});

io.on('connection', (socket) => {
  const sid = socket.data.sid;
  let room = null;

  const safe = (fn) => async (payload, ack = () => {}) => {
    try {
      ack({ ok: true, ...(await fn(payload || {})) });
    } catch (err) {
      ack({ ok: false, error: err.message });
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
    r.join(sid, String(name || 'Convidado').slice(0, 30), socket.id);
    return { code: r.code };
  };

  socket.on('time', (_t, ack) => typeof ack === 'function' && ack(Date.now()));

  socket.on('room:create', safe(({ name }) => enter(createRoom(sid, emitRoom), name)));

  socket.on('room:join', safe(({ code, name }) => {
    const r = getRoom(code);
    if (!r) throw new Error('Sala não encontrada.');
    return enter(r, name);
  }));

  socket.on('platform:set', safe(({ platform }) => {
    if (!['spotify', 'youtube', 'none'].includes(platform)) throw new Error('Plataforma inválida.');
    if (platform === 'spotify' && !spotify.isConfigured()) throw new Error('Spotify não configurado no servidor.');
    if (platform === 'spotify' && !spotify.isConnected(sid)) return { needsAuth: true };
    requireRoom().setPlatform(sid, platform);
  }));

  socket.on('spotify:devices', safe(async () => ({ devices: await spotify.player.devices(sid) })));
  socket.on('spotify:device', safe(({ deviceId }) => requireRoom().setSpotifyDevice(sid, deviceId)));
  socket.on('spotify:disconnect', safe(() => {
    spotify.disconnect(sid);
    requireRoom().setPlatform(sid, 'none');
  }));

  socket.on('search', safe(async ({ q, source }) => {
    q = String(q || '').trim().slice(0, 120);
    if (!q) return { results: [] };
    const videoId = parseYoutubeUrl(q);
    const wantsYoutube = source === 'youtube' || (videoId && q.length > 11);
    if (wantsYoutube && !youtube.isConfigured()) throw new Error('YOUTUBE_API_KEY não configurada no servidor.');
    if (!wantsYoutube && !spotify.isConfigured()) throw new Error('Credenciais do Spotify não configuradas no servidor.');
    if (videoId && q.length > 11) return { results: await youtube.videosById([videoId]) };
    if (source === 'youtube') return { results: await youtube.search(q) };
    return { results: await spotify.search(q) };
  }));

  socket.on('queue:add', safe(async ({ track }) => {
    const r = requireRoom();
    if (!track || (!track.spotifyUri && !track.youtubeId)) throw new Error('Faixa inválida.');
    const clean = {
      title: String(track.title || '').slice(0, 200),
      artist: String(track.artist || '').slice(0, 200),
      album: String(track.album || '').slice(0, 200),
      art: /^https:\/\//.test(track.art || '') ? track.art : '',
      durationMs: Number(track.durationMs) || 0,
      isrc: track.isrc || null,
      spotifyUri: /^spotify:track:[A-Za-z0-9]+$/.test(track.spotifyUri || '') ? track.spotifyUri : null,
      youtubeId: /^[\w-]{11}$/.test(track.youtubeId || '') ? track.youtubeId : null,
    };
    const name = r.members.get(sid)?.name || '';
    const added = r.addTrack({ ...clean, resolving: true }, name);
    resolver.completeTrack(clean).then((done) => {
      r.updateTrack(added.id, {
        spotifyUri: done.spotifyUri,
        youtubeId: done.youtubeId,
        title: done.title,
        artist: done.artist,
        isrc: done.isrc,
        art: done.art,
        resolving: false,
        matchErrors: done.matchErrors,
      });
    });
    return { id: added.id };
  }));

  socket.on('queue:fixYoutube', safe(async ({ trackId, url }) => {
    const id = parseYoutubeUrl(url);
    if (!id) throw new Error('Link do YouTube inválido.');
    requireRoom().updateTrack(trackId, { youtubeId: id });
  }));

  socket.on('queue:remove', safe(({ trackId }) => requireRoom().removeTrack(trackId)));
  socket.on('queue:move', safe(({ trackId, delta }) => requireRoom().moveTrack(trackId, delta > 0 ? 1 : -1)));

  socket.on('player:play', safe(() => requireRoom().play()));
  socket.on('player:pause', safe(() => requireRoom().pause()));
  socket.on('player:next', safe(() => requireRoom().next()));
  socket.on('player:prev', safe(() => requireRoom().prev()));
  socket.on('player:seek', safe(({ ms }) => requireRoom().seek(Number(ms) || 0)));
  socket.on('player:jump', safe(({ index }) => requireRoom().jumpTo(Number(index))));

  socket.on('disconnect', () => room?.leave(sid, socket.id));
});

server.listen(PORT, () => {
  console.log(`Jam Sync em http://localhost:${PORT}  (BASE_URL=${process.env.BASE_URL})`);
  if (!spotify.isConfigured()) console.warn('! SPOTIFY_CLIENT_ID/SECRET ausentes — busca e player do Spotify desativados.');
  if (!youtube.isConfigured()) console.warn('! YOUTUBE_API_KEY ausente — busca e correspondência no YouTube desativadas.');
});
