import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const background = (await readFile(new URL('../src/background.js', import.meta.url), 'utf8'))
  .replace("import { sendToFrame } from './browser.js';", '');

test('a new page reads the most recent tab-only volume while its save is still pending', async () => {
  let receive;
  let finishWrite;
  const gate = new Promise(resolve => { finishWrite = resolve; });
  const stored = { volumeScopes: { 7: 0.2, 9: 0.8 } };
  const api = {
    tabs: { onRemoved: { addListener() {} } },
    runtime: { onMessage: { addListener(listener) { receive = listener; } } },
    storage: { session: {
      async get() { return structuredClone(stored); },
      async set(value) { await gate; Object.assign(stored, structuredClone(value)); },
      async remove(key) { delete stored[key]; }
    } }
  };
  runInNewContext(background, { browser: api, URL, console, sendToFrame() {} });
  const send = (message, sender = {}) => new Promise(resolve => {
    assert.equal(receive(message, sender, resolve), true);
  });
  const saving = send({ type: 'SAVE_SCOPED_VOLUME', volume: 0.61 }, { tab: { id: 7 } });
  const loading = send({ type: 'GET_VOLUME_SCOPE', tabId: 7 });
  await Promise.resolve();
  await Promise.resolve();
  finishWrite();
  await saving;
  const scope = await loading;
  assert.equal(scope.active, true);
  assert.equal(scope.volume, 0.61);
  assert.equal(stored.volumeScopes[9].volume, 0.8);
  await send({ type: 'SAVE_SCOPED_SPEED', speed: 1.75 }, { tab: { id: 7 } });
  const updated = await send({ type: 'GET_VOLUME_SCOPE', tabId: 7 });
  assert.equal(updated.speed, 1.75);
  assert.equal(updated.volume, 0.61);
  assert.equal((await send({ type: 'GET_VOLUME_SCOPE', tabId: 9 })).speed, undefined);
  await send({ type: 'SET_VOLUME_SCOPE', tabId: 7, enabled: false });
  assert.equal((await send({ type: 'GET_VOLUME_SCOPE', tabId: 7 })).active, false);
});
