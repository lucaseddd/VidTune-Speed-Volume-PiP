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
  const stored = { volumeSessionReady: true, volumeScopes: { 7: 0.2, 9: 0.8 } };
  const local = {};
  const api = {
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, onMoved: { addListener() {} },
      async get(id) { return { id, index: id, url: `https://example.com/${id}` }; } },
    runtime: { onMessage: { addListener(listener) { receive = listener; } } },
    storage: { local: {
      async get() { return structuredClone(local); },
      async set(value) { Object.assign(local, structuredClone(value)); }
    }, session: {
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

function restartFixture(local, tabs, stored = {}) {
  let receive;
  let removed;
  let moved;
  const api = {
    tabs: {
      onRemoved: { addListener(listener) { removed = listener; } },
      onUpdated: { addListener() {} },
      onMoved: { addListener(listener) { moved = listener; } },
      async query() { return tabs; },
      async get(id) { return tabs.find((tab) => tab.id === id); }
    },
    runtime: { onMessage: { addListener(listener) { receive = listener; } } },
    storage: Object.fromEntries([['local', local], ['session', stored]].map(([name, data]) => [name, {
      async get() { return structuredClone(data); },
      async set(value) { Object.assign(data, structuredClone(value)); },
      async remove(key) { delete data[key]; }
    }]))
  };
  runInNewContext(background, { browser: api, URL, console, sendToFrame() {} });
  return {
    removed,
    moved,
    send: (message, sender = {}) => new Promise(resolve => {
      assert.equal(receive(message, sender, resolve), true);
    })
  };
}

test('browser restart resets global volume and restores only marked tabs with new IDs', async () => {
  const local = { settings: { volume: 2, speed: 1.5 }, savedVolumeTabs: {
    7: { url: 'https://example.com/watch', index: 0, volume: 2.5, speed: 1.75 }
  } };
  const tabs = [{ id: 21, index: 0, url: 'https://example.com/watch' },
    { id: 7, index: 1, url: 'https://other.example/' }];
  const session = {};
  const page = restartFixture(local, tabs, session);
  const restored = await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 21 });
  assert.equal(local.settings.volume, 1);
  assert.equal(local.settings.speed, 1.5);
  assert.equal(restored.active, true);
  assert.equal(restored.volume, 2.5);
  assert.equal(restored.speed, 1.75);
  assert.equal((await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 7 })).active, false);
  local.settings.volume = 0.6;
  const worker = restartFixture(local, tabs, session);
  await worker.send({ type: 'GET_VOLUME_SCOPE', tabId: 21 });
  assert.equal(local.settings.volume, 0.6, 'worker restart must not reset the browser session');
});

test('closing a window preserves marked tabs, but closing a tab explicitly clears it', async () => {
  const local = { settings: { volume: 1 } };
  const tabs = [{ id: 1, index: 0, url: 'https://example.com/' }];
  const page = restartFixture(local, tabs);
  await page.send({ type: 'SET_VOLUME_SCOPE', tabId: 1, enabled: true, volume: 2 });
  page.removed(1, { isWindowClosing: true });
  await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 99 });
  assert.equal(local.savedVolumeTabs[1].volume, 2);
  page.removed(1, { isWindowClosing: false });
  await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 99 });
  assert.equal(local.savedVolumeTabs[1], undefined);
});

test('restoration never assigns a saved boost to a newly opened tab', async () => {
  const local = { settings: { volume: 2 }, savedVolumeTabs: {
    7: { url: 'https://example.com/watch', index: 0, volume: 3 }
  } };
  const tabs = [{ id: 1, index: 0, url: 'https://example.com/' }];
  const page = restartFixture(local, tabs);
  await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 1 });
  tabs.push({ id: 2, index: 1, url: 'https://example.com/watch' });
  assert.equal((await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 2 })).active, false);
});

test('unmarked duplicates cannot consume another tab\'s saved volume', async () => {
  const url = 'https://example.com/watch';
  const local = { savedVolumeTabs: { 7: { url, index: 1, volume: 3 } } };
  const page = restartFixture(local, [{ id: 10, url, index: 0 }, { id: 11, url, index: 1 }]);
  assert.equal((await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 10 })).active, false);
  assert.equal((await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 11 })).volume, 3);
  const ambiguous = restartFixture({ savedVolumeTabs: { 7: { url, index: 0, volume: 3 } } },
    [{ id: 10, url, index: 0 }, { id: 11, url, index: 0 }]);
  assert.equal((await ambiguous.send({ type: 'GET_VOLUME_SCOPE', tabId: 10 })).active, false);
});

test('moving tabs refreshes positions for all marked tabs before the next restart', async () => {
  const local = {};
  const tabs = [{ id: 1, index: 0, url: 'https://example.com/a' },
    { id: 2, index: 1, url: 'https://example.com/b' }];
  const page = restartFixture(local, tabs);
  await page.send({ type: 'SET_VOLUME_SCOPE', tabId: 1, enabled: true, volume: 2 });
  await page.send({ type: 'SET_VOLUME_SCOPE', tabId: 2, enabled: true, volume: 3 });
  tabs[0].index = 1;
  tabs[1].index = 0;
  page.moved(1);
  await page.send({ type: 'GET_VOLUME_SCOPE', tabId: 1 });
  assert.equal(local.savedVolumeTabs[1].index, 1);
  assert.equal(local.savedVolumeTabs[2].index, 0);
});
