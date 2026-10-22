// Estado das salas. O relógio do servidor é a fonte da verdade:
// a posição atual é derivada de (positionMs, updatedAt, playing).

const crypto = require('crypto');
const spotify = require('./spotify');

const rooms = new Map();
const SPOTIFY_DRIFT_TOLERANCE_MS = 2500;
const SPOTIFY_CHECK_INTERVAL_MS = 8000;
const SPOTIFY_GRACE_AFTER_COMMAND_MS = 6000;

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  constructor(hostSid, onChange) {
    this.code = newCode();
    this.hostSid = hostSid;
    this.members = new Map(); // sid -> { name, platform, sockets:Set, spotify:{ deviceId, error, lastCommandAt } }
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.positionMs = 0;
    this.updatedAt = Date.now();
    this.endTimer = null;
    this.onChange = onChange;
    this.lastActivity = Date.now();
  }

  get current() {
    return this.queue[this.index] || null;
  }

  currentPosition(now = Date.now()) {
    return this.playing ? this.positionMs + (now - this.updatedAt) : this.positionMs;
  }

  // ---------- membros ----------

  join(sid, name, socketId) {
    let m = this.members.get(sid);
    if (!m) {
      m = { name, platform: 'none', sockets: new Set(), spotify: { deviceId: null, error: null, lastCommandAt: 0 } };
      this.members.set(sid, m);
    }
    m.name = name || m.name;
    m.sockets.add(socketId);
    this.lastActivity = Date.now();
    this.changed({ spotifySids: m.platform === 'spotify' ? [sid] : [] });
    return m;
  }

  leave(sid, socketId) {
    const m = this.members.get(sid);
    if (!m) return;
    m.sockets.delete(socketId);
    // Mantém o membro do Spotify: ele continua ouvindo com a tela bloqueada.
    if (m.sockets.size === 0 && m.platform !== 'spotify') this.members.delete(sid);
    this.changed();
  }

  setPlatform(sid, platform) {
    const m = this.members.get(sid);
    if (!m) return;
    const previous = m.platform;
    m.platform = platform;
    m.spotify.error = null;
    if (previous === 'spotify' && platform !== 'spotify') {
      spotify.player.pause(sid, m.spotify.deviceId).catch(() => {});
    }
    this.changed({ spotifySids: platform === 'spotify' ? [sid] : [] });
  }

  setSpotifyDevice(sid, deviceId) {
    const m = this.members.get(sid);
    if (!m) return;
    m.spotify.deviceId = deviceId || null;
    this.changed({ spotifySids: [sid] });
  }

  // ---------- fila ----------

  addTrack(track, addedBy) {
    const t = { ...track, id: crypto.randomUUID(), addedBy };
    this.queue.push(t);
    if (this.index === -1) {
      this.index = this.queue.length - 1;
      this.positionMs = 0;
      this.playing = true;
      this.updatedAt = Date.now();
      this.changed({ playback: true });
    } else {
      this.changed();
    }
    return t;
  }

  updateTrack(trackId, patch) {
    const t = this.queue.find((x) => x.id === trackId);
    if (!t) return;
    Object.assign(t, patch);
    this.changed({ playback: t === this.current });
  }

  removeTrack(trackId) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    if (i === -1) return;
    this.queue.splice(i, 1);
    if (i < this.index) {
      this.index--;
      this.changed();
    } else if (i === this.index) {
      if (this.index >= this.queue.length) this.index = -1;
      this.positionMs = 0;
      this.updatedAt = Date.now();
      if (this.index === -1) this.playing = false;
      this.changed({ playback: true });
    } else {
      this.changed();
    }
  }

  moveTrack(trackId, delta) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    const j = i + delta;
    // Só reordena o que ainda não tocou nem está tocando.
    if (i <= this.index || j <= this.index || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.changed();
  }

  // ---------- reprodução ----------

  play() {
    if (!this.current) return;
    if (this.playing) return;
    this.updatedAt = Date.now();
    this.playing = true;
    this.changed({ playback: true });
  }

  pause() {
    if (!this.playing) return;
    this.positionMs = this.currentPosition();
    this.updatedAt = Date.now();
    this.playing = false;
    this.changed({ playback: true });
  }

  seek(ms) {
    if (!this.current) return;
    this.positionMs = Math.max(0, Math.min(ms, (this.current.durationMs || ms) - 1000));
    this.updatedAt = Date.now();
    this.changed({ playback: true });
  }

  jumpTo(index) {
    if (index < 0 || index >= this.queue.length) {
      this.index = this.queue.length ? this.queue.length - 1 : -1;
      this.playing = false;
      this.positionMs = this.current?.durationMs || 0;
    } else {
      this.index = index;
      this.positionMs = 0;
      this.playing = true;
    }
    this.updatedAt = Date.now();
    this.changed({ playback: true });
  }

  next() {
    this.jumpTo(this.index + 1);
  }

  prev() {
    // Igual aos players: volta ao início se já passou de 5s.
    if (this.currentPosition() > 5000 || this.index <= 0) this.seek(0);
    else this.jumpTo(this.index - 1);
  }

  scheduleEnd() {
    clearTimeout(this.endTimer);
    const t = this.current;
    if (!this.playing || !t?.durationMs) return;
    const remaining = t.durationMs - this.currentPosition();
    this.endTimer = setTimeout(() => this.next(), Math.max(0, remaining + 300));
  }

  // ---------- notificação + Spotify ----------

  changed({ playback = false, spotifySids = [] } = {}) {
    this.lastActivity = Date.now();
    if (playback) {
      this.scheduleEnd();
      this.syncSpotify();
    } else {
      for (const sid of spotifySids) this.syncSpotifyMember(sid);
    }
    this.onChange(this);
  }

  syncSpotify() {
    for (const [sid, m] of this.members) if (m.platform === 'spotify') this.syncSpotifyMember(sid);
  }

  async syncSpotifyMember(sid) {
    const m = this.members.get(sid);
    if (!m || m.platform !== 'spotify' || !spotify.isConnected(sid)) return;
    const t = this.current;
    const before = m.spotify.error;
    try {
      m.spotify.lastCommandAt = Date.now();
      if (!t || !this.playing || !t.spotifyUri) {
        await spotify.player.pause(sid, m.spotify.deviceId);
        m.spotify.error = t && !t.spotifyUri ? 'Esta faixa não foi encontrada no Spotify.' : null;
      } else {
        const started = Date.now();
        // Compensa metade do tempo esperado de ida e volta do comando.
        await spotify.player.play(sid, m.spotify.deviceId, t.spotifyUri, this.currentPosition() + 250);
        m.spotify.lastLatencyMs = Date.now() - started;
        m.spotify.error = null;
      }
    } catch (err) {
      m.spotify.error = err.message;
    }
    if (before !== m.spotify.error) this.onChange(this);
  }

  // Corrige quem saiu de sincronia (pausou no app, trocou de música, atrasou).
  async checkSpotifyDrift() {
    const t = this.current;
    if (!t || !this.playing || !t.spotifyUri) return;
    for (const [sid, m] of this.members) {
      if (m.platform !== 'spotify' || !spotify.isConnected(sid)) continue;
      if (Date.now() - m.spotify.lastCommandAt < SPOTIFY_GRACE_AFTER_COMMAND_MS) continue;
      try {
        const state = await spotify.player.state(sid);
        const expected = this.currentPosition();
        const ok =
          state &&
          state.is_playing &&
          state.item?.uri === t.spotifyUri &&
          Math.abs(state.progress_ms - expected) < SPOTIFY_DRIFT_TOLERANCE_MS;
        if (!ok) this.syncSpotifyMember(sid);
      } catch (err) {
        m.spotify.error = err.message;
      }
    }
  }

  toJSON() {
    return {
      code: this.code,
      hostSid: this.hostSid,
      queue: this.queue,
      index: this.index,
      playing: this.playing,
      positionMs: this.positionMs,
      updatedAt: this.updatedAt,
      members: [...this.members].map(([sid, m]) => ({
        id: crypto.createHash('sha1').update(sid).digest('hex').slice(0, 10), // não expõe o sid
        name: m.name,
        platform: m.platform,
        online: m.sockets.size > 0,
        spotifyConnected: spotify.isConnected(sid),
        spotifyError: m.platform === 'spotify' ? m.spotify.error : null,
      })),
    };
  }

  destroy() {
    clearTimeout(this.endTimer);
    for (const [sid, m] of this.members) {
      if (m.platform === 'spotify') spotify.player.pause(sid, m.spotify.deviceId).catch(() => {});
    }
  }
}

function createRoom(hostSid, onChange) {
  const room = new Room(hostSid, onChange);
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  return rooms.get((code || '').toUpperCase()) || null;
}

setInterval(() => {
  for (const room of rooms.values()) room.checkSpotifyDrift();
}, SPOTIFY_CHECK_INTERVAL_MS).unref();

// Remove salas sem ninguém conectado há mais de 6 horas.
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600_000;
  for (const [code, room] of rooms) {
    const anyoneOnline = [...room.members.values()].some((m) => m.sockets.size > 0);
    if (!anyoneOnline && room.lastActivity < cutoff) {
      room.destroy();
      rooms.delete(code);
    }
  }
}, 10 * 60_000).unref();

module.exports = { createRoom, getRoom, Room };
