import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, MODULES, normalizeSettings, updateSettings } from '../src/settings.js';
import { summarizeVideos } from '../src/detection.js';
import { adjustSpeed, formatSpeed, normalizeSpeed } from '../src/speed.js';
import { formatVolume, normalizeVolume, positionToVolume, volumeToPosition } from '../src/volume.js';

test('settings default and reject invalid stored values', () => {
  assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS, presets: [...DEFAULT_SETTINGS.presets], shortcuts: { ...DEFAULT_SETTINGS.shortcuts } });
  assert.equal(normalizeSettings({ autoDetect: false, speed: 1.5 }).speed, 1.5);
  const invalid = normalizeSettings({ autoDetect: 'false', speed: 'bad', speedStep: 0, seekSeconds: 500 });
  assert.equal(invalid.autoDetect, true);
  assert.equal(invalid.speed, 1);
  assert.equal(invalid.speedStep, 0.1);
  assert.equal(invalid.seekSeconds, 10);
  assert.equal(invalid.volume, 1);
  const custom = normalizeSettings({ shortcuts: { decrease: 'KeyZ', increase: 'KeyX', reset: 'KeyQ', seekBackward: 'KeyB', seekForward: 'KeyF' }, presets: [0.5, 1, 1.25], siteSpeeds: { 'example.com': 1.75 } });
  assert.equal(custom.shortcuts.decrease, 'KeyZ');
  assert.deepEqual(custom.presets, [0.5, 1, 1.25]);
  assert.deepEqual(custom.siteSpeeds, { 'example.com': 1.75 });
});

test('volume slider gives fine control near zero and remains reversible', () => {
  assert.equal(positionToVolume(0), 0);
  assert.equal(positionToVolume(1), 0.0001);
  assert.equal(positionToVolume(10), 0.01);
  assert.equal(positionToVolume(50), 0.25);
  assert.equal(positionToVolume(100), 1);
  assert.equal(positionToVolume(150), 2);
  assert.equal(positionToVolume(200), 3);
  assert.equal(volumeToPosition(0.01), 10);
  assert.equal(volumeToPosition(2), 150);
  assert.equal(formatVolume(0.0001), '0.01%');
  assert.equal(formatVolume(0.075), '7.5%');
  assert.equal(normalizeVolume(4), 3);
  assert.equal(normalizeVolume(-1), 0);
});

test('module layouts keep unique functions and reject damaged preferences', () => {
  assert.equal(DEFAULT_SETTINGS.moduleCount, 5);
  assert.equal(DEFAULT_SETTINGS.smartOrganize, true);
  const valid = normalizeSettings({ moduleCount: 5, mono: true,
    moduleLayouts: { 2: ['mono', 'volume'], 5: ['speed', 'mono', 'pip', 'volume', 'tabVolume'], 10: MODULES },
    smartOrganize: true });
  assert.equal(valid.moduleCount, 5);
  assert.deepEqual(valid.moduleLayouts[2], ['mono', 'volume']);
  assert.equal(valid.mono, true);
  assert.equal(valid.smartOrganize, true);
  const damaged = normalizeSettings({ moduleCount: 3, moduleLayouts: { 2: ['speed', 'speed'], 10: ['speed'] } });
  assert.equal(damaged.moduleCount, 5);
  assert.deepEqual(damaged.moduleLayouts[2], DEFAULT_SETTINGS.moduleLayouts[2]);
  assert.equal(damaged.moduleLayouts[10], undefined);
  assert.equal(normalizeSettings({ moduleCount: 10 }).moduleCount, 5);
});

test('changing auto detection preserves the saved playback speed', async () => {
  let settings = { autoDetect: true, speed: 2 };
  globalThis.browser = { storage: { local: {
    async get() { return { settings }; },
    async set(data) { settings = data.settings; }
  } } };
  try {
    const updated = await updateSettings({ autoDetect: false });
    assert.equal(updated.autoDetect, false);
    assert.equal(updated.speed, 2);
    assert.equal(updated.seekEnabled, false);
  }
  finally { delete globalThis.browser; }
});

test('video summary handles zero, one and multiple videos', () => {
  assert.equal(summarizeVideos([]), 'No videos found');
  assert.equal(summarizeVideos([{}]), '1 video found');
  assert.equal(summarizeVideos([{}, {}]), '2 videos found');
  assert.equal(summarizeVideos(3), '3 videos found');
});

test('speed values clamp, step and format at boundaries', () => {
  assert.equal(normalizeSpeed(null), 1);
  assert.equal(normalizeSpeed(0.01), 0.1);
  assert.equal(normalizeSpeed(100), 16);
  assert.equal(adjustSpeed(1.5, 1), 1.6);
  assert.equal(adjustSpeed(0.1, -1), 0.1);
  assert.equal(formatSpeed(1.5), '1.5×');
});
