const test = require('node:test');
const assert = require('node:assert');
const m = require('../server/matching');

test('parseYoutubeVideo usa o canal "- Topic" como artista', () => {
  const r = m.parseYoutubeVideo({ title: 'Evidências', channelTitle: 'Chitãozinho & Xororó - Topic' });
  assert.deepStrictEqual(r, { artist: 'Chitãozinho & Xororó', title: 'Evidências' });
});

test('parseYoutubeVideo separa "Artista - Título" e limpa ruído', () => {
  const r = m.parseYoutubeVideo({ title: 'Anitta - Envolver (Official Music Video)', channelTitle: 'AnittaVEVO' });
  assert.deepStrictEqual(r, { artist: 'Anitta', title: 'Envolver' });
});

test('parseIsoDuration', () => {
  assert.strictEqual(m.parseIsoDuration('PT4M13S'), 253000);
  assert.strictEqual(m.parseIsoDuration('PT1H2M'), 3720000);
  assert.strictEqual(m.parseIsoDuration('garbage'), 0);
});

test('parseYoutubeUrl aceita vários formatos', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [id, `https://www.youtube.com/watch?v=${id}&t=10`, `https://youtu.be/${id}`, `https://music.youtube.com/watch?v=${id}&list=X`, `https://youtube.com/shorts/${id}`]) {
    assert.strictEqual(m.parseYoutubeUrl(s), id, s);
  }
  assert.strictEqual(m.parseYoutubeUrl('não é link'), null);
});

test('pickBest prefere a versão de estúdio com duração parecida', () => {
  const ref = { title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200040 };
  const candidates = [
    { videoId: 'live', title: 'The Weeknd - Blinding Lights (Live at the Grammys)', channelTitle: 'TheWeekndVEVO', durationMs: 260000 },
    { videoId: 'cover', title: 'Blinding Lights - cover acústico', channelTitle: 'Fulano', durationMs: 199000 },
    { videoId: 'topic', title: 'Blinding Lights', channelTitle: 'The Weeknd - Topic', durationMs: 201000 },
  ];
  assert.strictEqual(m.pickBest(ref, candidates, m.scoreYoutubeCandidate).videoId, 'topic');
});

test('pickBest retorna null quando nada é parecido', () => {
  const ref = { title: 'Música Inexistente', artist: 'Ninguém', durationMs: 180000 };
  const candidates = [{ videoId: 'x', title: 'Outra coisa totalmente diferente', channelTitle: 'Canal', durationMs: 600000 }];
  assert.strictEqual(m.pickBest(ref, candidates, m.scoreYoutubeCandidate), null);
});

test('scoreSpotifyCandidate penaliza remix quando o original não é remix', () => {
  const ref = { title: 'Levitating', artist: 'Dua Lipa', durationMs: 203000 };
  const best = m.pickBest(
    ref,
    [
      { uri: 'remix', title: 'Levitating - Remix', artist: 'Dua Lipa, DaBaby', durationMs: 203000 },
      { uri: 'orig', title: 'Levitating', artist: 'Dua Lipa', durationMs: 203064 },
    ],
    m.scoreSpotifyCandidate
  );
  assert.strictEqual(best.uri, 'orig');
});
