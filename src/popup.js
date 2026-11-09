import { activeTab, browserApi, sendToVideo } from './browser.js';
import { summarizeVideos } from './detection.js';
import { loadSettings, MODULES, updateSettings } from './settings.js';
import { formatSpeed, normalizeSpeed } from './speed.js';
import { formatVolume, positionToVolume, volumeToPosition } from './volume.js';

const labels = {
  speed: 'Playback Speed', volume: 'Volume Boost', mono: 'Mono Audio', pip: 'Picture-in-Picture',
  presets: 'Speed Presets', customSpeed: 'Custom Speed', resetSpeed: 'Reset Speed',
  seekBackward: 'Skip Back', seekForward: 'Skip Ahead', tabVolume: 'Tab Volume'
};
const list = document.querySelector('#module-list');
const countPicker = document.querySelector('#tool-count');
const customizeButton = document.querySelector('#customize-tools');
const choices = document.querySelector('#tool-choices');
const status = document.querySelector('#status');
const smartToggle = document.querySelector('#smart-organize');
const versionLabel = document.querySelector('#version');
const shortcutLegend = document.querySelector('.footnote');
const footer = document.querySelector('.popup-footer');
const volumePresets = document.querySelector('#volume-presets');
const volumePresetsSlot = document.querySelector('#volume-presets-slot');
versionLabel.textContent = `v${browserApi().runtime.getManifest().version}`;
let settings;
let currentTab;
let videoState = { speed: 1, volume: 1, mono: false, hasVideo: false };
let scopeActive = false;
let volumeTimer;
let volumeRequests = Promise.resolve();
let layoutWrites = Promise.resolve();

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = kind;
}

function renderModules() {
  // Move these shared elements out before replacing the previous tool layout.
  footer.append(shortcutLegend);
  volumePresetsSlot.append(volumePresets);
  const count = settings.moduleCount;
  document.documentElement.dataset.toolCount = String(count);
  countPicker.value = String(count);
  smartToggle.checked = settings.smartOrganize;
  list.className = settings.smartOrganize ? `module-list smart smart-${({ 2: 'two', 5: 'five', 10: 'ten' })[count]}` : 'module-list';
  customizeButton.hidden = !settings.smartOrganize;
  if (!settings.smartOrganize) {
    choices.hidden = true;
    customizeButton.setAttribute('aria-expanded', 'false');
  }
  list.hidden = settings.smartOrganize && !choices.hidden;
  const selected = settings.moduleLayouts[count].map((name, index) => ({ name, index }));
  if (settings.smartOrganize) {
    const preferred = ['speed', 'mono', 'pip', 'volume', 'tabVolume', 'presets', 'customSpeed',
      'resetSpeed', 'seekBackward', 'seekForward'];
    selected.sort((a, b) => preferred.indexOf(a.name) - preferred.indexOf(b.name));
  }
  list.replaceChildren(...selected.map(({ name, index }) => {
    const row = document.createElement('div');
    row.className = 'module-row';
    row.dataset.module = name;
    row.dataset.index = String(index);
    const number = document.createElement('span');
    number.className = 'module-number';
    number.textContent = String(index + 1);
    const select = document.createElement('select');
    select.className = 'module-select';
    select.setAttribute('aria-label', `Tool ${index + 1} function`);
    select.append(...MODULES.map((id) => new Option(labels[id], id)));
    select.value = name;
    const title = document.createElement('strong');
    title.className = 'module-title';
    title.textContent = labels[name];
    const body = document.createElement('div');
    body.className = 'module-control';
    body.append(document.querySelector(`#module-${name}`).content.cloneNode(true));
    row.append(number, select, title, body);
    return row;
  }));
  if (settings.smartOrganize) organizeTools();
  updateCompactVisibility();
  choices.replaceChildren(...settings.moduleLayouts[count].map((name, index) => {
    const label = document.createElement('label');
    label.textContent = `Tool ${index + 1}`;
    const select = document.createElement('select');
    select.className = 'choice-select';
    select.dataset.index = String(index);
    select.setAttribute('aria-label', `Tool ${index + 1} function`);
    select.append(...MODULES.map((id) => new Option(labels[id], id)));
    select.value = name;
    label.append(select);
    return label;
  }));
  const preset = document.querySelector('#preset-choice');
  if (preset) {
    preset.append(new Option('Choose speed', ''));
    for (const speed of settings.presets) preset.append(new Option(formatSpeed(speed), String(speed)));
  }
  renderVideoState(videoState);
}

function updateCompactVisibility() {
  volumePresets.hidden = !choices.hidden || !settings.moduleLayouts[settings.moduleCount].includes('volume');
  volumePresetsSlot.hidden = volumePresetsSlot.children.length === 0 || volumePresets.hidden;
  footer.hidden = footer.children.length === 0 || !choices.hidden;
}

function organizeTools() {
  const rows = new Map([...list.children].map((row) => [row.dataset.module, row]));
  const group = (className, label) => {
    const section = document.createElement('section');
    section.className = className;
    section.setAttribute('aria-label', label);
    return section;
  };
  const speed = rows.get('speed');
  if (speed) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.append(speed.querySelector('.module-title'), shortcutLegend);
    speed.prepend(heading);
    const section = group('speed-workspace', 'Playback speed');
    section.append(speed, document.querySelector('#smart-speed-extra').content.cloneNode(true));
    for (const value of settings.presets) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.speed = String(value); button.textContent = formatSpeed(value);
      section.querySelector('.speed-presets').append(button);
    }
    for (const name of ['presets', 'customSpeed', 'resetSpeed']) {
      const row = rows.get(name);
      if (row) { row.hidden = true; section.append(row); rows.delete(name); }
    }
    list.append(section); rows.delete('speed');
  }
  const quick = group('quick-actions', 'Video actions');
  for (const name of ['seekBackward', 'seekForward', 'pip']) {
    if (rows.has(name)) { quick.append(rows.get(name)); rows.delete(name); }
  }
  if (quick.children.length === 1 && quick.firstElementChild.dataset.module === 'pip' && speed) {
    const pip = quick.firstElementChild;
    pip.classList.add('pip-inline');
    list.querySelector('.speed-workspace').append(pip);
  } else if (quick.children.length) list.append(quick);
  const volume = rows.get('volume');
  if (volume) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.append(volume.querySelector('.module-title'), volumePresets);
    volume.prepend(heading);
    const section = group('audio-workspace', 'Volume and audio');
    section.append(volume, document.querySelector('#smart-volume-extra').content.cloneNode(true));
    const switches = group('audio-switches', 'Audio options');
    for (const name of ['mono', 'tabVolume']) {
      if (rows.has(name)) { switches.append(rows.get(name)); rows.delete(name); }
    }
    if (switches.children.length) section.append(switches);
    list.append(section); rows.delete('volume');
  }
  for (const row of rows.values()) list.append(row);
  for (const [action, symbol] of [['SEEK_BACKWARD', '↶'], ['SEEK_FORWARD', '↷']]) {
    const button = quick.querySelector(`[data-action="${action}"]`);
    if (button) button.textContent = `${symbol} ${settings.seekSeconds}s`;
  }
}

function renderVideoState(state) {
  if (!state || state.error) throw new Error(state?.error || 'Video unavailable');
  videoState = state;
  document.querySelector('#video-summary').textContent = summarizeVideos(state.count ?? 0);
  setStatus(state.disabled ? 'Disabled on this site' : state.pipPrompt ? 'Click PiP on the video' :
    state.pipError || (state.monoUnavailable ? 'Mono unavailable for this video' :
    state.boostUnavailable ? 'Boost unavailable for this video' : state.boostPending ? 'Play video for boost' :
      state.hasVideo ? 'Ready' : 'No video'),
  state.monoUnavailable || state.boostUnavailable || state.pipError ? 'error' : state.hasVideo && !state.disabled ? 'ready' : '');
  const speed = normalizeSpeed(state.speed);
  const speedValue = document.querySelector('#speed-value');
  if (speedValue) speedValue.textContent = formatSpeed(speed);
  const manual = document.querySelector('#manual-value');
  if (manual && document.activeElement !== manual) manual.value = String(speed);
  const smartManual = document.querySelector('#smart-manual');
  if (smartManual && document.activeElement !== smartManual) smartManual.value = String(speed);
  for (const input of [manual, smartManual]) if (input) input.step = String(settings.speedStep);
  for (const button of list.querySelectorAll('[data-speed]')) button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === speed));
  for (const button of volumePresets.querySelectorAll('[data-volume]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.volume) === state.volume));
    button.disabled = Boolean(state.disabled);
  }
  const slider = document.querySelector('#volume-slider');
  if (slider && document.activeElement !== slider) slider.value = String(volumeToPosition(state.volume));
  const volumeValue = document.querySelector('#volume-value');
  if (volumeValue) volumeValue.textContent = formatVolume(state.volume);
  const mono = document.querySelector('#mono-toggle');
  if (mono) mono.checked = Boolean(state.mono);
  const pip = document.querySelector('#toggle-pip');
  if (pip) {
    pip.disabled = Boolean(state.disabled || !state.pipAvailable);
    pip.setAttribute('aria-pressed', String(Boolean(state.pipActive)));
    pip.setAttribute('aria-label', state.pipActive ? 'Close Picture in Picture' : 'Open Picture in Picture');
  }
  const tabVolume = document.querySelector('#tab-volume-only');
  if (tabVolume) tabVolume.checked = scopeActive;
  for (const element of list.querySelectorAll('button:not(#toggle-pip), input, select:not(.module-select)')) {
    element.disabled = Boolean(state.disabled);
  }
}

async function send(message) {
  if (!currentTab?.id) return;
  try {
    const state = await sendToVideo(currentTab.id, message);
    renderVideoState(state);
    if (state.pipPrompt) await browserApi().tabs.update(currentTab.id, { active: true });
    if (!state.hasVideo && !state.disabled) setStatus('Saved for next video');
  } catch { setStatus('Control unavailable here', 'error'); }
}

function sendVolume(volume, persist) {
  if (!currentTab?.id) return;
  volumeRequests = volumeRequests.catch(() => {}).then(() => send({ type: persist ? 'SET_VOLUME' : 'PREVIEW_VOLUME', volume }));
}

function saveLayout(patch) {
  layoutWrites = layoutWrites.catch(() => {}).then(async () => {
    settings = await updateSettings(patch);
    renderModules();
  }).catch(() => setStatus('Could not save tools', 'error'));
}

function changeTool(target) {
  const index = Number(target.dataset.index ?? target.closest('.module-row').dataset.index);
  const layout = [...settings.moduleLayouts[settings.moduleCount]];
  const other = layout.indexOf(target.value);
  if (other >= 0) layout[other] = layout[index];
  layout[index] = target.value;
  saveLayout({ moduleLayouts: { ...settings.moduleLayouts, [settings.moduleCount]: layout } });
}

choices.addEventListener('change', (event) => {
  if (event.target.matches('.choice-select')) changeTool(event.target);
});

list.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.matches('.module-select')) {
    changeTool(target);
  } else if (target.id === 'volume-slider') {
    clearTimeout(volumeTimer);
    volumeTimer = null;
    sendVolume(positionToVolume(target.value), true);
  } else if (target.id === 'preset-choice' && target.value) {
    send({ type: 'SET_SPEED', speed: Number(target.value) });
  } else if (target.id === 'mono-toggle') {
    send({ type: 'SET_MONO', enabled: target.checked });
  } else if (target.id === 'tab-volume-only' && currentTab?.id) {
    target.disabled = true;
    try {
      await volumeRequests;
      const result = await browserApi().runtime.sendMessage({
        type: 'SET_VOLUME_SCOPE', tabId: currentTab.id, enabled: target.checked,
        volume: videoState.volume
      });
      if (result.error) throw new Error(result.error);
      scopeActive = result.active;
      renderVideoState(await sendToVideo(currentTab.id, { type: 'SYNC_VOLUME_SCOPE' }));
    } catch { setStatus('Could not change volume scope', 'error'); }
    finally { target.disabled = false; }
  }
});

list.addEventListener('input', (event) => {
  if (event.target.id !== 'volume-slider') return;
  const volume = positionToVolume(event.target.value);
  document.querySelector('#volume-value').textContent = formatVolume(volume);
  if (!volumeTimer) volumeTimer = setTimeout(() => {
    volumeTimer = null;
    sendVolume(volume, false);
  }, 50);
});

list.addEventListener('click', (event) => {
  const speedPreset = event.target.closest('[data-speed]');
  if (speedPreset) { send({ type: 'SET_SPEED', speed: Number(speedPreset.dataset.speed) }); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'CUSTOM_SPEED' || action === 'SMART_SPEED') {
    const input = document.querySelector(action === 'SMART_SPEED' ? '#smart-manual' : '#manual-value');
    const speed = Number(input.value);
    if (!input.value.trim() || !Number.isFinite(speed) || speed < 0.1 || speed > 16) {
      setStatus('Enter 0.1×–16×', 'error');
      return;
    }
    send({ type: 'SET_SPEED', speed });
  } else send({ type: action });
});

volumePresets.addEventListener('click', (event) => {
  const preset = event.target.closest('[data-volume]');
  if (preset) sendVolume(Number(preset.dataset.volume), true);
});

countPicker.addEventListener('change', () => saveLayout({ moduleCount: Number(countPicker.value) }));
smartToggle.addEventListener('change', () => saveLayout({ smartOrganize: smartToggle.checked }));
customizeButton.addEventListener('click', () => {
  choices.hidden = !choices.hidden;
  list.hidden = !choices.hidden;
  customizeButton.setAttribute('aria-expanded', String(!choices.hidden));
  updateCompactVisibility();
});
document.querySelector('#open-settings').addEventListener('click', () => browserApi().runtime.openOptionsPage());

document.addEventListener('keydown', (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.code === 'Enter' && event.target.id === 'smart-manual') {
    event.preventDefault(); list.querySelector('[data-action="SMART_SPEED"]').click(); return;
  }
  if (event.composedPath().some((element) => element?.closest?.('input:not([type="range"]):not([type="radio"]):not([type="checkbox"]), textarea, [contenteditable], [role="textbox"]'))) return;
  const shortcut = Object.keys(settings?.shortcuts ?? {}).find((key) => settings.shortcuts[key] === event.code);
  if (!shortcut || (shortcut.startsWith('seek') && !settings.seekEnabled)) return;
  const action = {
    decrease: 'DECREASE', increase: 'INCREASE', reset: 'RESET',
    seekBackward: 'SEEK_BACKWARD', seekForward: 'SEEK_FORWARD', pip: 'TOGGLE_PIP'
  }[shortcut];
  if (event.repeat && !['INCREASE', 'DECREASE'].includes(action)) return;
  event.preventDefault();
  send({ type: action });
}, true);

try {
  [settings, currentTab] = await Promise.all([loadSettings(), activeTab()]);
  videoState = { ...videoState, speed: settings.speed, volume: settings.volume, mono: settings.mono };
  renderModules();
  if (currentTab?.id) {
    try { document.querySelector('#site').textContent = new URL(currentTab.url).hostname; } catch { /* Restricted tab. */ }
    const scope = await browserApi().runtime.sendMessage({ type: 'GET_VOLUME_SCOPE', tabId: currentTab.id });
    scopeActive = Boolean(scope.active);
    if (settings.autoDetect) renderVideoState(await sendToVideo(currentTab.id, { type: 'GET_STATE' }));
    else setStatus('Video scan paused');
  } else setStatus('No tab');
} catch { setStatus('VidTune could not load', 'error'); }
