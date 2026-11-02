// Sincronização de sala com vários clientes reais (Socket.IO) contra o servidor + mocks.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startStack, spotifyLogin, sleep } = require('./helpers/harness');

const TOL = 300; // tolerância de posição entre clientes / esperado (ms)
const SPOTIFY_TOL = 1000; // position_ms enviado ao Spotify (servidor pode compensar latência)

let stack;
let seq = 0;
const ytId = () => `vid${String(++seq).padStart(8, '0')}`; // 11 chars
const track = (n, durationMs = 180000) => {
  const id = ytId();
  return { title: `Faixa ${n}`, artist: 'Artista', durationMs, youtubeId: id, spotifyUri: `spotify:track:sp${id}` };
};

// posição esperada vista pelo cliente `c` no instante local `at`
function clientPosition(c, at = Date.now()) {
  const s = c.last('state');
  const receivedAt = c.lastAt('state');
  if (!s || s.index < 0) return null;
  const serverNow = s.serverNow + (at - receivedAt);
  return s.playing ? s.positionMs + (serverNow - s.updatedAt) : s.positionMs;
}
// posição esperada a partir de um state no relógio do servidor (mesma máquina)
const statePositionAt = (s, at) => (s.playing ? s.positionMs + (at - s.updatedAt) : s.positionMs);

const signature = (s) =>
  JSON.stringify({
    ids: s.queue.map((t) => t.id),
    uris: s.queue.map((t) => [t.spotifyUri || null, t.youtubeId || null]),
    index: s.index,
    playing: s.playing,
  });

// Espera todos os clientes terem um state que satisfaz pred e com a mesma assinatura.
async function converge(clients, pred = () => true, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const states = clients.map((c) => c.last('state'));
    const okAll = states.every((s) => {
      try {
        return s && pred(s);
      } catch {
        return false;
      }
    });
    if (okAll && new Set(states.map(signature)).size === 1) return states;
    if (Date.now() > end) {
      throw new Error(
        'clientes não convergiram:\n' +
          states.map((s, i) => `  c${i}: pred=${s ? safePred(pred, s) : 'sem state'} ${s ? signature(s) : ''}`).join('\n')
      );
    }
    await sleep(20);
  }
}
function safePred(pred, s) {
  try {
    return Boolean(pred(s));
  } catch (e) {
    return `erro ${e.message}`;
  }
}

function assertPositions(clients, expected, label) {
  const at = Date.now();
  const pos = clients.map((c) => clientPosition(c, at));
  const min = Math.min(...pos);
  const max = Math.max(...pos);
  assert.ok(max - min <= TOL, `${label}: posições divergem entre clientes ${JSON.stringify(pos)}`);
  if (expected !== undefined) {
    const exp = typeof expected === 'function' ? expected(at) : expected;
    for (const p of pos) assert.ok(Math.abs(p - exp) <= TOL, `${label}: posição ${Math.round(p)} ≠ esperado ${Math.round(exp)} (±${TOL})`);
  }
  return pos;
}

async function ok(promise, label = '') {
  const ack = await promise;
  assert.ok(ack && ack.ok, `${label} ack não ok: ${JSON.stringify(ack)}`);
  return ack;
}

async function makeRoom(n, prefix = 'U') {
  const host = await stack.client();
  const { code } = await ok(host.emit('room:create', { name: `${prefix}0` }), 'room:create');
  assert.match(code, /^[A-Z0-9]{4,8}$/);
  const others = [];
  for (let i = 1; i < n; i++) {
    const c = await stack.client();
    await ok(c.emit('room:join', { code, name: `${prefix}${i}` }), 'room:join');
    others.push(c);
  }
  const all = [host, ...others];
  await converge(all, (s) => s.code === code && s.members.length === n);
  return { code, host, others, all };
}

before(async () => {
  stack = await startStack();
  // catálogo dos mocks usado na conversão cruzada
  stack.mock.addYoutubeVideo({ id: 'ytBlinding1', title: 'Blinding Lights', channelTitle: 'The Weeknd - Topic', durationMs: 200000 });
  stack.mock.addYoutubeVideo({ id: 'ytBlindLive', title: 'Blinding Lights (Live at the Arena)', channelTitle: 'Random Uploads', durationMs: 263000 });
  stack.mock.addYoutubeVideo({ id: 'ytEnvolver1', title: 'Anitta - Envolver (Official Music Video)', channelTitle: 'AnittaVEVO', durationMs: 193000 });
  stack.mock.addSpotifyTrack({ id: 'envolver1', name: 'Envolver', artists: ['Anitta'], durationMs: 193880, album: 'Versions of Me' });
  stack.mock.addSpotifyTrack({ id: 'blinding1', name: 'Blinding Lights', artists: ['The Weeknd'], durationMs: 200040, album: 'After Hours' });
});

after(async () => {
  await stack?.close();
});

describe('sala com 3+ clientes', () => {
  let room;
  const addedIds = [];

  it('criar sala, outros entram pelo código e todos recebem o mesmo estado', async () => {
    room = await makeRoom(3, 'Pessoa');
    const states = await converge(room.all, (s) => s.members.length === 3);
    for (const s of states) {
      assert.strictEqual(s.code, room.code);
      assert.deepStrictEqual(s.queue, []);
      assert.strictEqual(s.index, -1);
      assert.strictEqual(s.playing, false);
      assert.strictEqual(typeof s.serverNow, 'number');
      assert.deepStrictEqual(s.members.map((m) => m.name).sort(), ['Pessoa0', 'Pessoa1', 'Pessoa2']);
    }
    assert.strictEqual(states[0].you.isHost, true);
    assert.strictEqual(states[1].you.isHost, false);
    assert.strictEqual(states[2].you.isHost, false);

    // código inexistente falha
    const bad = await (await stack.client()).emit('room:join', { code: 'ZZZZZZ', name: 'x' });
    assert.strictEqual(bad.ok, false);
  });

  it('código digitado em minúsculas também entra na sala', async () => {
    const h = await stack.client();
    const { code } = await ok(h.emit('room:create', { name: 'H' }), 'create');
    const c = await stack.client();
    await ok(c.emit('room:join', { code: code.toLowerCase(), name: 'Minúsculo' }), 'join lowercase');
    await converge([h, c], (s) => s.code === code && s.members.length === 2);
  });

  it('adições em paralelo de clientes diferentes convergem para a mesma fila', async () => {
    const jobs = [];
    for (let round = 0; round < 3; round++) {
      room.all.forEach((c, i) => jobs.push(c.emit('queue:add', { track: track(`${i}-${round}`) })));
    }
    const acks = await Promise.all(jobs);
    for (const a of acks) {
      assert.ok(a.ok, JSON.stringify(a));
      assert.ok(a.id, 'ack de queue:add deve trazer id');
      addedIds.push(a.id);
    }
    const states = await converge(room.all, (s) => s.queue.length === 9 && s.queue.every((t) => !t.resolving));
    assert.deepStrictEqual(new Set(states[0].queue.map((t) => t.id)), new Set(addedIds));
    assert.strictEqual(new Set(addedIds).size, 9, 'ids únicos');
    assert.strictEqual(states[0].index, 0);
    assert.strictEqual(states[0].playing, true);
    assertPositions(room.all);
  });

  it('next / prev / jump mantêm todos iguais e a posição recomeça em 0', async () => {
    const ids = room.host.last('state').queue.map((t) => t.id);

    await ok(room.others[0].emit('player:next'), 'next');
    let t0 = Date.now();
    await converge(room.all, (s) => s.index === 1 && s.playing);
    assertPositions(room.all, (at) => at - t0);

    await ok(room.others[1].emit('player:prev'), 'prev');
    t0 = Date.now();
    await converge(room.all, (s) => s.index === 0 && s.playing);
    assertPositions(room.all, (at) => at - t0);

    await ok(room.host.emit('player:jump', { index: 4 }), 'jump');
    t0 = Date.now();
    const [s] = await converge(room.all, (st) => st.index === 4 && st.playing);
    assert.strictEqual(s.queue[4].id, ids[4]);
    assertPositions(room.all, (at) => at - t0);
  });

  it('seek / pause / play: posição coerente em todos', async () => {
    await ok(room.others[0].emit('player:seek', { ms: 60000 }), 'seek');
    const tSeek = Date.now();
    await converge(room.all, (s) => s.index === 4 && s.playing && s.positionMs >= 59000);
    assertPositions(room.all, (at) => 60000 + (at - tSeek));

    await sleep(300);
    await ok(room.others[1].emit('player:pause'), 'pause');
    const [paused] = await converge(room.all, (s) => !s.playing && s.index === 4);
    const frozen = paused.positionMs;
    assert.ok(frozen >= 60000 && frozen <= 60000 + 300 + 600, `posição congelada ${frozen}`);
    assertPositions(room.all, frozen);
    await sleep(400);
    assertPositions(room.all, frozen); // não anda durante a pausa

    await ok(room.host.emit('player:play'), 'play');
    const tPlay = Date.now();
    await converge(room.all, (s) => s.playing && s.index === 4);
    assertPositions(room.all, (at) => frozen + (at - tPlay));
  });

  it('remove e move mantêm a mesma fila e a faixa atual', async () => {
    let s = room.host.last('state');
    const currentId = s.queue[s.index].id;
    const beforeId = s.queue[1].id;
    const posBefore = clientPosition(room.host);

    // remove faixa anterior à atual: atual continua tocando, sem reiniciar
    await ok(room.others[0].emit('queue:remove', { trackId: beforeId }), 'remove anterior');
    [s] = await converge(room.all, (st) => st.queue.length === 8 && !st.queue.some((t) => t.id === beforeId));
    assert.strictEqual(s.queue[s.index].id, currentId, 'faixa atual deve continuar a mesma');
    assert.strictEqual(s.index, 3);
    const pos = assertPositions(room.all);
    assert.ok(pos[0] >= posBefore - TOL, `remover anterior não pode reiniciar a faixa atual (${pos[0]} < ${posBefore})`);

    // move: última sobe uma posição
    const q = s.queue.map((t) => t.id);
    const last = q[q.length - 1];
    await ok(room.others[1].emit('queue:move', { trackId: last, delta: -1 }), 'move');
    const expectedOrder = [...q];
    [expectedOrder[q.length - 2], expectedOrder[q.length - 1]] = [expectedOrder[q.length - 1], expectedOrder[q.length - 2]];
    [s] = await converge(room.all, (st) => st.queue.map((t) => t.id).join() === expectedOrder.join());
    assert.strictEqual(s.queue[s.index].id, currentId);

    // remove a faixa atual: a próxima assume, posição 0, todos iguais
    const nextId = s.queue[s.index + 1].id;
    await ok(room.host.emit('queue:remove', { trackId: currentId }), 'remove atual');
    const t0 = Date.now();
    [s] = await converge(room.all, (st) => !st.queue.some((t) => t.id === currentId) && st.queue[st.index]?.id === nextId);
    assert.strictEqual(s.playing, true);
    assertPositions(room.all, (at) => at - t0);
  });

  it('quem entra atrasado recebe a fila completa e a mesma posição', async () => {
    await ok(room.host.emit('player:seek', { ms: 42000 }), 'seek');
    const tSeek = Date.now();
    await converge(room.all, (s) => s.positionMs >= 41000);
    await sleep(250);
    const late = await stack.client();
    await ok(late.emit('room:join', { code: room.code, name: 'Atrasado' }), 'join atrasado');
    const everyone = [...room.all, late];
    const [s] = await converge(everyone, (st) => st.members.some((m) => m.name === 'Atrasado'));
    assert.strictEqual(late.last('state').queue.length, s.queue.length);
    assertPositions(everyone, (at) => 42000 + (at - tSeek));
    late.close();
  });
});

describe('fim da fila', () => {
  it('adicionar faixa depois que a fila acabou começa a tocar a nova faixa', async () => {
    const r = await makeRoom(3, 'Fim');
    const a = await ok(r.host.emit('queue:add', { track: track('curta', 800) }), 'add curta');
    await converge(r.all, (s) => s.index === 0 && s.playing && s.queue[0].id === a.id);
    // acaba sozinha
    await converge(r.all, (s) => s.playing === false, 4000);

    const b = await ok(r.others[1].emit('queue:add', { track: track('nova') }), 'add nova');
    const t0 = Date.now();
    const [s] = await converge(r.all, (st) => st.queue.length === 2, 3000);
    assert.strictEqual(s.queue[s.index]?.id, b.id, `deveria estar tocando a nova faixa (index=${s.index})`);
    assert.strictEqual(s.playing, true, 'deveria estar tocando');
    assertPositions(r.all, (at) => at - t0);
  });
});

describe('conversão cruzada Spotify <-> YouTube', () => {
  let r;
  before(async () => {
    r = await makeRoom(3, 'Conv');
  });

  it('sem nenhum membro com Spotify e sem secret, busca no Spotify pede para conectar', async () => {
    const ack = await r.others[0].emit('search', { q: 'Envolver', source: 'spotify' });
    assert.strictEqual(ack.ok, false, JSON.stringify(ack));
    assert.match(ack.error || '', /Conecte o Spotify/);
  });

  it('faixa do Spotify ganha youtubeId', async () => {
    const add = await ok(
      r.host.emit('queue:add', {
        track: { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200040, spotifyUri: 'spotify:track:blinding1', isrc: null },
      }),
      'add spotify'
    );
    const [s] = await converge(r.all, (st) => st.queue.find((t) => t.id === add.id && !t.resolving && t.youtubeId), 5000);
    assert.strictEqual(s.queue.find((t) => t.id === add.id).youtubeId, 'ytBlinding1');
  });

  it('link do YouTube ganha spotifyUri usando o token de um membro conectado', async () => {
    const member = r.others[1];
    const login = await spotifyLogin(stack, { sid: member.sid, room: r.code, intent: 'join', name: 'Conv2', user: 'conv-user' });
    assert.strictEqual(login.callbackParams.spotify, 'ok', login.callbackLocation);
    await converge(r.all, (st) => st.members.some((m) => m.spotifyConnected));

    // quem busca/adiciona NÃO está conectado (r.others[0])
    const searcher = r.others[0];
    const search = await ok(searcher.emit('search', { q: 'https://www.youtube.com/watch?v=ytEnvolver1', source: 'youtube' }), 'search link');
    assert.strictEqual(search.results?.[0]?.youtubeId, 'ytEnvolver1');

    const searchesBefore = stack.mock.state.spotifySearches.length;
    const add = await ok(searcher.emit('queue:add', { track: search.results[0] }), 'add youtube');
    const [s] = await converge(r.all, (st) => st.queue.find((t) => t.id === add.id && !t.resolving && t.spotifyUri), 5000);
    const t = s.queue.find((x) => x.id === add.id);
    assert.strictEqual(t.spotifyUri, 'spotify:track:envolver1');
    assert.strictEqual(t.youtubeId, 'ytEnvolver1');

    const used = stack.mock.state.spotifySearches.slice(searchesBefore);
    assert.ok(used.length > 0, 'deveria ter buscado no Spotify');
    for (const q of used) {
      assert.strictEqual(q.user, 'conv-user', 'busca deve usar o token do membro conectado da sala');
      assert.ok(q.limit <= 10, `limit ${q.limit} > 10`);
    }

    // busca direta no Spotify por quem não está conectado agora funciona (token do membro)
    const sp = await ok(searcher.emit('search', { q: 'Envolver', source: 'spotify' }), 'search spotify');
    assert.strictEqual(sp.results?.[0]?.spotifyUri, 'spotify:track:envolver1');
    assert.strictEqual(sp.results[0].isrc ?? null, null);
    assert.ok(stack.mock.state.spotifySearches.every((q) => q.limit <= 10), 'nenhuma busca com limit > 10');
  });
});

describe('membro no Spotify', () => {
  let r;
  let spMember;
  const USER = 'sp-user';
  const plays = (since) => stack.mock.playerCallsFor(USER).slice(since);

  async function expectPlay(since, uri, label) {
    const call = await stack.mock.waitFor(() => plays(since).find((c) => c.op === 'play' && c.uris?.[0] === uri), {
      timeoutMs: 4000,
      message: `${label}: PUT /me/player/play com ${uri}; chamadas: ${JSON.stringify(plays(since))}`,
    });
    // compara com a posição esperada no instante em que o mock recebeu a chamada
    const s = r.host.last('state');
    const expected = statePositionAt(s, call.at);
    assert.ok(
      Math.abs(call.position_ms - expected) <= SPOTIFY_TOL,
      `${label}: position_ms ${call.position_ms} longe do esperado ${Math.round(expected)}`
    );
    return call;
  }

  it('saída para o login e volta com o mesmo sid mantém o lugar; platform:set spotify', async () => {
    r = await makeRoom(3, 'Sp');
    spMember = r.others[0];
    const sid = spMember.sid;
    spMember.close(); // página sai para o Spotify
    const login = await spotifyLogin(stack, { sid, room: r.code, intent: 'join', name: 'Sp1', user: USER });
    assert.strictEqual(login.callbackParams.spotify, 'ok');
    assert.strictEqual(login.callbackParams.room, r.code);

    spMember = await stack.client({ sid });
    await ok(spMember.emit('room:join', { code: r.code, name: 'Sp1' }), 'rejoin');
    r.others[0] = spMember;
    r.all = [r.host, ...r.others];
    const ack = await ok(spMember.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    assert.ok(!ack.needsAuth, 'já conectado: não deveria pedir auth');
    const states = await converge(r.all, (s) => s.members.length === 3);
    assert.strictEqual(states[0].you.isHost, true);
    assert.strictEqual(spMember.last('state').you.platform, 'spotify');
    assert.strictEqual(spMember.last('state').you.spotifyConnected, true);
  });

  it('cada troca de faixa, seek e play geram PUT play com uri e posição; pause gera PUT pause', async () => {
    const tracks = [track('s1'), track('s2'), track('s3')];
    let since = plays(0).length;
    for (const t of tracks) await ok(r.host.emit('queue:add', { track: t }), 'add');
    await converge(r.all, (s) => s.queue.length === 3);
    await expectPlay(since, tracks[0].spotifyUri, 'primeira faixa');

    since = plays(0).length;
    await ok(r.others[1].emit('player:next'), 'next');
    await expectPlay(since, tracks[1].spotifyUri, 'next');

    since = plays(0).length;
    await ok(r.host.emit('player:seek', { ms: 30000 }), 'seek');
    const seekCall = await expectPlay(since, tracks[1].spotifyUri, 'seek');
    assert.ok(seekCall.position_ms >= 29000, `seek position_ms ${seekCall.position_ms}`);

    since = plays(0).length;
    await ok(r.others[1].emit('player:pause'), 'pause');
    await stack.mock.waitFor(() => plays(since).find((c) => c.op === 'pause'), { message: 'PUT /me/player/pause' });
    await converge(r.all, (s) => !s.playing);

    await sleep(300);
    since = plays(0).length;
    await ok(r.host.emit('player:play'), 'play');
    await expectPlay(since, tracks[1].spotifyUri, 'play depois do pause');

    since = plays(0).length;
    await ok(r.host.emit('player:jump', { index: 2 }), 'jump');
    await expectPlay(since, tracks[2].spotifyUri, 'jump');

    since = plays(0).length;
    await ok(r.host.emit('player:prev'), 'prev');
    await expectPlay(since, tracks[1].spotifyUri, 'prev');
  });

  it('Spotify que parou de tocar sozinho (nada tocando) recebe a faixa da sala de novo', { timeout: 40000 }, async () => {
    const s = r.host.last('state');
    const uri = s.queue[s.index].spotifyUri;
    await sleep(6500); // passa o período de carência após o último comando
    stack.mock.setPlayer(USER, { uri: null, isPlaying: false, progressMs: 0 });
    const since = plays(0).length;
    const call = await stack.mock.waitFor(() => plays(since).find((c) => c.op === 'play' && c.uris?.[0] === uri), {
      timeoutMs: 20000,
      intervalMs: 100,
      message: 'correção (PUT play com a faixa da sala)',
    });
    const expected = statePositionAt(r.host.last('state'), call.at);
    assert.ok(Math.abs(call.position_ms - expected) <= SPOTIFY_TOL, `drift: position_ms ${call.position_ms} vs ${Math.round(expected)}`);
  });
});

describe('app do Spotify como controle da sala', () => {
  const USER = 'ctl-user';
  const ALB = 'spotify:album:albCtl';
  let r;
  let sp; // membro que ouve pelo Spotify e mexe no app
  const plays = (since) => stack.mock.playerCallsFor(USER).slice(since);
  const appPos = () => {
    const p = stack.mock.player(USER);
    return p.isPlaying ? p.progressMs + (Date.now() - p.at) : p.progressMs;
  };
  const roomPos = (s) => statePositionAt(s, Date.now());
  // Depois de uma mudança na sala, espera os comandos assentarem e o servidor registrar o que está tocando.
  const settle = () => sleep(8000);
  const q = (id, albumId) => ({
    title: id,
    artist: 'Banda',
    durationMs: 240000,
    youtubeId: `yt${id}`.padEnd(11, 'x').slice(0, 11),
    spotifyUri: `spotify:track:${id}`,
    spotifyAlbumUri: `spotify:album:${albumId}`,
  });

  before(async () => {
    // Álbum com 3 faixas: a fila toca a do meio (ctl2); a próxima da fila é de outro álbum.
    stack.mock.addSpotifyTrack({ id: 'ctl1', name: 'Ctl Um', artists: ['Banda'], durationMs: 240000, albumId: 'albCtl', trackNumber: 1 });
    stack.mock.addSpotifyTrack({ id: 'ctl2', name: 'Ctl Dois', artists: ['Banda'], durationMs: 240000, albumId: 'albCtl', trackNumber: 2 });
    stack.mock.addSpotifyTrack({ id: 'ctl3', name: 'Ctl Tres', artists: ['Banda'], durationMs: 240000, albumId: 'albCtl', trackNumber: 3 });
    stack.mock.addSpotifyTrack({ id: 'prox1', name: 'Proxima Fila', artists: ['Outra'], durationMs: 240000, albumId: 'albProx', trackNumber: 2 });
    stack.mock.addSpotifyTrack({ id: 'escolhida1', name: 'Escolhida No App', artists: ['Cantora'], durationMs: 200000, albumId: 'albEsc', trackNumber: 4 });
    stack.mock.addYoutubeVideo({ id: 'ytEscolhida', title: 'Cantora - Escolhida No App', channelTitle: 'Cantora - Topic', durationMs: 200000 });

    r = await makeRoom(2, 'Ctl');
    sp = r.others[0];
    await spotifyLogin(stack, { sid: sp.sid, room: r.code, intent: 'join', name: 'Ctl1', user: USER });
    await ok(sp.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    await ok(r.host.emit('queue:add', { track: q('ctl2', 'albCtl') }), 'add 1');
    await ok(r.host.emit('queue:add', { track: q('prox1', 'albProx') }), 'add 2');
    await stack.mock.waitFor(() => plays(0).find((c) => c.op === 'play' && (c.uris?.[0] || '').endsWith('ctl2')), { message: 'play inicial' });
    await settle();
  });

  it('pausar no app pausa a sala para todos', { timeout: 30000 }, async () => {
    stack.mock.setPlayer(USER, { isPlaying: false });
    const states = await converge(r.all, (s) => !s.playing, 8000);
    assert.ok(Math.abs(states[0].positionMs - appPos()) < 1000, `posição ${states[0].positionMs} vs app ${appPos()}`);
  });

  it('dar play no app volta a tocar a sala', { timeout: 30000 }, async () => {
    await settle();
    stack.mock.setPlayer(USER, { isPlaying: true });
    const states = await converge(r.all, (s) => s.playing, 8000);
    assert.ok(Math.abs(roomPos(states[0]) - appPos()) < 1000);
  });

  it('pular para outro ponto no app move a sala', { timeout: 30000 }, async () => {
    await settle();
    stack.mock.setPlayer(USER, { progressMs: 120000 });
    await converge(r.all, (s) => s.playing && roomPos(s) > 115000, 8000);
    assert.ok(Math.abs(roomPos(r.host.last('state')) - appPos()) < 1000);
  });

  it('"próxima" no app (anda pelo álbum) vira próxima da fila; o Spotify vai para a faixa da fila', { timeout: 30000 }, async () => {
    await settle();
    const since = plays(0).length;
    stack.mock.setPlayer(USER, { uri: 'spotify:track:ctl3', contextUri: ALB, isPlaying: true, progressMs: 0 });
    const states = await converge(r.all, (s) => s.index === 1, 8000);
    assert.strictEqual(states[0].queue.length, 2, 'não deveria adicionar a faixa do álbum na fila');
    await stack.mock.waitFor(() => plays(since).find((c) => c.op === 'play' && (c.uris?.[0] || '').endsWith('prox1')), {
      message: 'PUT play com a próxima da fila',
    });
  });

  it('"anterior" no app volta uma faixa na fila', { timeout: 30000 }, async () => {
    await settle();
    // A faixa atual (prox1) é a 2ª do álbum dela; o app volta para a 1ª do mesmo contexto.
    stack.mock.addSpotifyTrack({ id: 'prox0', name: 'Antes', artists: ['Outra'], durationMs: 240000, albumId: 'albProx', trackNumber: 1 });
    stack.mock.setPlayer(USER, { uri: 'spotify:track:prox0', contextUri: 'spotify:album:albProx', isPlaying: true, progressMs: 0 });
    await converge(r.all, (s) => s.index === 0, 8000);
  });

  it('escolher outra música no app coloca ela na fila depois da atual e toca para todos', { timeout: 40000 }, async () => {
    await settle();
    const since = plays(0).length;
    stack.mock.setPlayer(USER, { uri: 'spotify:track:escolhida1', contextUri: 'spotify:playlist:minha', isPlaying: true, progressMs: 5000 });
    const states = await converge(r.all, (s) => s.queue.length === 3 && s.index === 1, 8000);
    const t = states[0].queue[1];
    assert.strictEqual(t.title, 'Escolhida No App');
    assert.strictEqual(t.spotifyUri, 'spotify:track:escolhida1');
    assert.match(t.addedBy, /pelo Spotify/);
    assert.ok(Math.abs(roomPos(states[0]) - appPos()) < 1500, 'sala na posição do app');
    // Quem escolheu já está tocando: não recebe comando de play.
    await sleep(1500);
    assert.ok(!plays(since).some((c) => c.op === 'play'), `não deveria mandar play: ${JSON.stringify(plays(since))}`);
    // O vídeo do YouTube é procurado sozinho.
    const withVideo = await r.host.waitFor('state', (s) => s.queue[1]?.youtubeId === 'ytEscolhida', 8000);
    assert.ok(withVideo);
  });

  it('fim natural da música: o Spotify seguir sozinho para a próxima do álbum não muda a fila', { timeout: 40000 }, async () => {
    const short = { ...q('ctl1', 'albCtl'), durationMs: 14000 };
    await ok(r.host.emit('queue:add', { track: short }), 'add curta');
    const idx = r.host.last('state').queue.length - 1;
    await ok(r.host.emit('player:jump', { index: idx }), 'jump');
    await sleep(11000); // perto do fim (faltam ~3s)
    stack.mock.setPlayer(USER, { uri: 'spotify:track:ctl2', contextUri: ALB, isPlaying: true, progressMs: 0 });
    await sleep(2500);
    const s = r.host.last('state');
    assert.strictEqual(s.index, idx, 'ainda na faixa curta (a sala decide quando acaba)');
    assert.strictEqual(s.queue.length, idx + 1, 'não adicionou a faixa do álbum');
  });
});

describe('Spotify: ajuste fino do atraso ao começar a tocar', () => {
  it('celular que começa ~1s atrasado é corrigido por seek para menos de 400 ms', { timeout: 40000 }, async () => {
    const USER = 'lag-user';
    // Como o razr 60 medido de verdade: começa ~1s atrás; o seek também chega com atraso.
    stack.mock.setPlayer(USER, { startLagMs: 1000, seekLagMs: 300 });
    const r = await makeRoom(2, 'Lag');
    const m = r.others[0];
    await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'Lag1', user: USER });
    await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    const t = track('lag');
    await ok(r.host.emit('queue:add', { track: t }), 'add');

    const drift = () => {
      const p = stack.mock.player(USER);
      const now = Date.now();
      const pos = p.isPlaying ? p.progressMs + (now - p.at) : p.progressMs;
      return pos - statePositionAt(r.host.last('state'), now);
    };
    await stack.mock.waitFor(() => stack.mock.playerCallsFor(USER).find((c) => c.op === 'play'), { message: 'play' });
    assert.ok(drift() < -700, `deveria começar atrasado (simulação), drift=${drift()}`);

    await stack.mock.waitFor(() => stack.mock.playerCallsFor(USER).find((c) => c.op === 'seek'), {
      timeoutMs: 8000,
      intervalMs: 100,
      message: 'seek de ajuste fino',
    });
    // Depois de calibrar a compensação, fica dentro da tolerância fina sem novos plays.
    const playsBefore = stack.mock.playerCallsFor(USER).filter((c) => c.op === 'play').length;
    await stack.mock.waitFor(() => Math.abs(drift()) < 400 && stack.mock.playerCallsFor(USER).filter((c) => c.op === 'seek').length >= 1, {
      timeoutMs: 15000,
      intervalMs: 200,
      message: `atraso abaixo de 400 ms (atual ${drift()} ms)`,
    });
    await sleep(5000);
    assert.ok(Math.abs(drift()) < 400, `continua sincronizado, drift=${drift()}`);
    assert.strictEqual(stack.mock.playerCallsFor(USER).filter((c) => c.op === 'play').length, playsBefore, 'não deveria mandar novo play');
  });
});

describe('Spotify sem aparelho "ativo" (celular aberto, mas parado)', () => {
  it('servidor acha o celular na lista e toca nele; mostra a conta conectada', async () => {
    const USER = 'idle-user';
    stack.mock.setPlayer(USER, {
      devices: [
        { id: 'pc-1', name: 'PC', type: 'Computer', is_active: false, is_restricted: false },
        { id: 'cel-1', name: 'Meu celular', type: 'Smartphone', is_active: false, is_restricted: false },
      ],
    });
    const r = await makeRoom(2, 'Idle');
    const m = r.others[0];
    await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'Idle1', user: USER });
    await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    const t = track('idle');
    await ok(r.host.emit('queue:add', { track: t }), 'add');
    const call = await stack.mock.waitFor(
      () => stack.mock.playerCallsFor(USER).find((c) => c.op === 'play' && c.uris?.[0] === t.spotifyUri),
      { timeoutMs: 4000, message: 'PUT play no celular depois do NO_ACTIVE_DEVICE' }
    );
    assert.strictEqual(call.deviceId, 'cel-1', 'deveria escolher o celular');
    const s = await m.waitFor('state', (st) => st.you.spotifyAccount === `Conta ${USER}` && !st.you.spotifyError && st.you.spotifyDeviceId, 6000);
    assert.strictEqual(s.you.spotifyDeviceId, 'cel-1');

    // próximas faixas vão direto para o celular, sem novo 404
    const failsBefore = stack.mock.playerCallsFor(USER).filter((c) => c.op === 'play-failed').length;
    const t2 = track('idle2');
    await ok(r.host.emit('queue:add', { track: t2 }), 'add 2');
    await ok(r.host.emit('player:next'), 'next');
    await stack.mock.waitFor(
      () => stack.mock.playerCallsFor(USER).find((c) => c.op === 'play' && c.uris?.[0] === t2.spotifyUri && c.deviceId === 'cel-1'),
      { timeoutMs: 4000, message: 'next vai para o celular' }
    );
    assert.strictEqual(stack.mock.playerCallsFor(USER).filter((c) => c.op === 'play-failed').length, failsBefore);
  });

  it('celular que não é o ativo recebe transferência antes do play', async () => {
    const USER = 'transfer-user';
    stack.mock.setPlayer(USER, {
      devices: [
        { id: 'pc-2', name: 'TWOD', type: 'Computer', is_active: true, is_restricted: false },
        { id: 'cel-2', name: 'razr', type: 'Smartphone', is_active: false, is_restricted: false },
      ],
    });
    const r = await makeRoom(2, 'Tr');
    const m = r.others[0];
    await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'Tr1', user: USER });
    await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    await ok(m.emit('spotify:device', { deviceId: 'cel-2' }), 'escolhe o celular');
    const t = track('tr');
    await ok(r.host.emit('queue:add', { track: t }), 'add');
    await stack.mock.waitFor(
      () => stack.mock.playerCallsFor(USER).find((c) => c.op === 'play' && c.uris?.[0] === t.spotifyUri && c.deviceId === 'cel-2'),
      { timeoutMs: 6000, message: 'play no celular' }
    );
    const calls = stack.mock.playerCallsFor(USER);
    const iTransfer = calls.findIndex((c) => c.op === 'transfer' && /cel-2/.test(c.body));
    const iPlay = calls.findIndex((c) => c.op === 'play' && c.deviceId === 'cel-2');
    assert.ok(iTransfer !== -1 && iTransfer < iPlay, `transferência antes do play: ${JSON.stringify(calls.map((c) => c.op))}`);
  });

  it('Android que ignora `uris` (falha do Spotify out/2026): toca pelo álbum e a faixa certa começa', async () => {
    const USER = 'android-user';
    stack.mock.setPlayer(USER, {
      ignoreUris: true,
      devices: [{ id: 'razr', name: 'motorola razr 60', type: 'Smartphone', is_active: true, is_restricted: false }],
    });
    const r = await makeRoom(2, 'And');
    const m = r.others[0];
    await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'And1', user: USER });
    await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    // Busca de verdade (como o app faz), para a faixa vir com o álbum.
    const found = await ok(m.emit('search', { q: 'Envolver', source: 'spotify' }), 'search');
    const hit = found.results.find((x) => x.spotifyUri === 'spotify:track:envolver1');
    assert.strictEqual(hit.spotifyAlbumUri, 'spotify:album:albenvolver1');
    await ok(r.host.emit('queue:add', { track: hit }), 'add');
    const call = await stack.mock.waitFor(
      () => stack.mock.playerCallsFor(USER).find((c) => c.op === 'play' && c.uris?.[0] === hit.spotifyUri),
      { timeoutMs: 5000, message: 'play pelo álbum' }
    );
    assert.strictEqual(call.contextUri, 'spotify:album:albenvolver1');
    assert.strictEqual(stack.mock.player(USER).uri, hit.spotifyUri);
    assert.strictEqual(stack.mock.player(USER).isPlaying, true);
    assert.ok(!stack.mock.playerCallsFor(USER).some((c) => c.op === 'play-ignored'), 'não deveria precisar de uris');
  });

  it('aparelho que aceita o comando mas não toca: erro claro na tela', { timeout: 20000 }, async () => {
    const USER = 'deaf-user';
    stack.mock.setPlayer(USER, {
      devices: [{ id: 'cel-3', name: 'surdo', type: 'Smartphone', is_active: true, is_restricted: false }],
    });
    // Simula o celular que responde 204 mas nunca começa: /me/player sempre vazio.
    const prev = stack.mock.state.playerFailure;
    stack.mock.state.playerFailure = (user, op) => (user === USER && op === 'GET /me/player' ? { status: 204 } : prev?.(user, op));
    try {
      const r = await makeRoom(2, 'Deaf');
      const m = r.others[0];
      await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'Deaf1', user: USER });
      await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
      await ok(r.host.emit('queue:add', { track: track('deaf') }), 'add');
      const s = await m.waitFor('state', (st) => /não começou a tocar/.test(st.you.spotifyError || ''), 10000);
      assert.match(s.you.spotifyError, /surdo/);
    } finally {
      stack.mock.state.playerFailure = prev;
    }
  });

  it('sem nenhum aparelho na conta: mensagem diz qual conta está conectada', async () => {
    const USER = 'no-device-user';
    stack.mock.setPlayer(USER, { devices: [] });
    const r = await makeRoom(2, 'NoDev');
    const m = r.others[0];
    await spotifyLogin(stack, { sid: m.sid, room: r.code, intent: 'join', name: 'NoDev1', user: USER });
    await ok(m.emit('platform:set', { platform: 'spotify' }), 'platform:set');
    await ok(r.host.emit('queue:add', { track: track('nodev') }), 'add');
    const s = await m.waitFor('state', (st) => /Conta no-device-user/.test(st.you.spotifyError || ''), 4000);
    assert.match(s.you.spotifyError, /mesma conta/);
  });
});

describe('reconexão com o mesmo sid', () => {
  it('host que sai (login) e volta continua host e ninguém é duplicado', async () => {
    const r = await makeRoom(3, 'Re');
    await ok(r.host.emit('queue:add', { track: track('re') }), 'add');
    await converge(r.all, (s) => s.queue.length === 1);
    const sid = r.host.sid;
    const hostName = 'Re0';
    r.host.close();

    // enquanto está fora (no login), continua listado na sala
    await sleep(1000);
    const during = r.others[0].last('state');
    assert.ok(
      during.members.some((m) => m.name === hostName),
      `host sumiu da sala enquanto estava no login: ${JSON.stringify(during.members)}`
    );

    // usa o login (vai e volta) com o mesmo sid
    await spotifyLogin(stack, { sid, room: r.code, intent: 'create', name: hostName, user: 're-host' });
    const back = await stack.client({ sid });
    await ok(back.emit('room:join', { code: r.code, name: hostName }), 'rejoin host');
    const all = [back, ...r.others];
    const states = await converge(all, (s) => s.members.length === 3 && s.queue.length === 1);
    assert.strictEqual(states[0].you.isHost, true, 'host deve continuar host');
    assert.strictEqual(states[1].you.isHost, false);
    assert.strictEqual(states[0].members.filter((m) => m.name === hostName).length, 1);
  });

  it('membro comum que sai e volta mantém o lugar (sem duplicar)', async () => {
    const r = await makeRoom(3, 'Mc');
    const sid = r.others[1].sid;
    r.others[1].close();
    await sleep(1000);
    assert.ok(
      r.host.last('state').members.some((m) => m.name === 'Mc2'),
      `membro sumiu da sala ao sair para o login: ${JSON.stringify(r.host.last('state').members)}`
    );
    const back = await stack.client({ sid });
    await ok(back.emit('room:join', { code: r.code, name: 'Mc2' }), 'rejoin');
    const states = await converge([r.host, r.others[0], back], (s) => s.members.length === 3);
    assert.strictEqual(states[0].you.isHost, true);
    assert.strictEqual(states[2].you.isHost, false);
  });
});
