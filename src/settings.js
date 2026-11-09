import { browserApi } from './browser.js';
import { normalizeSpeed, SPEED_PRESETS } from './speed.js';
import { normalizeVolume } from './volume.js';

export const DEFAULT_SHORTCUTS = Object.freeze({
  decrease: 'KeyA', increase: 'KeyD', reset: 'KeyQ', seekBackward: null, seekForward: null, pip: null
});
export const MODULES = Object.freeze([
  'speed', 'volume', 'mono', 'pip', 'presets', 'customSpeed',
  'resetSpeed', 'seekBackward', 'seekForward', 'tabVolume'
]);
export const DEFAULT_MODULE_LAYOUTS = Object.freeze({
  2: ['speed', 'volume'],
  5: ['speed', 'volume', 'mono', 'pip', 'tabVolume'],
});
export const DEFAULT_SETTINGS = Object.freeze({
  autoDetect: true, speed: 1, volume: 1, speedStep: 0.1, presets: SPEED_PRESETS,
  shortcuts: DEFAULT_SHORTCUTS, seekEnabled: false, seekSeconds: 10,
  siteSpeeds: {}, siteVolumes: {}, disabledSites: [], mono: false,
  moduleCount: 5, moduleLayouts: DEFAULT_MODULE_LAYOUTS, smartOrganize: true
});

function moduleLayouts(value) {
  return Object.fromEntries([2, 5].map((count) => {
    const selected = value?.[count];
    return [count, Array.isArray(selected) && selected.length === count &&
      selected.every((name) => MODULES.includes(name)) && new Set(selected).size === count
      ? [...selected] : [...DEFAULT_MODULE_LAYOUTS[count]]];
  }));
}

function shortcut(value, fallback) {
  return value === null || /^Key[A-Z]$/.test(value ?? '') ? value : fallback;
}

function presets(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 8) return [...SPEED_PRESETS];
  const numbers = value.map(Number);
  if (numbers.some((number) => !Number.isFinite(number) || number < 0.1 || number > 16)) return [...SPEED_PRESETS];
  const unique = [...new Set(numbers.map(normalizeSpeed))];
  return unique.length >= 3 ? unique : [...SPEED_PRESETS];
}

function siteSpeeds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([host, speed]) =>
    /^[a-z0-9.-]{1,253}$/i.test(host) && Number.isFinite(Number(speed)) && Number(speed) >= 0.1 && Number(speed) <= 16
  ).slice(0, 100).map(([host, speed]) => [host.toLowerCase(), normalizeSpeed(speed)]));
}

function siteVolumes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([host, volume]) =>
    /^[a-z0-9.-]{1,253}$/i.test(host) && volume !== '' &&
    Number.isFinite(Number(volume)) && Number(volume) >= 0 && Number(volume) <= 3
  ).slice(0, 100).map(([host, volume]) => [host.toLowerCase(), normalizeVolume(volume)]));
}

function disabledSites(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((host) => typeof host === 'string' &&
    /^[a-z0-9.-]{1,253}$/i.test(host)).map((host) => host.toLowerCase()))].slice(0, 100);
}

export function normalizeSettings(value) {
  const step = Number(value?.speedStep);
  const seek = Number(value?.seekSeconds);
  const keys = Object.fromEntries(Object.entries(DEFAULT_SHORTCUTS).map(([name, fallback]) =>
    [name, shortcut(value?.shortcuts?.[name], fallback)]));
  const used = new Set();
  for (const name of Object.keys(keys)) {
    if (keys[name] && used.has(keys[name])) keys[name] = null;
    if (keys[name]) used.add(keys[name]);
  }
  return {
    autoDetect: typeof value?.autoDetect === 'boolean' ? value.autoDetect : true,
    speed: normalizeSpeed(value?.speed),
    volume: normalizeVolume(value?.volume),
    speedStep: Number.isFinite(step) && step >= 0.01 && step <= 2 ? Math.round(step * 100) / 100 : 0.1,
    presets: presets(value?.presets),
    shortcuts: keys,
    seekEnabled: value?.seekEnabled === true,
    seekSeconds: Number.isInteger(seek) && seek >= 1 && seek <= 60 ? seek : 10,
    siteSpeeds: siteSpeeds(value?.siteSpeeds),
    siteVolumes: siteVolumes(value?.siteVolumes),
    disabledSites: disabledSites(value?.disabledSites),
    mono: value?.mono === true,
    moduleCount: [2, 5].includes(value?.moduleCount) ? value.moduleCount : 5,
    moduleLayouts: moduleLayouts(value?.moduleLayouts),
    smartOrganize: value?.smartOrganize !== false
  };
}

export async function loadSettings() {
  const data = await browserApi().storage.local.get('settings');
  return normalizeSettings(data.settings);
}

export async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await browserApi().storage.local.set({ settings: normalized });
  return normalized;
}

export async function updateSettings(patch) {
  return saveSettings({ ...await loadSettings(), ...patch });
}
