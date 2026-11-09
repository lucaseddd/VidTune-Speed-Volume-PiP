import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');

function fakeVideo({ playing = false, width = 640, height = 360 } = {}) {
  return {
    nodeType: 1, localName: 'video', isConnected: true,
    paused: !playing, ended: false, playbackRate: 1, volume: 1, muted: false, currentTime: 50, duration: 120,
    seekable: { length: 1, start: () => 0, end: () => 120 },
    getBoundingClientRect: () => ({ width, height })
  };
}

function fixture(initialSpeed, initialVideos, extraSettings = {}, globals = {}, scope = { active: false }) {
  const page = { videos: initialVideos, listeners: new Map(), observer: null, settings: { speed: initialSpeed, autoDetect: true, ...extraSettings } };
  let onMessage;
  class Observer {
    constructor(callback) { this.callback = callback; page.observer = this; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const document = {
    documentElement: {},
    querySelectorAll: () => page.videos,
    addEventListener(name, listener) { page.listeners.set(name, listener); },
    removeEventListener(name) { page.listeners.delete(name); }
  };
  const browser = {
    storage: { local: {
      async get() { return { settings: page.settings }; },
      async set({ settings }) { page.settings = settings; }
    } },
    runtime: { sendMessage: async () => scope, onMessage: { addListener(listener) { onMessage = listener; } } }
  };
  const context = { browser, document, MutationObserver: Observer, queueMicrotask, location: { hostname: 'example.com' }, ...globals };
  runInNewContext(source, context);
  page.send = (message) => new Promise((resolve) => { assert.equal(onMessage(message, {}, resolve), true); });
  return page;
}

test('tab-only volume survives player initialization and video replacement, including 100%', async () => {
  for (const volume of [0.61, 1]) {
    const video = fakeVideo();
    video.volume = 0.3;
    const scope = { active: true, volume };
    const page = fixture(1, [video], { volume: 0.2 }, {}, scope);
    await page.send({ type: 'GET_STATE' });
    assert.equal(video.volume, volume);
    assert.equal(page.observer.active, true);
    for (const type of ['loadeddata', 'canplay', 'playing']) {
      video.volume = 0.3;
      page.listeners.get(type)({ type, target: video });
      await page.send({ type: 'GET_STATE' });
      assert.equal(video.volume, volume, `${type} must restore the tab's level`);
    }
    const next = fakeVideo();
    video.isConnected = false;
    next.volume = 0.3;
    page.videos = [next];
    page.observer.callback([{ addedNodes: [next], removedNodes: [video] }]);
    await page.send({ type: 'GET_STATE' });
    assert.equal(next.volume, volume);
    assert.equal(page.settings.volume, 0.2);
    assert.equal(scope.volume, volume);
  }
});

function audioFixture(video, settings = {}) {
  const nodes = [];
  let sourceCount = 0;
  class AudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    async resume() {}
    createGain() {
      const node = {
        connect() {}, disconnect() {},
        gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; } }
      };
      nodes.push(node);
      return node;
    }
    createDynamicsCompressor() {
      return { connect() {}, threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} };
    }
    createMediaElementSource() { sourceCount++; return { connect() {} }; }
  }
  video.srcObject = {};
  const page = fixture(1, [video], settings, { AudioContext, setTimeout, clearTimeout });
  return { page, gain: () => nodes[0].gain.value, sourceCount: () => sourceCount };
}

test('tab-only speed restores on navigation and never changes global or site speeds', async () => {
  const scope = { active: true, volume: 0.61, speed: 1.75 };
  for (let navigation = 0; navigation < 2; navigation++) {
    const video = fakeVideo();
    const page = fixture(1.25, [video], { siteSpeeds: { 'example.com': 1.5 } }, {}, scope);
    await page.send({ type: 'GET_STATE' });
    assert.equal(video.playbackRate, 1.75);
    assert.equal(video.volume, 0.61);
    await page.send({ type: 'SET_SPEED', speed: 2 });
    assert.equal(video.playbackRate, 2);
    assert.equal(page.settings.speed, 1.25);
    assert.equal(page.settings.siteSpeeds['example.com'], 1.5);
  }
});

test('player volume and mute keep the boost without delayed jumps on media events', async () => {
  const video = fakeVideo({ playing: true });
  const { page, gain, sourceCount } = audioFixture(video);
  await page.send({ type: 'SET_VOLUME', volume: 2 });
  assert.equal(gain(), 8);

  for (const level of [0.25, 0, 0.6, 1]) {
    video.volume = level;
    for (const type of ['play', 'loadedmetadata', 'loadstart']) {
      page.listeners.get(type)({ type, target: video });
      await page.send({ type: 'GET_STATE' });
      assert.equal(video.volume, level, `${type} must preserve the player volume`);
      assert.equal(gain(), 8);
    }
    await page.send({ type: 'SET_SPEED', speed: 1.5 });
    assert.equal(video.volume, level);
  }
  video.volume = 0.4;
  video.muted = true;
  page.listeners.get('play')({ type: 'play', target: video });
  assert.equal((await page.send({ type: 'GET_STATE' })).volume, 0);
  assert.equal(video.volume, 0.4);
  assert.equal(video.muted, true);
  video.muted = false;
  assert.equal((await page.send({ type: 'GET_STATE' })).volume, 2);
  assert.equal(gain(), 8);
  assert.equal(sourceCount(), 1);
});

test('boost initializes native volume once and can be reset and enabled again', async () => {
  const video = fakeVideo({ playing: true });
  video.volume = 0.2;
  const { page, gain, sourceCount } = audioFixture(video, { volume: 2 });
  await page.send({ type: 'GET_STATE' });
  assert.equal(video.volume, 1);
  assert.equal(gain(), 8);
  video.volume = 0.3;
  await page.send({ type: 'PREVIEW_VOLUME', volume: 3 });
  assert.equal(video.volume, 0.3);
  assert.equal(gain(), 32);
  await page.send({ type: 'SET_VOLUME', volume: 0.5 });
  assert.equal(video.volume, 0.5);
  assert.equal(gain(), 1);
  await page.send({ type: 'SET_VOLUME', volume: 2 });
  assert.equal(video.volume, 1);
  assert.equal(gain(), 8);
  assert.equal(sourceCount(), 1);
});

test('saved speed targets the playing video and follows a dynamic replacement', async () => {
  const largePaused = fakeVideo({ width: 1200, height: 700 });
  const smallPlaying = fakeVideo({ playing: true, width: 480, height: 270 });
  const page = fixture(1.5, [largePaused, smallPlaying]);
  const first = await page.send({ type: 'GET_STATE' });
  assert.equal(first.count, 2);
  assert.equal(smallPlaying.playbackRate, 1.5);
  assert.equal(largePaused.playbackRate, 1);
  assert.equal(page.observer.active, true);

  const replacement = fakeVideo({ playing: true });
  smallPlaying.isConnected = false;
  page.videos = [replacement];
  page.observer.callback([{ addedNodes: [replacement], removedNodes: [smallPlaying] }]);
  await new Promise(queueMicrotask);
  assert.equal(replacement.playbackRate, 1.5);
});

test('hidden playing media does not steal controls from the visible player', async () => {
  const hidden = fakeVideo({ playing: true, width: 0, height: 0 });
  const visible = fakeVideo();
  const page = fixture(1, [hidden, visible]);
  await page.send({ type: 'SET_SPEED', speed: 1.5 });
  assert.equal(visible.playbackRate, 1.5);
  assert.equal(hidden.playbackRate, 1);
});

test('player speed resets are corrected with a bounded retry budget', async () => {
  const video = fakeVideo({ playing: true });
  const page = fixture(1.5, [video]);
  await page.send({ type: 'GET_STATE' });
  for (let i = 0; i < 6; i++) {
    video.playbackRate = 1;
    page.listeners.get('ratechange')({ type: 'ratechange', target: video });
    assert.equal(video.playbackRate, i < 5 ? 1.5 : 1);
  }
  await page.send({ type: 'SET_SPEED', speed: 2 });
  video.playbackRate = 1;
  page.listeners.get('ratechange')({ type: 'ratechange', target: video });
  assert.equal(video.playbackRate, 2);
});

test('shortcut-style messages persist speed and reset idle monitoring', async () => {
  const video = fakeVideo({ playing: true });
  const page = fixture(1, [video]);
  assert.equal(page.observer, null);
  assert.equal(page.listeners.size, 0);
  assert.equal((await page.send({ type: 'INCREASE' })).speed, 1.1);
  assert.equal(page.settings.speed, 1.1);
  assert.equal(page.observer.active, true);
  assert.equal((await page.send({ type: 'RESET' })).speed, 1);
  assert.equal(page.settings.speed, 1);
  assert.equal(page.observer.active, false);
  assert.equal(page.listeners.size, 0);
});

test('repeated speed messages apply each 0.1× step in order', async () => {
  const video = fakeVideo({ playing: true });
  const page = fixture(1, [video]);
  const changes = await Promise.all([
    page.send({ type: 'INCREASE' }),
    page.send({ type: 'INCREASE' }),
    page.send({ type: 'INCREASE' })
  ]);
  assert.deepEqual(changes.map(({ speed }) => speed), [1.1, 1.2, 1.3]);
  assert.equal(video.playbackRate, 1.3);
  assert.equal(page.settings.speed, 1.3);
});

test('custom speed step, site profile and seek range are applied', async () => {
  const video = fakeVideo({ playing: true });
  const page = fixture(1, [video], { speedStep: 0.2, seekSeconds: 15, siteSpeeds: { 'example.com': 1.5 } });
  assert.equal((await page.send({ type: 'GET_STATE' })).speed, 1.5);
  assert.equal((await page.send({ type: 'INCREASE' })).speed, 1.7);
  assert.equal(page.settings.siteSpeeds['example.com'], 1.7);
  assert.equal(page.settings.speed, 1);
  await page.send({ type: 'SEEK_FORWARD' });
  assert.equal(video.currentTime, 65);
  await page.send({ type: 'SEEK_BACKWARD' });
  assert.equal(video.currentTime, 50);
  video.currentTime = 118;
  await page.send({ type: 'SEEK_FORWARD' });
  assert.equal(video.currentTime, 120);
});

test('a 1× site profile keeps dynamically added videos at 1×', async () => {
  const first = fakeVideo();
  const page = fixture(1.5, [first], { siteSpeeds: { 'example.com': 1 } });
  await page.send({ type: 'GET_STATE' });
  assert.equal(page.observer.active, true);
  const replacement = fakeVideo();
  replacement.playbackRate = 2;
  first.isConnected = false;
  page.videos = [replacement];
  page.observer.callback([{ addedNodes: [replacement], removedNodes: [first] }]);
  await new Promise(queueMicrotask);
  assert.equal(replacement.playbackRate, 1);
});

test('low saved volume follows video replacement and can be reset to 100%', async () => {
  const first = fakeVideo();
  const page = fixture(1, [first], { volume: 0.0004 });
  assert.equal((await page.send({ type: 'GET_STATE' })).volume, 0.0004);
  assert.equal(first.volume, 0.0004);
  assert.equal(page.observer.active, true);
  const replacement = fakeVideo();
  first.isConnected = false;
  page.videos = [replacement];
  page.observer.callback([{ addedNodes: [replacement], removedNodes: [first] }]);
  await new Promise(queueMicrotask);
  assert.equal(replacement.volume, 0.0004);
  await page.send({ type: 'SET_VOLUME', volume: 1 });
  assert.equal(replacement.volume, 1);
  assert.equal(page.settings.volume, 1);
  assert.equal(page.observer.active, false);
});

test('volume preview applies without saving and explicit adjustment unmutes', async () => {
  const video = fakeVideo();
  video.muted = true;
  const page = fixture(1, [video]);
  assert.equal((await page.send({ type: 'GET_STATE' })).volume, 0);
  await page.send({ type: 'PREVIEW_VOLUME', volume: 0.01 });
  assert.equal(video.volume, 0.01);
  assert.equal(video.muted, false);
  assert.equal(page.settings.volume, undefined);
  await page.send({ type: 'SET_VOLUME', volume: 0 });
  assert.equal(page.settings.volume, 0);
});

test('unavailable boost keeps native audio at 100% and reports the limitation', async () => {
  const video = fakeVideo({ playing: true });
  const page = fixture(1, [video]);
  const result = await page.send({ type: 'SET_VOLUME', volume: 3 });
  assert.equal(result.volume, 1);
  assert.equal(result.boostUnavailable, true);
  assert.equal(video.volume, 1);
  assert.equal(page.settings.volume, 3);
});

test('boost waits for a paused video without delaying the popup response', async () => {
  const video = fakeVideo();
  const page = fixture(1, [video]);
  const result = await page.send({ type: 'SET_VOLUME', volume: 3 });
  assert.equal(result.volume, 3);
  assert.equal(result.boostPending, true);
  assert.equal(video.volume, 1);
});
