const test = require('node:test');
const assert = require('node:assert');
const { Room } = require('../server/rooms');

function makeRoom() {
  const room = new Room('host', () => {});
  room.join('host', 'Host', 'sock1');
  return room;
}
const track = (n, durationMs = 180000) => ({ title: `T${n}`, artist: 'A', durationMs, youtubeId: `vid${n}xxxxxx`.slice(0, 11) });

test('primeira faixa adicionada começa a tocar', () => {
  const room = makeRoom();
  room.addTrack(track(1), 'Host');
  assert.strictEqual(room.index, 0);
  assert.strictEqual(room.playing, true);
  room.destroy();
});

test('pause congela a posição e play retoma do mesmo ponto', async () => {
  const room = makeRoom();
  room.addTrack(track(1), 'Host');
  await new Promise((r) => setTimeout(r, 120));
  room.pause();
  const frozen = room.currentPosition();
  assert.ok(frozen >= 100, `posição ${frozen}`);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(room.currentPosition(), frozen);
  room.play();
  assert.ok(room.currentPosition() - frozen < 20);
  room.destroy();
});

test('next/prev e fim da fila', () => {
  const room = makeRoom();
  room.addTrack(track(1), 'Host');
  room.addTrack(track(2), 'Host');
  room.next();
  assert.strictEqual(room.index, 1);
  room.prev(); // < 5s -> volta para a anterior
  assert.strictEqual(room.index, 0);
  room.next();
  room.next(); // passou do fim
  assert.strictEqual(room.playing, false);
  assert.strictEqual(room.index, 1);
  room.destroy();
});

test('troca de faixa automaticamente quando a música termina', async () => {
  const room = makeRoom();
  room.addTrack(track(1, 50), 'Host');
  room.addTrack(track(2), 'Host');
  await new Promise((r) => setTimeout(r, 450));
  assert.strictEqual(room.index, 1);
  room.destroy();
});

test('remover faixa anterior mantém a atual tocando', () => {
  const room = makeRoom();
  const a = room.addTrack(track(1), 'Host');
  room.addTrack(track(2), 'Host');
  room.next();
  room.removeTrack(a.id);
  assert.strictEqual(room.index, 0);
  assert.strictEqual(room.current.title, 'T2');
  room.destroy();
});

test('moveTrack não mexe na faixa atual', () => {
  const room = makeRoom();
  const a = room.addTrack(track(1), 'Host');
  const b = room.addTrack(track(2), 'Host');
  const c = room.addTrack(track(3), 'Host');
  room.moveTrack(b.id, -1); // tentaria trocar com a atual
  assert.deepStrictEqual(room.queue.map((t) => t.id), [a.id, b.id, c.id]);
  room.moveTrack(c.id, -1);
  assert.deepStrictEqual(room.queue.map((t) => t.id), [a.id, c.id, b.id]);
  room.destroy();
});
