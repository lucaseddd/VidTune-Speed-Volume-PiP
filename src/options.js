import { activeTab, browserApi } from './browser.js';
import { loadSettings, saveSettings, updateSettings } from './settings.js';

const form = document.querySelector('#settings-form');
const feedback = document.querySelector('#feedback');
const fields = {
  speedStep: document.querySelector('#speed-step'),
  presets: document.querySelector('#presets'),
  autoDetect: document.querySelector('#auto-detect'),
  seekEnabled: document.querySelector('#seek-enabled'),
  seekSeconds: document.querySelector('#seek-seconds'),
  siteEnabled: document.querySelector('#site-enabled'),
  siteSpeed: document.querySelector('#site-speed'),
  siteVolumeEnabled: document.querySelector('#site-volume-enabled'),
  siteVolume: document.querySelector('#site-volume'),
  siteDisabled: document.querySelector('#site-disabled')
};
const keyFields = {
  decrease: document.querySelector('#key-decrease'),
  increase: document.querySelector('#key-increase'),
  reset: document.querySelector('#key-reset'),
  seekBackward: document.querySelector('#key-seek-backward'),
  seekForward: document.querySelector('#key-seek-forward'),
  pip: document.querySelector('#key-pip')
};
let settings;
let tab;
let host = null;
const removedProfiles = new Set();

function renderProfiles() {
  const list = document.querySelector('#profiles-list');
  list.replaceChildren();
  const hosts = new Set([...Object.keys(settings.siteSpeeds), ...Object.keys(settings.siteVolumes), ...settings.disabledSites]);
  for (const name of [...hosts].sort()) {
    if (name === host || removedProfiles.has(name)) continue;
    const row = document.createElement('div');
    row.className = 'profile-row';
    row.dataset.host = name;
    const title = document.createElement('strong');
    title.textContent = name;
    title.title = name;
    const speed = document.createElement('label');
    speed.textContent = 'Speed ×';
    const speedInput = document.createElement('input');
    speedInput.type = 'number'; speedInput.min = '0.1'; speedInput.max = '16'; speedInput.step = '0.01';
    speedInput.className = 'profile-speed';
    speedInput.value = settings.siteSpeeds[name] ?? '';
    speed.append(speedInput);
    const volume = document.createElement('label');
    volume.textContent = 'Volume %';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'number'; volumeInput.min = '0'; volumeInput.max = '300'; volumeInput.step = '1';
    volumeInput.className = 'profile-volume';
    volumeInput.value = settings.siteVolumes[name] == null ? '' : String(settings.siteVolumes[name] * 100);
    volume.append(volumeInput);
    const disabled = document.createElement('label');
    disabled.className = 'switch';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.className = 'profile-disabled';
    checkbox.checked = settings.disabledSites.includes(name);
    disabled.append(checkbox, ' Disable');
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => { removedProfiles.add(name); row.remove(); show(`${name} will be removed when you save.`); });
    row.append(title, speed, volume, disabled, remove);
    list.append(row);
  }
  if (!list.children.length) list.textContent = 'No other saved sites.';
}

function show(text, error = false) {
  feedback.textContent = text;
  feedback.className = error ? 'error' : '';
}

function validNumber(input, min, max, integer = false) {
  const value = Number(input.value);
  if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${input.closest('label')?.textContent?.trim() ?? 'Value'} must be between ${min} and ${max}.`);
  }
  return value;
}

function presetValues() {
  const values = fields.presets.value.split(',').map((part) => Number(part.trim()));
  if (values.length < 3 || values.length > 8 || values.some((number) =>
    !Number.isFinite(number) || number < 0.1 || number > 16 || Math.abs(Math.round(number * 100) - number * 100) > 1e-6
  ) || new Set(values).size !== values.length) {
    throw new Error('Enter 3–8 different preset speeds from 0.1× to 16×, with at most two decimal places.');
  }
  return values;
}

function chosenKeys() {
  const keys = Object.fromEntries(Object.entries(keyFields).map(([name, field]) => [name, field.value || null]));
  const assigned = Object.values(keys).filter(Boolean);
  if (new Set(assigned).size !== assigned.length) throw new Error('Each keyboard shortcut needs a different letter.');
  if (fields.seekEnabled.checked && (!keys.seekBackward || !keys.seekForward)) {
    throw new Error('Choose backward and forward letters before enabling skip controls.');
  }
  return keys;
}

function populate() {
  fields.speedStep.value = String(settings.speedStep);
  fields.presets.value = settings.presets.join(', ');
  fields.autoDetect.checked = settings.autoDetect;
  fields.seekEnabled.checked = settings.seekEnabled;
  fields.seekSeconds.value = String(settings.seekSeconds);
  for (const [name, field] of Object.entries(keyFields)) field.value = settings.shortcuts[name] ?? '';
  fields.siteEnabled.checked = Boolean(host && Object.hasOwn(settings.siteSpeeds, host));
  fields.siteSpeed.value = String(settings.siteSpeeds[host] ?? settings.speed);
  fields.siteVolumeEnabled.checked = Boolean(host && Object.hasOwn(settings.siteVolumes, host));
  fields.siteVolume.value = String(Math.round((settings.siteVolumes[host] ?? settings.volume) * 100));
  fields.siteDisabled.checked = Boolean(host && settings.disabledSites.includes(host));
  fields.siteEnabled.disabled = !host;
  fields.siteSpeed.disabled = !host || !fields.siteEnabled.checked;
  fields.siteVolumeEnabled.disabled = !host;
  fields.siteVolume.disabled = !host || !fields.siteVolumeEnabled.checked;
  fields.siteDisabled.disabled = !host;
  renderProfiles();
}

for (const field of Object.values(keyFields)) {
  field.append(new Option('None', ''));
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') field.append(new Option(letter, `Key${letter}`));
}

fields.siteEnabled.addEventListener('change', () => {
  fields.siteSpeed.disabled = !fields.siteEnabled.checked;
});
fields.siteVolumeEnabled.addEventListener('change', () => {
  fields.siteVolume.disabled = !fields.siteVolumeEnabled.checked;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const speedStep = validNumber(fields.speedStep, 0.01, 2);
    const seekSeconds = validNumber(fields.seekSeconds, 1, 60, true);
    const siteSpeeds = { ...settings.siteSpeeds };
    const siteVolumes = { ...settings.siteVolumes };
    const disabledSites = new Set(settings.disabledSites);
    for (const name of removedProfiles) {
      delete siteSpeeds[name]; delete siteVolumes[name]; disabledSites.delete(name);
    }
    for (const row of document.querySelectorAll('.profile-row')) {
      const name = row.dataset.host;
      const speedInput = row.querySelector('.profile-speed');
      const volumeInput = row.querySelector('.profile-volume');
      if (speedInput.value.trim()) siteSpeeds[name] = validNumber(speedInput, 0.1, 16);
      else delete siteSpeeds[name];
      if (volumeInput.value.trim()) siteVolumes[name] = validNumber(volumeInput, 0, 300) / 100;
      else delete siteVolumes[name];
      if (row.querySelector('.profile-disabled').checked) disabledSites.add(name);
      else disabledSites.delete(name);
    }
    if (host) {
      if (fields.siteEnabled.checked) siteSpeeds[host] = validNumber(fields.siteSpeed, 0.1, 16);
      else delete siteSpeeds[host];
      if (fields.siteVolumeEnabled.checked) siteVolumes[host] = validNumber(fields.siteVolume, 0, 300) / 100;
      else delete siteVolumes[host];
      if (fields.siteDisabled.checked) disabledSites.add(host);
      else disabledSites.delete(host);
    }
    const next = {
      ...await loadSettings(), autoDetect: fields.autoDetect.checked, speedStep, presets: presetValues(), shortcuts: chosenKeys(),
      seekEnabled: fields.seekEnabled.checked, seekSeconds, siteSpeeds, siteVolumes,
      disabledSites: [...disabledSites]
    };
    settings = await saveSettings(next);
    removedProfiles.clear();
    populate();
    show('Settings saved.');
  } catch (error) {
    show(error.message || 'Could not save settings.', true);
  }
});

try {
  [settings, tab] = await Promise.all([loadSettings(), activeTab()]);
  const url = new URL(tab?.url);
  if (['http:', 'https:'].includes(url.protocol)) host = url.hostname.toLowerCase();
} catch {
  settings = settings ?? await loadSettings();
}
document.querySelector('#site-name').textContent = host || 'Open a website to set a site speed.';
populate();
for (const field of Object.values(keyFields)) field.addEventListener('change', async () => {
  try {
    const saved = await updateSettings({ shortcuts: chosenKeys() });
    settings = { ...settings, shortcuts: saved.shortcuts };
    show('Shortcuts saved.');
  } catch (error) { show(error.message || 'Could not save shortcuts.', true); }
});
browserApi().storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  if (JSON.stringify(changes.settings.newValue?.shortcuts) === JSON.stringify(changes.settings.oldValue?.shortcuts)) return;
  loadSettings().then(latest => {
    settings = { ...settings, shortcuts: latest.shortcuts };
    for (const [name, field] of Object.entries(keyFields)) field.value = settings.shortcuts[name] ?? '';
  }).catch(() => show('Could not sync shortcuts.', true));
});
