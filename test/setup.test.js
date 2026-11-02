// /api/setup e /api/config com o servidor SEM Client ID (processo próprio: node --test roda cada arquivo isolado).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startStack } = require('./helpers/harness');

const NEW_ID = 'abcdef0123456789abcdef0123456789';
let stack;

before(async () => {
  stack = await startStack({ clientId: '' });
});
after(async () => {
  await stack?.close();
});

const post = (base, body) =>
  fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function externalIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

describe('servidor sem Client ID', () => {
  it('/api/config indica setup necessário e permitido em loopback', async () => {
    const body = await (await fetch(`${stack.base}/api/config`)).json();
    assert.strictEqual(body.spotify, false);
    assert.strictEqual(body.spotifySetup?.needed, true);
    assert.strictEqual(body.spotifySetup?.canSetup, true);
    assert.match(body.spotifySetup?.redirectUri || '', /\/auth\/spotify\/callback$/);
  });

  it('de fora do loopback: canSetup=false e POST 403', async (t) => {
    const ip = externalIPv4();
    const addr = stack.srv.server?.address?.();
    if (!ip || !addr || addr.address === '127.0.0.1') return t.skip('sem interface externa / servidor só em loopback');
    const base = `http://${ip}:${stack.port}`;
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.strictEqual(cfg.spotifySetup?.canSetup, false);
    const res = await post(base, { spotifyClientId: NEW_ID });
    assert.strictEqual(res.status, 403);
  });

  it('formato inválido → 400', async () => {
    for (const bad of [{}, { spotifyClientId: '' }, { spotifyClientId: 'xyz' }, { spotifyClientId: NEW_ID + '0' }, { spotifyClientId: 'g'.repeat(32) }]) {
      const res = await post(stack.base, bad);
      assert.strictEqual(res.status, 400, `body ${JSON.stringify(bad)} → ${res.status}`);
    }
    assert.ok(!fs.existsSync(path.join(stack.dataDir, 'config.json')) || !JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'config.json'), 'utf8')).spotifyClientId);
  });

  it('login antes do setup não redireciona para o Spotify', async () => {
    const qs = new URLSearchParams({ sid: crypto.randomUUID(), room: '', intent: 'create', name: 'A' });
    const res = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    assert.ok(!loc.startsWith(stack.mock.accountsBase), `não deveria ir ao /authorize sem Client ID (${res.status} ${loc})`);
  });

  it('200 em loopback, salva config.json e passa a valer sem reiniciar', async () => {
    const res = await post(stack.base, { spotifyClientId: NEW_ID });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    const saved = JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.spotifyClientId, NEW_ID);

    const cfg = await (await fetch(`${stack.base}/api/config`)).json();
    assert.strictEqual(cfg.spotify, true);
    assert.strictEqual(cfg.spotifySetup.needed, false);
    assert.strictEqual(cfg.spotifySetup.canSetup, false);

    const qs = new URLSearchParams({ sid: crypto.randomUUID(), room: '', intent: 'create', name: 'A' });
    const login = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
    const p = new URL(login.headers.get('location')).searchParams;
    assert.strictEqual(p.get('client_id'), NEW_ID);
    assert.strictEqual(p.get('code_challenge_method'), 'S256');
  });

  it('já configurado → 403', async () => {
    const res = await post(stack.base, { spotifyClientId: 'ffffffffffffffffffffffffffffffff' });
    assert.strictEqual(res.status, 403);
    const saved = JSON.parse(fs.readFileSync(path.join(stack.dataDir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.spotifyClientId, NEW_ID);
  });
});
