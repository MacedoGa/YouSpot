// Estado das salas. O relógio do servidor é a fonte da verdade:
// a posição atual é derivada de (positionMs, updatedAt, playing).

const crypto = require('crypto');
const spotify = require('./spotify');

const rooms = new Map();
// Acima disso: comando de play completo (faixa errada, parado, muito fora).
const SPOTIFY_DRIFT_TOLERANCE_MS = 2500;
// Entre isso e a tolerância acima: só um seek. O celular leva ~1s para começar a tocar
// depois do play, então sem o ajuste fino ele fica atrasado para sempre.
const SPOTIFY_FINE_TOLERANCE_MS = 250;
// Compensações iniciais do tempo até o comando valer no aparelho (medidas num razr 60).
// Cada membro calibra as suas depois de cada comando.
const SPOTIFY_PLAY_COMP_INITIAL_MS = 250;
const SPOTIFY_SEEK_COMP_INITIAL_MS = 200;
const SPOTIFY_COMP_MAX_MS = 2000;
const LEARN_RATE = 0.7;
// Também é o tempo máximo para a sala perceber o que alguém fez no app do Spotify.
const SPOTIFY_CHECK_INTERVAL_MS = 3000;
const SPOTIFY_GRACE_AFTER_COMMAND_MS = 3500;
// Logo depois de uma mudança na sala os comandos ainda estão chegando aos aparelhos:
// o que o Spotify mostra nesse intervalo não é ação de ninguém.
const SPOTIFY_FOLLOW_SETTLE_MS = 4000;
// Perto do fim da faixa o próprio Spotify pula para a próxima do álbum (não foi a pessoa).
const SPOTIFY_END_GUARD_MS = 4000;
// Por quanto tempo uma faixa mandada pelo servidor não conta como "a pessoa escolheu no app".
const SPOTIFY_SENT_MEMORY_MS = 60_000;
const SPOTIFY_FIRST_CHECK_MS = 4000; // primeira conferência depois de um play
// Quem fecha a página (ex.: saiu para fazer login no Spotify) mantém o lugar por este tempo.
const MEMBER_GRACE_MS = 2 * 60_000;

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  } while (rooms.has(code));
  return code;
}

class Room {
  // resolveTrack(room, trackId, sid): procura a faixa na outra plataforma (index.js).
  constructor(hostSid, onChange, { resolveTrack } = {}) {
    this.resolveTrack = resolveTrack || null;
    this.playbackVersion = 0; // muda a cada troca de faixa/pausa/seek
    this.code = newCode();
    this.hostSid = hostSid;
    // sid -> { name, platform, sockets:Set, leaveTimer, spotify:{ deviceId, error, lastCommandAt, seq } }
    this.members = new Map();
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.ended = false; // a fila tocou até o fim; a próxima faixa adicionada começa a tocar
    this.positionMs = 0;
    this.updatedAt = Date.now();
    this.endTimer = null;
    this.onChange = onChange || (() => {});
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
      m = {
        name,
        platform: 'none',
        sockets: new Set(),
        leaveTimer: null,
        spotify: {
          deviceId: null,
          error: null,
          lastCommandAt: 0,
          seq: 0,
          playCompMs: SPOTIFY_PLAY_COMP_INITIAL_MS,
          seekCompMs: SPOTIFY_SEEK_COMP_INITIAL_MS,
          lastCommand: null, // 'play' | 'seek': o próximo check calibra a compensação dele
        },
      };
      this.members.set(sid, m);
    }
    clearTimeout(m.leaveTimer);
    m.leaveTimer = null;
    m.name = name || m.name;
    if (socketId) m.sockets.add(socketId);
    this.lastActivity = Date.now();
    this.changed({ spotifySids: m.platform === 'spotify' ? [sid] : [] });
    return m;
  }

  leave(sid, socketId) {
    const m = this.members.get(sid);
    if (!m) return;
    m.sockets.delete(socketId);
    // Membro do Spotify fica (continua ouvindo com a tela bloqueada). Os outros têm um
    // período de graça: quem saiu para o login do Spotify volta com o mesmo sid e mantém o lugar.
    if (m.sockets.size === 0 && m.platform !== 'spotify') {
      clearTimeout(m.leaveTimer);
      m.leaveTimer = setTimeout(() => {
        m.leaveTimer = null;
        if (this.members.get(sid) !== m || m.sockets.size > 0 || m.platform === 'spotify') return;
        this.members.delete(sid);
        this.changed();
      }, MEMBER_GRACE_MS);
      m.leaveTimer.unref?.();
    }
    this.changed();
  }

  setPlatform(sid, platform) {
    const m = this.members.get(sid);
    if (!m) return false;
    const previous = m.platform;
    m.platform = platform;
    m.spotify.error = null;
    if (previous === 'spotify' && platform !== 'spotify') {
      m.spotify.seq++; // descarta comandos em andamento
      spotify.player.pause(sid, m.spotify.deviceId).catch(() => {});
    }
    this.changed({ spotifySids: platform === 'spotify' ? [sid] : [] });
    return true;
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
    if (this.index === -1 || this.ended || !this.current) {
      // Fila vazia ou já terminou: a faixa nova começa a tocar.
      this.index = this.queue.length - 1;
      this.positionMs = 0;
      this.playing = true;
      this.ended = false;
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
    const isCurrent = t === this.current;
    const prevUri = t.spotifyUri;
    const prevDuration = t.durationMs;
    const prevResolving = t.resolving;
    Object.assign(t, patch);
    if (!isCurrent) return this.changed();
    // Só reenvia comando ao Spotify se o que ele toca mudou (evita "pulos" a cada resolução).
    const uriChanged = t.spotifyUri !== prevUri;
    // Terminou de resolver sem achar no Spotify: atualiza o aviso de quem ouve pelo Spotify.
    const resolvedWithoutUri = prevResolving && !t.resolving && !t.spotifyUri;
    if (uriChanged || resolvedWithoutUri) {
      this.changed({ playback: true });
    } else {
      if (t.durationMs !== prevDuration) this.scheduleEnd();
      this.changed();
    }
  }

  removeTrack(trackId) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    if (i === -1) return;
    this.queue.splice(i, 1);
    if (i < this.index) {
      this.index--;
      this.changed();
    } else if (i === this.index) {
      // A próxima faixa assume o lugar, mantendo tocando/pausado.
      this.positionMs = 0;
      this.updatedAt = Date.now();
      if (!this.queue.length) {
        this.index = -1;
        this.playing = false;
        this.ended = false;
      } else if (this.index >= this.queue.length) {
        // Removeu a última (atual): a fila terminou.
        this.index = this.queue.length - 1;
        this.playing = false;
        this.ended = true;
        this.positionMs = this.current.durationMs || 0;
      }
      this.changed({ playback: true });
    } else {
      this.changed();
    }
  }

  moveTrack(trackId, delta) {
    const i = this.queue.findIndex((t) => t.id === trackId);
    if (i === -1) return;
    const j = i + delta;
    // Só reordena o que ainda não tocou nem está tocando.
    if (i <= this.index || j <= this.index || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.changed();
  }

  // ---------- reprodução ----------

  play() {
    if (!this.current) return;
    if (this.ended) return this.jumpTo(this.index); // recomeça a última faixa
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
    const dur = this.current.durationMs || 0;
    let pos = Math.max(0, Number(ms) || 0);
    if (dur > 0) pos = Math.min(pos, Math.max(0, dur - 1000));
    this.positionMs = pos;
    this.updatedAt = Date.now();
    this.ended = false;
    this.changed({ playback: true });
  }

  jumpTo(index) {
    if (!Number.isInteger(index) || index < 0) return;
    if (index >= this.queue.length) {
      // Passou do fim: para na última faixa.
      this.index = this.queue.length ? this.queue.length - 1 : -1;
      this.playing = false;
      this.ended = this.queue.length > 0;
      this.positionMs = this.current?.durationMs || 0;
    } else {
      this.index = index;
      this.positionMs = 0;
      this.playing = true;
      this.ended = false;
    }
    this.updatedAt = Date.now();
    this.changed({ playback: true });
  }

  next() {
    if (this.index === -1) return;
    this.jumpTo(this.index + 1);
  }

  prev() {
    if (!this.current) return;
    if (this.ended) return this.jumpTo(this.index);
    // Igual aos players: volta ao início se já passou de 5s.
    if (this.currentPosition() > 5000 || this.index <= 0) this.seek(0);
    else this.jumpTo(this.index - 1);
  }

  scheduleEnd() {
    clearTimeout(this.endTimer);
    this.endTimer = null;
    const t = this.current;
    // Sem duração conhecida (0) não há como saber quando acaba: não agenda (evita pular na hora).
    if (!this.playing || !t || !(t.durationMs > 0)) return;
    const remaining = t.durationMs - this.currentPosition();
    const id = t.id;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      if (this.current?.id === id && this.playing) this.next();
    }, Math.max(0, remaining + 300));
    this.endTimer.unref?.();
  }

  // ---------- notificação + Spotify ----------

  // exceptSid: quem originou a mudança pelo próprio app do Spotify (já está tocando certo).
  changed({ playback = false, spotifySids = [], exceptSid = null } = {}) {
    this.lastActivity = Date.now();
    if (playback) {
      this.playbackVersion++;
      this.scheduleEnd();
      this.syncSpotify(exceptSid);
    } else {
      for (const sid of spotifySids) this.syncSpotifyMember(sid);
    }
    this.onChange(this);
  }

  syncSpotify(exceptSid = null) {
    for (const [sid, m] of this.members) if (m.platform === 'spotify' && sid !== exceptSid) this.syncSpotifyMember(sid);
  }

  async syncSpotifyMember(sid) {
    const m = this.members.get(sid);
    if (!m || m.platform !== 'spotify' || !spotify.isConnected(sid)) return;
    const t = this.current;
    // Cada comando recebe um número; resultado de comando antigo que chega depois é descartado.
    const seq = ++m.spotify.seq;
    const before = m.spotify.error;
    let error = null;
    let latency = null;
    let deviceChanged = false;
    m.spotify.lastCommandAt = Date.now();
    try {
      if (!t || !this.playing || !t.spotifyUri) {
        await spotify.player.pause(sid, m.spotify.deviceId);
        if (t && !t.spotifyUri) error = t.resolving ? null : 'Esta faixa não foi encontrada no Spotify.';
      } else {
        const started = Date.now();
        // Compensa o tempo que o aparelho leva para começar a tocar (calibrado por membro).
        const comp = m.spotify.playCompMs;
        // Lembra o que o servidor mandou tocar: se o aparelho aparecer tocando isso depois,
        // foi um comando atrasado, não a pessoa escolhendo no app.
        const sent = (m.spotify.sentUris ||= new Map());
        for (const [u, at] of sent) if (Date.now() - at > SPOTIFY_SENT_MEMORY_MS) sent.delete(u);
        sent.set(t.spotifyUri, Date.now());
        const used = await spotify.player.play(
          sid,
          m.spotify.deviceId,
          { uri: t.spotifyUri, albumUri: t.spotifyAlbumUri },
          () => this.currentPosition() + comp,
          () => m.spotify.seq === seq
        );
        latency = Date.now() - started;
        // O Spotify não tinha aparelho ativo e escolhemos um: passa a mandar sempre para ele.
        if (used && used !== m.spotify.deviceId && m.spotify.seq === seq) {
          m.spotify.deviceId = used;
          deviceChanged = true;
        }
      }
    } catch (err) {
      error = err.message;
    }
    if (this.members.get(sid) !== m || m.spotify.seq !== seq) return; // obsoleto
    if (latency !== null) m.spotify.lastLatencyMs = latency;
    m.spotify.lastCommandAt = Date.now();
    m.spotify.lastCommand = latency !== null && !error ? 'play' : null;
    m.spotify.error = error;
    // Começou a tocar: confere logo em seguida para o ajuste fino (não espera o ciclo de 8s).
    clearTimeout(m.spotify.checkTimer);
    if (latency !== null && !error) {
      m.spotify.checkTimer = setTimeout(() => this.checkSpotifyMember(sid).catch(() => {}), SPOTIFY_FIRST_CHECK_MS);
      m.spotify.checkTimer.unref?.();
    }
    if (before !== error || deviceChanged) this.onChange(this);
  }

  // Para cada membro do Spotify: segue o que ele fez no app (troca, pausa, seek) ou,
  // se não fez nada, corrige quem saiu de sincronia (atrasou, o app parou sozinho).
  async checkSpotifyDrift() {
    for (const [sid, m] of [...this.members]) if (m.platform === 'spotify') await this.checkSpotifyMember(sid);
  }

  async checkSpotifyMember(sid) {
    const m = this.members.get(sid);
    if (!m || m.platform !== 'spotify' || !spotify.isConnected(sid)) return;
    if (Date.now() - m.spotify.lastCommandAt < SPOTIFY_GRACE_AFTER_COMMAND_MS) return;
    const t = this.current;
    const version = this.playbackVersion;
    const seq = m.spotify.seq;
    try {
      const t0 = Date.now();
      const state = await spotify.player.state(sid);
      // O Spotify calcula progress_ms no meio do caminho entre o pedido e a resposta.
      const mid = (t0 + Date.now()) / 2;
      // O estado mudou enquanto esperava (novo comando, outra faixa, pausa): ignora.
      if (m.spotify.seq !== seq || this.playbackVersion !== version || m.platform !== 'spotify') return;
      if (this.followSpotifyApp(sid, m, state, mid)) return;
      if (!t || !this.playing || !t.spotifyUri) return;
      const sameTrack = state && state.is_playing && state.item?.uri === t.spotifyUri;
      const drift = sameTrack ? state.progress_ms - this.currentPosition(mid) : Infinity;

      // Aprende quanto o último comando errou e ajusta a compensação dos próximos.
      const key = { play: 'playCompMs', seek: 'seekCompMs' }[m.spotify.lastCommand];
      if (key && sameTrack) {
        m.spotify[key] = Math.min(SPOTIFY_COMP_MAX_MS, Math.max(0, Math.round(m.spotify[key] - drift * LEARN_RATE)));
      }
      m.spotify.lastCommand = null;

      if (Math.abs(drift) >= SPOTIFY_DRIFT_TOLERANCE_MS) return this.syncSpotifyMember(sid);
      if (Math.abs(drift) >= SPOTIFY_FINE_TOLERANCE_MS) await this.fineSeekSpotify(sid, m, seq);
    } catch (err) {
      if (m.spotify.seq !== seq) return;
      if (m.spotify.error !== err.message) {
        m.spotify.error = err.message;
        this.onChange(this);
      }
    }
  }

  // A pessoa mexeu no app do Spotify: a sala inteira acompanha. Retorna true se tratou.
  followSpotifyApp(sid, m, state, mid) {
    const item = state?.item;
    if (!item?.uri || (item.type && item.type !== 'track')) return false; // nada tocando, podcast, anúncio
    const now = Date.now();
    if (now - this.updatedAt < SPOTIFY_FOLLOW_SETTLE_MS) return false;
    const t = this.current;
    const pos = state.progress_ms + (state.is_playing ? now - mid : 0);
    const roomPos = this.currentPosition();
    const nearRoomEnd = t && t.durationMs > 0 && roomPos >= t.durationMs - SPOTIFY_END_GUARD_MS;
    const last = m.spotify.lastItem;
    const nearSpotifyEnd =
      last && last.durationMs > 0 && last.progressMs + (now - last.at) >= last.durationMs - SPOTIFY_END_GUARD_MS;

    if (t && item.uri === t.spotifyUri) {
      m.spotify.lastItem = {
        uri: item.uri,
        order: (item.disc_number || 1) * 1000 + (item.track_number || 0),
        durationMs: item.duration_ms || 0,
        progressMs: state.progress_ms,
        at: mid,
      };
      if (this.playing && !state.is_playing && !nearRoomEnd) {
        this.applyFromSpotify(sid, 'pausou', { positionMs: pos, playing: false });
      } else if (!this.playing && state.is_playing && !this.ended) {
        this.applyFromSpotify(sid, 'deu play', { positionMs: pos, playing: true });
      } else if (this.playing && state.is_playing && Math.abs(pos - roomPos) >= SPOTIFY_DRIFT_TOLERANCE_MS) {
        this.applyFromSpotify(sid, `pulou para ${Math.round(pos / 1000)}s`, { positionMs: pos, playing: true });
      } else {
        return false;
      }
      return true;
    }

    // Tocando outra música no app.
    if (!state.is_playing) return false;
    // Fim natural: o Spotify seguiu sozinho para a próxima do álbum; a sala troca pela fila.
    if (nearRoomEnd || nearSpotifyEnd) return true;
    // Faixa que o próprio servidor mandou há pouco (comando atrasado): só corrige.
    const sentAt = m.spotify.sentUris?.get(item.uri);
    if (sentAt && now - sentAt < SPOTIFY_SENT_MEMORY_MS) return false;

    // Próxima/anterior no app: o Spotify anda pelo álbum em que mandamos tocar,
    // então isso vira próxima/anterior da fila.
    const sameContext = t?.spotifyAlbumUri && state.context?.uri === t.spotifyAlbumUri && last?.uri === t.spotifyUri;
    if (sameContext) {
      const order = (item.disc_number || 1) * 1000 + (item.track_number || 0);
      m.spotify.lastItem = null;
      if (order < last.order) {
        console.log(`[spotify] ${m.name} voltou uma faixa no app`);
        if (this.index > 0) this.jumpTo(this.index - 1);
        else this.seek(0);
      } else {
        console.log(`[spotify] ${m.name} pulou para a próxima no app`);
        this.next();
      }
      return true;
    }

    // Escolheu outra música (busca, playlist…): entra na fila logo depois da atual e toca para todos.
    let idx = this.queue.findIndex((q, i) => i > this.index && q.spotifyUri === item.uri);
    let created = null;
    if (idx === -1) {
      created = {
        id: crypto.randomUUID(),
        title: item.name || '',
        artist: (item.artists || []).map((a) => a.name).join(', '),
        album: item.album?.name || '',
        art: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || '',
        durationMs: item.duration_ms || 0,
        isrc: item.external_ids?.isrc || null,
        spotifyUri: item.uri,
        spotifyAlbumUri: item.album?.uri || null,
        youtubeId: null,
        resolving: Boolean(this.resolveTrack),
        addedBy: `${m.name} (pelo Spotify)`,
      };
      idx = this.index + 1;
      this.queue.splice(idx, 0, created);
    }
    this.index = idx;
    m.spotify.lastItem = null;
    this.applyFromSpotify(sid, `escolheu "${item.name}"`, { positionMs: pos, playing: true });
    if (created && this.resolveTrack) this.resolveTrack(this, created.id, sid);
    return true;
  }

  applyFromSpotify(sid, what, { positionMs, playing }) {
    const m = this.members.get(sid);
    console.log(`[spotify] ${m?.name || sid} ${what} no app; a sala acompanha`);
    this.positionMs = Math.max(0, positionMs);
    this.playing = playing;
    this.ended = false;
    this.updatedAt = Date.now();
    if (m) {
      // O aparelho dele já está no estado novo: não manda comando, só confere depois.
      m.spotify.seq++;
      m.spotify.lastCommandAt = Date.now();
      m.spotify.lastCommand = null;
    }
    this.changed({ playback: true, exceptSid: sid });
  }

  async fineSeekSpotify(sid, m, seq) {
    m.spotify.seq = ++seq;
    m.spotify.lastCommandAt = Date.now();
    await spotify.player.seek(sid, m.spotify.deviceId, this.currentPosition() + m.spotify.seekCompMs);
    if (m.spotify.seq !== seq) return;
    m.spotify.lastCommandAt = Date.now();
    m.spotify.lastCommand = 'seek';
    // Confere o resultado (e calibra a compensação) logo em seguida.
    clearTimeout(m.spotify.checkTimer);
    m.spotify.checkTimer = setTimeout(() => this.checkSpotifyMember(sid).catch(() => {}), SPOTIFY_FIRST_CHECK_MS);
    m.spotify.checkTimer.unref?.();
  }

  toJSON() {
    return {
      code: this.code,
      hostSid: this.hostSid,
      queue: this.queue,
      index: this.index,
      playing: this.playing,
      ended: this.ended,
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
    this.endTimer = null;
    for (const [sid, m] of this.members) {
      clearTimeout(m.leaveTimer);
      m.leaveTimer = null;
      clearTimeout(m.spotify.checkTimer);
      m.spotify.seq++;
      if (m.platform === 'spotify') spotify.player.pause(sid, m.spotify.deviceId).catch(() => {});
    }
  }
}

function createRoom(hostSid, onChange, options) {
  const room = new Room(hostSid, onChange, options);
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase()) || null;
}

setInterval(() => {
  for (const room of rooms.values()) room.checkSpotifyDrift().catch(() => {});
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

module.exports = { createRoom, getRoom, Room, MEMBER_GRACE_MS };
