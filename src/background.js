import { sendToFrame } from './browser.js';

const api = globalThis.browser ?? globalThis.chrome;
const actions = new Set(['INCREASE', 'DECREASE', 'RESET', 'SEEK_BACKWARD', 'SEEK_FORWARD', 'TOGGLE_PIP']);

let scopeWrites = Promise.resolve();

async function volumeScopes() {
  const { volumeScopes, volumeScope } = await api.storage.session.get(['volumeScopes', 'volumeScope']);
  if (volumeScopes) return Object.fromEntries(Object.entries(volumeScopes).map(([tabId, scope]) =>
    [tabId, typeof scope === 'number' ? { volume: scope } : scope]));
  return volumeScope?.tabId ? { [volumeScope.tabId]: { volume: volumeScope.volume } } : {};
}

function changeScopes(update) {
  const task = scopeWrites.then(async () => {
    const scopes = await volumeScopes();
    const result = update(scopes);
    await api.storage.session.set({ volumeScopes: scopes });
    await api.storage.session.remove('volumeScope');
    return result;
  });
  scopeWrites = task.catch(() => {});
  return task;
}

api.tabs.onRemoved.addListener((tabId) => {
  changeScopes((scopes) => { delete scopes[tabId]; }).catch(() => {});
});

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GET_VOLUME_SCOPE') {
    scopeWrites.then(volumeScopes).then((scopes) => {
      const tabId = message.tabId ?? sender.tab?.id;
      let siteHost = null;
      try { siteHost = new URL(sender.tab?.url).hostname.toLowerCase(); } catch { /* No web tab. */ }
      respond({ active: Object.hasOwn(scopes, tabId), volume: scopes[tabId]?.volume ?? 1, speed: scopes[tabId]?.speed, siteHost });
    }, (error) => respond({ error: String(error) }));
    return true;
  }
  if (message?.type === 'SET_VOLUME_SCOPE' && Number.isInteger(message.tabId)) {
    changeScopes((scopes) => {
      if (message.enabled) {
        scopes[message.tabId] = { volume: Math.max(0, Math.min(3, Number(message.volume) || 0)),
          speed: Math.max(0.1, Math.min(16, Number(message.speed) || 1)) };
      } else {
        delete scopes[message.tabId];
      }
      return { active: Object.hasOwn(scopes, message.tabId), ...scopes[message.tabId] };
    }).then(respond, (error) => respond({ error: String(error) }));
    return true;
  }
  if (['SAVE_SCOPED_VOLUME', 'SAVE_SCOPED_SPEED'].includes(message?.type) && sender.tab?.id) {
    changeScopes((scopes) => {
      if (!Object.hasOwn(scopes, sender.tab.id)) return { active: false };
      if (message.type === 'SAVE_SCOPED_SPEED') scopes[sender.tab.id].speed = Math.max(0.1, Math.min(16, Number(message.speed) || 1));
      else scopes[sender.tab.id].volume = Math.max(0, Math.min(3, Number(message.volume) || 0));
      return { active: true };
    }).then(respond, (error) => respond({ error: String(error) }));
    return true;
  }
  if (!sender.tab?.id) return;
  if (message?.type !== 'INIT_PREFERENCES' && (message?.type !== 'VIDEO_SHORTCUT' || !actions.has(message.action))) return;
  let pageHost = null;
  try { pageHost = new URL(sender.tab.url).hostname.toLowerCase(); } catch { /* No web tab. */ }
  if (pageHost) {
    const task = api.storage.local.get('settings').then(({ settings }) =>
      settings?.disabledSites?.includes(pageHost) === true);
    task.then((blocked) => {
      if (blocked) respond({ disabled: true });
      else {
        const type = message.type === 'INIT_PREFERENCES' ? 'GET_STATE' : message.action;
        sendToFrame(sender.tab.id, sender.frameId ?? 0, { type }).then(respond, (error) =>
          respond({ error: String(error) }));
      }
    }, (error) => respond({ error: String(error) }));
    return true;
  }
  const type = message.type === 'INIT_PREFERENCES' ? 'GET_STATE' : message.action;
  sendToFrame(sender.tab.id, sender.frameId ?? 0, { type }).then(respond, (error) => {
    console.warn('VidTune could not control this page:', error);
    respond({ error: String(error) });
  });
  return true;
});
