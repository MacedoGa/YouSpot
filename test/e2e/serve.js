// Sobe mocks + servidor numa porta livre e imprime uma linha JSON { base, mock } no stdout.
// Usado por test/e2e/ui_smoke.py. Encerra com SIGTERM/SIGINT.
// Só sobe com o argumento --serve (o `node --test` padrão também carrega arquivos em test/**).
if (process.argv[2] !== '--serve') return;

const { startStack } = require('../helpers/harness');

(async () => {
  const stack = await startStack();
  stack.mock.addYoutubeVideo({ id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)', channelTitle: 'Rick Astley', durationMs: 213000 });
  stack.mock.addSpotifyTrack({ id: 'nevergonna1', name: 'Never Gonna Give You Up', artists: ['Rick Astley'], durationMs: 213573 });
  process.stdout.write(JSON.stringify({ base: stack.base, mock: stack.mock.url }) + '\n');
  const stop = async () => {
    await stack.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
