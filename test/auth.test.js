// OAuth do Spotify com PKCE, /api/config e /api/setup (servidor JÁ configurado via env).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { startStack, spotifyLogin, CLIENT_ID } = require('./helpers/harness');

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack?.close();
});

const sidNew = () => crypto.randomUUID();

describe('/api/config', () => {
  it('tem o formato do contrato', async () => {
    const res = await fetch(`${stack.base}/api/config`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.spotify, true);
    assert.strictEqual(body.youtube, true);
    assert.ok(body.spotifySetup && typeof body.spotifySetup === 'object', JSON.stringify(body));
    assert.strictEqual(body.spotifySetup.needed, false);
    assert.strictEqual(body.spotifySetup.canSetup, false);
    assert.strictEqual(typeof body.spotifySetup.redirectUri, 'string');
    assert.match(body.spotifySetup.redirectUri, /^https?:\/\/.+\/auth\/spotify\/callback$/);
  });
});

describe('login com PKCE', () => {
  it('/auth/spotify/login redireciona para /authorize com PKCE S256', async () => {
    const qs = new URLSearchParams({ sid: sidNew(), room: 'ABCD', intent: 'join', name: 'Zé' });
    const res = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
    assert.ok(res.status >= 300 && res.status < 400, `status ${res.status}`);
    const loc = new URL(res.headers.get('location'));
    assert.strictEqual(`${loc.origin}${loc.pathname}`, `${stack.mock.accountsBase}/authorize`);
    const p = Object.fromEntries(loc.searchParams);
    assert.strictEqual(p.response_type, 'code');
    assert.strictEqual(p.client_id, CLIENT_ID);
    assert.strictEqual(p.code_challenge_method, 'S256');
    assert.match(p.code_challenge || '', /^[A-Za-z0-9_-]{43}$/, 'code_challenge base64url de sha256 (43 chars)');
    assert.match(p.redirect_uri || '', /\/auth\/spotify\/callback$/);
    assert.ok(p.state && p.state.length >= 16, 'state presente');
    for (const s of ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing']) {
      assert.ok((p.scope || '').split(' ').includes(s), `escopo ${s}`);
    }
    assert.ok(!('client_secret' in p));
  });

  it('cada login gera state e code_challenge diferentes', async () => {
    const get = async () => {
      const qs = new URLSearchParams({ sid: sidNew(), room: '', intent: 'create', name: 'A' });
      const res = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
      return Object.fromEntries(new URL(res.headers.get('location')).searchParams);
    };
    const a = await get();
    const b = await get();
    assert.notStrictEqual(a.state, b.state);
    assert.notStrictEqual(a.code_challenge, b.code_challenge);
  });

  it('callback troca o code com code_verifier e client_id, SEM Authorization, e repassa room/intent/name', async () => {
    const before = stack.mock.state.tokenRequests.length;
    const r = await spotifyLogin(stack, { sid: sidNew(), room: 'WXYZ', intent: 'join', name: 'Zé Ninguém', user: 'auth-user' });
    assert.ok(r.callbackStatus >= 300 && r.callbackStatus < 400, `callback status ${r.callbackStatus}`);
    assert.match(r.callbackLocation, /^(https?:\/\/[^/]+)?\/\?/);
    assert.strictEqual(r.callbackParams.spotify, 'ok', r.callbackLocation);
    assert.strictEqual(r.callbackParams.room, 'WXYZ');
    assert.strictEqual(r.callbackParams.intent, 'join');
    assert.strictEqual(r.callbackParams.name, 'Zé Ninguém');

    const reqs = stack.mock.state.tokenRequests.slice(before);
    assert.strictEqual(reqs.length, 1, JSON.stringify(reqs));
    const t = reqs[0];
    assert.strictEqual(t.status, 200, 'mock aceitou (verifier confere com challenge)');
    assert.strictEqual(t.headers.authorization, undefined, 'não pode haver header Authorization');
    assert.strictEqual(t.params.grant_type, 'authorization_code');
    assert.strictEqual(t.params.client_id, CLIENT_ID);
    assert.ok(t.params.code_verifier, 'code_verifier presente');
    assert.match(t.params.code_verifier, /^[A-Za-z0-9._~-]{43,128}$/, 'verifier no formato RFC 7636');
    assert.strictEqual(t.params.redirect_uri, r.authorizeQuery.redirect_uri);
    assert.ok(!('client_secret' in t.params));
  });

  it('state inválido → spotify=expired, sem trocar token', async () => {
    const before = stack.mock.state.tokenRequests.length;
    const res = await fetch(`${stack.base}/auth/spotify/callback?code=abc&state=nao-existe`, { redirect: 'manual' });
    assert.ok(res.status >= 300 && res.status < 400);
    const p = Object.fromEntries(new URL(res.headers.get('location'), stack.base).searchParams);
    assert.strictEqual(p.spotify, 'expired');
    assert.strictEqual(stack.mock.state.tokenRequests.length, before);
  });

  it('state usado duas vezes → spotify=expired na segunda', async () => {
    const qs = new URLSearchParams({ sid: sidNew(), room: 'QQQQ', intent: 'join', name: 'A' });
    const login = await fetch(`${stack.base}/auth/spotify/login?${qs}`, { redirect: 'manual' });
    const auth = await fetch(login.headers.get('location'), { redirect: 'manual' });
    const back = new URL(auth.headers.get('location'));
    const first = await fetch(`${stack.base}/auth/spotify/callback${back.search}`, { redirect: 'manual' });
    assert.strictEqual(new URL(first.headers.get('location'), stack.base).searchParams.get('spotify'), 'ok');
    const second = await fetch(`${stack.base}/auth/spotify/callback${back.search}`, { redirect: 'manual' });
    assert.strictEqual(new URL(second.headers.get('location'), stack.base).searchParams.get('spotify'), 'expired');
  });

  it('error=access_denied → spotify=denied e repassa room', async () => {
    const before = stack.mock.state.tokenRequests.length;
    const r = await spotifyLogin(stack, { sid: sidNew(), room: 'DENY', intent: 'join', name: 'N', deny: true });
    assert.strictEqual(r.callbackParams.spotify, 'denied', r.callbackLocation);
    assert.strictEqual(r.callbackParams.room, 'DENY');
    assert.strictEqual(stack.mock.state.tokenRequests.length, before, 'não deve trocar token');
  });

  it('code_verifier errado é rejeitado pelo mock → spotify=error (sanidade do mock/servidor)', async () => {
    // Faz o login, mas troca o state por um de outro login: o verifier não confere com o challenge do code.
    const qs = () => new URLSearchParams({ sid: sidNew(), room: 'MIX', intent: 'join', name: 'N' });
    const l1 = await fetch(`${stack.base}/auth/spotify/login?${qs()}`, { redirect: 'manual' });
    const l2 = await fetch(`${stack.base}/auth/spotify/login?${qs()}`, { redirect: 'manual' });
    const a1 = await fetch(l1.headers.get('location'), { redirect: 'manual' });
    const code1 = new URL(a1.headers.get('location')).searchParams.get('code');
    const state2 = new URL(l2.headers.get('location')).searchParams.get('state');
    const cb = await fetch(`${stack.base}/auth/spotify/callback?code=${code1}&state=${state2}`, { redirect: 'manual' });
    assert.strictEqual(new URL(cb.headers.get('location'), stack.base).searchParams.get('spotify'), 'error');
  });

  it('refresh usa refresh_token + client_id, sem Authorization nem secret', async () => {
    stack.mock.state.tokenExpiresIn = 5; // < 30 s: servidor deve renovar no próximo uso
    const sid = sidNew();
    try {
      const r = await spotifyLogin(stack, { sid, room: '', intent: 'create', name: 'R', user: 'refresh-user' });
      assert.strictEqual(r.callbackParams.spotify, 'ok');
    } finally {
      stack.mock.state.tokenExpiresIn = 3600;
    }
    const before = stack.mock.state.tokenRequests.length;
    const c = await stack.client({ sid });
    await c.emit('room:create', { name: 'R' });
    const ack = await c.emit('spotify:devices');
    assert.ok(ack.ok, JSON.stringify(ack));
    assert.strictEqual(ack.devices?.[0]?.id, 'dev-refresh-user');
    const reqs = stack.mock.state.tokenRequests.slice(before).filter((t) => t.params.grant_type === 'refresh_token');
    assert.strictEqual(reqs.length >= 1, true, 'deveria ter renovado o token');
    const t = reqs[0];
    assert.strictEqual(t.status, 200);
    assert.strictEqual(t.headers.authorization, undefined);
    assert.strictEqual(t.params.client_id, CLIENT_ID);
    assert.ok(t.params.refresh_token);
    assert.ok(!('client_secret' in t.params));
    c.close();
  });
});

describe('/api/setup com servidor já configurado', () => {
  it('responde 403', async () => {
    const res = await fetch(`${stack.base}/api/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyClientId: 'ffffffffffffffffffffffffffffffff' }),
    });
    assert.strictEqual(res.status, 403);
  });
});
