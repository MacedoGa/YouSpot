// YouTube sem YOUTUBE_API_KEY: busca e links funcionam pela API interna do site (InnerTube).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startStack } = require('./helpers/harness');

let stack;
let client;

const ok = async (p, label) => {
  const ack = await p;
  assert.ok(ack?.ok, `${label}: ${JSON.stringify(ack)}`);
  return ack;
};

before(async () => {
  stack = await startStack({ youtubeKey: '' });
  stack.mock.addYoutubeVideo({ id: 'ytBlinding1', title: 'Blinding Lights', channelTitle: 'The Weeknd - Topic', durationMs: 200000 });
  stack.mock.addYoutubeVideo({ id: 'ytEnvolver1', title: 'Anitta - Envolver (Official Music Video)', channelTitle: 'AnittaVEVO', durationMs: 193000 });
  stack.mock.addYoutubeVideo({ id: 'ytBloqueado', title: 'Blinding Lights cover', channelTitle: 'Alguém', durationMs: 180000, embeddable: false });
  // Caso real: o melhor resultado é da gravadora e não toca fora do youtube.com.
  stack.mock.addYoutubeVideo({ id: 'ytBlackSony', title: 'Black', channelTitle: 'Pearl Jam - Topic', durationMs: 343000, embeddable: false });
  stack.mock.addYoutubeVideo({ id: 'ytBlackOfic', title: 'Pearl Jam - Black (Official Audio)', channelTitle: 'Pearl Jam', durationMs: 343000 });
  stack.mock.addYoutubeVideo({ id: 'ytBlackLyrc', title: 'Pearl Jam - Black (Lyrics)', channelTitle: 'Letras BR', durationMs: 344000 });
  client = await stack.client();
  await ok(client.emit('room:create', { name: 'Sem chave' }), 'room:create');
});

after(async () => {
  await stack?.close();
});

describe('YouTube sem chave', () => {
  it('/api/config diz que o YouTube funciona, no modo "site"', async () => {
    const cfg = await (await fetch(`${stack.base}/api/config`)).json();
    assert.strictEqual(cfg.youtube, true);
    assert.strictEqual(cfg.youtubeMode, 'site');
  });

  it('busca no YouTube funciona e ignora anúncio, canal e ao vivo', async () => {
    const res = await ok(client.emit('search', { q: 'Blinding Lights', source: 'youtube' }), 'search');
    const ids = res.results.map((r) => r.youtubeId);
    assert.ok(ids.includes('ytBlinding1'), JSON.stringify(ids));
    assert.ok(!ids.includes('anuncio0001') && !ids.includes('aovivo00001'), JSON.stringify(ids));
    const hit = res.results.find((r) => r.youtubeId === 'ytBlinding1');
    assert.strictEqual(hit.artist, 'The Weeknd');
    assert.strictEqual(hit.durationMs, 200000);
    assert.match(hit.art, /^https:\/\//);
    // nenhuma chamada à API oficial
    assert.ok(!stack.mock.state.requests.some((r) => r.path.startsWith('/youtube/v3/')));
  });

  it('colar um link do YouTube traz título, artista e duração', async () => {
    const res = await ok(client.emit('search', { q: 'https://youtu.be/ytEnvolver1', source: 'spotify' }), 'link');
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].youtubeId, 'ytEnvolver1');
    assert.strictEqual(res.results[0].durationMs, 193000);
  });

  it('link de vídeo que não pode ser incorporado não entra', async () => {
    const res = await ok(client.emit('search', { q: 'https://www.youtube.com/watch?v=ytBloqueado', source: 'youtube' }), 'link bloqueado');
    assert.strictEqual(res.results.length, 0);
  });

  it('faixa do Spotify ganha youtubeId sem chave', async () => {
    const add = await ok(
      client.emit('queue:add', {
        track: { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', durationMs: 200040, spotifyUri: 'spotify:track:blinding1' },
      }),
      'add'
    );
    const s = await client.waitFor('state', (st) => st.queue.find((t) => t.id === add.id && !t.resolving), 5000);
    assert.strictEqual(s.queue.find((t) => t.id === add.id).youtubeId, 'ytBlinding1');
  });

  it('não escolhe vídeo que não pode tocar fora do youtube.com', async () => {
    const add = await ok(
      client.emit('queue:add', {
        track: { title: 'Black', artist: 'Pearl Jam', album: 'Ten', durationMs: 343000, spotifyUri: 'spotify:track:blackpj' },
      }),
      'add Black'
    );
    const s = await client.waitFor('state', (st) => st.queue.find((t) => t.id === add.id && !t.resolving), 5000);
    const yt = s.queue.find((t) => t.id === add.id).youtubeId;
    assert.ok(yt && yt !== 'ytBlackSony', `escolheu ${yt}`);
  });

  it('player recusa o vídeo (erro 150): servidor troca por outro para todos', async () => {
    const other = await stack.client();
    const code = client.last('state').code;
    await ok(other.emit('room:join', { code, name: 'Outro' }), 'join');
    const s0 = client.last('state');
    const t = s0.queue.find((x) => x.title === 'Black');
    const refused = t.youtubeId;
    const res = await ok(client.emit('queue:youtubeFailed', { trackId: t.id, youtubeId: refused, code: 150 }), 'youtubeFailed');
    assert.ok(res.replacement && res.replacement !== refused && res.replacement !== 'ytBlackSony', JSON.stringify(res));
    const s1 = await other.waitFor('state', (st) => st.queue.find((x) => x.id === t.id)?.youtubeId === res.replacement, 4000);
    assert.ok(s1);
    // Segundo aviso do mesmo vídeo (outro membro) é ignorado: o vídeo já foi trocado.
    const again = await ok(other.emit('queue:youtubeFailed', { trackId: t.id, youtubeId: refused, code: 150 }), 'repetido');
    assert.strictEqual(again.ignored, true);
    // Erro 153 é configuração do player, não do vídeo: não troca.
    const cfg = await ok(other.emit('queue:youtubeFailed', { trackId: t.id, youtubeId: res.replacement, code: 153 }), '153');
    assert.strictEqual(cfg.ignored, true);
  });

  it('parseClock entende m:ss e h:mm:ss', () => {
    const { parseClock } = require('../server/youtube')._internals;
    assert.strictEqual(parseClock('3:14'), 194000);
    assert.strictEqual(parseClock('1:02:03'), 3723000);
    assert.strictEqual(parseClock(''), 0);
  });
});
