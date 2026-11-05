// Cápsula sonora: mais ouvidos e histórico recente do Spotify.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startStack, spotifyLogin } = require('./helpers/harness');

let stack;
before(async () => {
  stack = await startStack();
  const m = stack.mock;
  m.addSpotifyTrack({ id: 'trkA1', name: 'Primeira', artists: ['Banda A'], durationMs: 200_000 });
  m.addSpotifyTrack({ id: 'trkA2', name: 'Segunda', artists: ['Banda A', 'Convidada'], durationMs: 180_000 });
  m.addSpotifyTrack({ id: 'trkB1', name: 'Outra', artists: ['Banda B'], durationMs: 240_000 });
  m.state.topArtists = [
    { id: 'artA', name: 'Banda A', genres: ['rock', 'indie', 'pop', 'extra'], images: [{ url: 'https://i.scdn.co/image/a640', width: 640 }, { url: 'https://i.scdn.co/image/a160', width: 160 }], external_urls: { spotify: 'https://open.spotify.com/artist/artA' } },
    { id: 'artB', name: 'Banda B', genres: [], images: [] },
  ];
  m.state.topTracks = ['trkA1', 'trkB1', 'trkA2'];
  m.state.recentlyPlayed = [
    { id: 'trkB1', playedAt: '2026-11-03T21:00:00.000Z' },
    { id: 'trkA1', playedAt: '2026-11-03T20:55:00.000Z' },
  ];
});
after(async () => {
  await stack?.close();
});

const ok = async (p, label) => {
  const res = await p;
  assert.ok(res?.ok, `${label}: ${JSON.stringify(res)}`);
  return res;
};

async function connected(user) {
  const sid = crypto.randomUUID();
  const login = await spotifyLogin(stack, { sid, intent: 'capsule', user });
  assert.strictEqual(login.callbackParams.spotify, 'ok');
  assert.strictEqual(login.callbackParams.intent, 'capsule');
  return stack.client({ sid });
}

describe('cápsula sonora', () => {
  it('o login pede os escopos de mais ouvidos e histórico', async () => {
    const login = await spotifyLogin(stack, { sid: crypto.randomUUID(), intent: 'capsule', user: 'cap0' });
    const scopes = (login.authorizeQuery.scope || '').split(' ');
    assert.ok(scopes.includes('user-top-read'), login.authorizeQuery.scope);
    assert.ok(scopes.includes('user-read-recently-played'), login.authorizeQuery.scope);
  });

  it('sem Spotify conectado pede login', async () => {
    const c = await stack.client();
    const res = await ok(c.emit('capsule:top', { range: 'short_term' }), 'capsule:top');
    assert.strictEqual(res.needsAuth, true);
    const rec = await ok(c.emit('capsule:recent'), 'capsule:recent');
    assert.strictEqual(rec.needsAuth, true);
  });

  it('mais ouvidos: artistas e músicas do período pedido', async () => {
    const c = await connected('cap1');
    const res = await ok(c.emit('capsule:top', { range: 'medium_term' }), 'capsule:top');
    assert.ok(!res.needsAuth);
    assert.deepStrictEqual(res.artists.map((a) => a.name), ['Banda A', 'Banda B']);
    assert.strictEqual(res.artists[0].art, 'https://i.scdn.co/image/a160', 'menor imagem que ainda é nítida');
    assert.deepStrictEqual(res.artists[0].genres, ['rock', 'indie', 'pop']);
    assert.strictEqual(res.artists[1].art, '');
    assert.deepStrictEqual(res.tracks.map((t) => t.id), ['trkA1', 'trkB1', 'trkA2']);
    assert.deepStrictEqual(res.tracks[2].artists, ['Banda A', 'Convidada']);
    assert.strictEqual(res.tracks[2].artist, 'Banda A');
    const reqs = stack.mock.state.statsRequests.filter((r) => r.user === 'cap1');
    assert.ok(reqs.length >= 2 && reqs.every((r) => r.query.time_range === 'medium_term'), JSON.stringify(reqs));
  });

  it('período inválido cai nas últimas 4 semanas', async () => {
    const c = await connected('cap2');
    await ok(c.emit('capsule:top', { range: 'sempre' }), 'capsule:top');
    const reqs = stack.mock.state.statsRequests.filter((r) => r.user === 'cap2');
    assert.ok(reqs.every((r) => r.query.time_range === 'short_term'), JSON.stringify(reqs));
  });

  it('histórico recente com horário de cada reprodução', async () => {
    const c = await connected('cap3');
    const res = await ok(c.emit('capsule:recent'), 'capsule:recent');
    assert.deepStrictEqual(
      res.items.map((i) => [i.id, i.playedAt, i.durationMs]),
      [
        ['trkB1', Date.parse('2026-11-03T21:00:00.000Z'), 240_000],
        ['trkA1', Date.parse('2026-11-03T20:55:00.000Z'), 200_000],
      ]
    );
  });

  it('login antigo, sem os escopos novos, pede para entrar de novo', async () => {
    stack.mock.state.grantedScope = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
    try {
      const c = await connected('cap4');
      const res = await ok(c.emit('capsule:top', {}), 'capsule:top');
      assert.strictEqual(res.needsAuth, true);
    } finally {
      stack.mock.state.grantedScope = null;
    }
  });

  it('entrar no Spotify só para ver a cápsula não muda onde a pessoa ouve na sala', async () => {
    const host = await stack.client();
    const created = await ok(host.emit('room:create', { name: 'Host' }), 'room:create');
    const sid = crypto.randomUUID();
    const member = await stack.client({ sid });
    await ok(member.emit('room:join', { code: created.code, name: 'Yt' }), 'room:join');
    await ok(member.emit('platform:set', { platform: 'youtube' }), 'platform:set');
    const login = await spotifyLogin(stack, { sid, room: created.code, intent: 'capsule', user: 'cap5' });
    assert.strictEqual(login.callbackParams.room, created.code);
    const st = await member.waitFor('state', (s) => s.members?.length === 2);
    assert.strictEqual(st.you.platform, 'youtube');
  });
});
