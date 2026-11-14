import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contentHash } from '../src/transform.mjs';
import { createSingleWriteGate } from '../scripts/infrastructure/gcp-single-transfer.mjs';

test('one approved create is journalled before send; wrong bodies, retries and all edits deny', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hsr-one-write-'));
  const payload = { title: 'synthetic', game: 'hkrpg' }, journalPath = join(dir, 'attempt.json');
  const request = (path, body = payload) => ({ url: 'https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar' + path, method: 'POST', postData: JSON.stringify(body) });
  try {
    const gate = createSingleWriteGate({ sourceId: '6ae853e2267945d9413ab49e', payloadHash: contentHash(payload), journalPath, expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(await gate.admit(request('/game/lineup/create_lineup_tourn')), false);
    gate.arm();
    assert.equal(await gate.admit(request('/game/lineup/edit')), false);
    assert.equal(await gate.admit(request('/game/lineup/create_lineup_tourn', { ...payload, title: 'different' })), false);
    assert.equal(await gate.admit(request('/game/lineup/create_lineup_tourn')), true);
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).status, 'attempted-unconfirmed');
    assert.equal(await gate.admit(request('/game/lineup/create_lineup_tourn')), false);
    const restarted = createSingleWriteGate({ sourceId: '6ae853e2267945d9413ab49e', payloadHash: contentHash(payload), journalPath, expiresAt: new Date(Date.now() + 60000).toISOString() });
    restarted.arm(); await assert.rejects(restarted.admit(request('/game/lineup/create_lineup_tourn')), { code: 'EEXIST' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expired authority cannot send even a matching create', async () => {
  const gate = createSingleWriteGate({ sourceId: '6ae853e2267945d9413ab49e', payloadHash: contentHash({ game: 'hkrpg' }), journalPath: '/unused', expiresAt: '2020-01-01T00:00:00Z' });
  gate.arm(); assert.equal(await gate.admit({ url: 'https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar/game/lineup/create_lineup_tourn', method: 'POST', postData: '{"game":"hkrpg"}' }), false);
});

test('expiry during persistence consumes the journal but refuses upstream admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hsr-one-expiry-'));
  const body = { game: 'hkrpg' }; let calls = 0;
  try {
    const gate = createSingleWriteGate({ sourceId: '6ae853e2267945d9413ab49e', payloadHash: contentHash(body), journalPath: join(dir, 'attempt.json'),
      expiresAt: '2026-01-01T00:00:01Z', now: () => Date.parse(++calls === 1 ? '2026-01-01T00:00:00Z' : '2026-01-01T00:00:02Z') });
    gate.arm();
    assert.equal(await gate.admit({ url: 'https://sg-act-public-api.hoyolab.com/event/rpgcurrencywar/game/lineup/create_lineup_tourn', method: 'POST', postData: JSON.stringify(body) }), false);
    assert.equal(JSON.parse(await readFile(join(dir, 'attempt.json'), 'utf8')).status, 'attempted-unconfirmed');
    gate.abort(); assert.equal(gate.current(), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
