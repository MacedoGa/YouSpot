// Sobe mock das APIs + servidor sob teste no mesmo processo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createMock } = require('./mock-apis');
const sio = require('./sio-client');

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

async function startStack({ clientId = CLIENT_ID, youtubeKey = 'fake', extraEnv = {} } = {}) {
  const mock = await createMock().listen();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-sync-test-'));

  delete process.env.PORT;
  delete process.env.BASE_URL;
  Object.assign(process.env, {
    SPOTIFY_ACCOUNTS_BASE: mock.accountsBase,
    SPOTIFY_API_BASE: mock.spotifyApiBase,
    YOUTUBE_API_BASE: mock.youtubeApiBase,
    YOUTUBE_INNERTUBE_BASE: mock.youtubeInnertubeBase,
    YOUTUBE_OEMBED_BASE: mock.youtubeOembedBase,
    // string vazia (e não delete) para o dotenv não preencher a partir de um .env local
    SPOTIFY_CLIENT_ID: clientId || '',
    SPOTIFY_CLIENT_SECRET: '',
    YOUTUBE_API_KEY: youtubeKey || '',
    DATA_DIR: dataDir,
    ...extraEnv,
  });
  mock.state.youtubeKey = youtubeKey;

  let srv;
  try {
    const serverModule = require('../../server');
    if (typeof serverModule.start !== 'function') {
      throw new Error('server/index.js não exporta start({ port }) (contrato)');
    }
    srv = await serverModule.start({ port: 0 });
  } catch (err) {
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  const port = srv.port || srv.server?.address()?.port;
  const base = `http://127.0.0.1:${port}`;

  const clients = [];
  async function client(opts = {}) {
    const sid = opts.sid || crypto.randomUUID();
    const c = await sio.connect(base, { sid });
    c.sid = sid;
    clients.push(c);
    return c;
  }

  async function close() {
    for (const c of clients) c.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      await srv.close?.();
    } catch {}
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { mock, srv, port, base, dataDir, client, close, clientId };
}

// Fluxo completo de login no Spotify (PKCE) via mock.
// Retorna { loginLocation, authorizeQuery, callbackLocation, callbackParams, user }.
async function spotifyLogin(stack, { sid, room = '', intent = 'join', name = 'Teste', user, deny = false } = {}) {
  const qs = new URLSearchParams({ sid, room, intent, name });
  const login = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
  if (login.status < 300 || login.status >= 400) {
    throw new Error(`/auth/spotify/login respondeu ${login.status}: ${await login.text()}`);
  }
  const loginLocation = login.headers.get('location');
  const authUrl = new URL(loginLocation, stack.base);
  const authorizeQuery = Object.fromEntries(authUrl.searchParams);
  if (user) authUrl.searchParams.set('mock_user', user);
  if (deny) authUrl.searchParams.set('mock_deny', '1');
  const auth = await fetch(authUrl, { redirect: 'manual' });
  const back = new URL(auth.headers.get('location'));
  // Chama o callback do servidor sob teste (independente do host do redirect_uri)
  const cb = await fetch(`${stack.base}/auth/spotify/callback${back.search}`, { redirect: 'manual' });
  const callbackLocation = cb.headers.get('location') || '';
  const callbackParams = Object.fromEntries(new URL(callbackLocation, stack.base).searchParams);
  return { loginLocation, authorizeQuery, callbackStatus: cb.status, callbackLocation, callbackParams, user };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startStack, spotifyLogin, sleep, CLIENT_ID };
