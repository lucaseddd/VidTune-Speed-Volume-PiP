import { sendToFrame } from './browser.js';

const api = globalThis.browser ?? globalThis.chrome;
const actions = new Set(['INCREASE', 'DECREASE', 'RESET', 'SEEK_BACKWARD', 'SEEK_FORWARD', 'TOGGLE_PIP']);

// Session storage survives worker suspension, but is cleared by a browser restart.
const sessionReady = (async () => {
  const { volumeSessionReady } = await api.storage.session.get('volumeSessionReady');
  if (volumeSessionReady) return;
  const { settings, savedVolumeTabs = {} } = await api.storage.local.get(['settings', 'savedVolumeTabs']);
  if (settings) await api.storage.local.set({ settings: { ...settings, volume: 1 } });
  const tabs = await api.tabs.query({});
  await api.storage.session.set({ volumeSessionReady: true, restoreVolumeTabs: savedVolumeTabs,
    restoreVolumeTabIds: tabs.map((tab) => tab.id) });
})();
let scopeWrites = sessionReady;

async function rememberScope(tabId, scope) {
  const { savedVolumeTabs = {} } = await api.storage.local.get('savedVolumeTabs');
  if (!scope) delete savedVolumeTabs[tabId];
  else {
    const tab = await api.tabs.get(tabId);
    let url = tab.url;
    if (!url) {
      const frames = await api.webNavigation.getAllFrames({ tabId });
      url = frames?.find((frame) => frame.frameId === 0)?.url;
    }
    if (!/^https?:/.test(url ?? '')) return;
    savedVolumeTabs[tabId] = { ...scope, url, index: tab.index };
  }
  await api.storage.local.set({ savedVolumeTabs });
}

async function restoreScope(tabId, scopes, senderTab) {
  if (Object.hasOwn(scopes, tabId)) return;
  const { restoreVolumeTabs = {}, restoreVolumeTabIds = [] } = await api.storage.session.get(['restoreVolumeTabs', 'restoreVolumeTabIds']);
  if (!restoreVolumeTabIds.includes(tabId)) return;
  const tab = senderTab?.id === tabId ? senderTab : await api.tabs.get(tabId);
  let url = tab.url;
  if (!url) {
    const frames = await api.webNavigation.getAllFrames({ tabId });
    url = frames?.find((frame) => frame.frameId === 0)?.url;
  }
  const candidates = Object.entries(restoreVolumeTabs).filter(([, saved]) => saved.url === url && saved.index === tab.index);
  // Never guess when identical tabs from different windows are ambiguous.
  if (candidates.length !== 1) return;
  const samePosition = (await api.tabs.query({})).filter((item) => item.index === tab.index);
  const samePages = await Promise.all(samePosition.map(async (item) => {
    if (item.url) return item.url === url;
    const frames = await api.webNavigation.getAllFrames({ tabId: item.id }).catch(() => []);
    return frames?.find((frame) => frame.frameId === 0)?.url === url;
  }));
  if (samePages.filter(Boolean).length > 1) return;
  const [oldId, saved] = candidates[0];
  scopes[tabId] = { volume: saved.volume, speed: saved.speed };
  delete restoreVolumeTabs[oldId];
  await api.storage.session.set({ restoreVolumeTabs, volumeScopes: scopes });
  const { savedVolumeTabs = {} } = await api.storage.local.get('savedVolumeTabs');
  delete savedVolumeTabs[oldId];
  savedVolumeTabs[tabId] = { ...saved, index: tab.index };
  await api.storage.local.set({ savedVolumeTabs });
}

async function rememberPositions(scopes) {
  const tabs = await api.tabs.query({});
  for (const tab of tabs) {
    if (scopes[tab.id]) await rememberScope(tab.id, scopes[tab.id]);
  }
}

async function volumeScopes() {
  const { volumeScopes, volumeScope } = await api.storage.session.get(['volumeScopes', 'volumeScope']);
  if (volumeScopes) return Object.fromEntries(Object.entries(volumeScopes).map(([tabId, scope]) =>
    [tabId, typeof scope === 'number' ? { volume: scope } : scope]));
  return volumeScope?.tabId ? { [volumeScope.tabId]: { volume: volumeScope.volume } } : {};
}

function changeScopes(update) {
  const task = scopeWrites.then(async () => {
    const scopes = await volumeScopes();
    const result = await update(scopes);
    await api.storage.session.set({ volumeScopes: scopes });
    await api.storage.session.remove('volumeScope');
    return result;
  });
  scopeWrites = task.catch(() => {});
  return task;
}

api.tabs.onRemoved.addListener((tabId, info) => {
  changeScopes(async (scopes) => {
    delete scopes[tabId];
    // Closing a browser window must not erase its restorable tab preferences.
    if (!info?.isWindowClosing) {
      await rememberScope(tabId, null);
      await rememberPositions(scopes);
    }
  }).catch(() => {});
});

api.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  changeScopes(async (scopes) => {
    if (scopes[tabId]) await rememberScope(tabId, scopes[tabId]);
  }).catch(() => {});
});

api.tabs.onMoved.addListener(() => {
  changeScopes(async (scopes) => {
    await rememberPositions(scopes);
  }).catch(() => {});
});

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GET_VOLUME_SCOPE') {
    const task = scopeWrites.then(async () => {
      const scopes = await volumeScopes();
      const tabId = message.tabId ?? sender.tab?.id;
      await restoreScope(tabId, scopes, sender.tab);
      let siteHost = null;
      try { siteHost = new URL(sender.tab?.url).hostname.toLowerCase(); } catch { /* No web tab. */ }
      return { active: Object.hasOwn(scopes, tabId), volume: scopes[tabId]?.volume ?? 1, speed: scopes[tabId]?.speed, siteHost };
    });
    scopeWrites = task.catch(() => {});
    task.then(respond, (error) => respond({ error: String(error) }));
    return true;
  }
  if (message?.type === 'SET_VOLUME_SCOPE' && Number.isInteger(message.tabId)) {
    changeScopes(async (scopes) => {
      if (message.enabled) {
        scopes[message.tabId] = { volume: Math.max(0, Math.min(3, Number(message.volume) || 0)),
          speed: Math.max(0.1, Math.min(16, Number(message.speed) || 1)) };
      } else {
        delete scopes[message.tabId];
      }
      await rememberScope(message.tabId, scopes[message.tabId]);
      return { active: Object.hasOwn(scopes, message.tabId), ...scopes[message.tabId] };
    }).then(respond, (error) => respond({ error: String(error) }));
    return true;
  }
  if (['SAVE_SCOPED_VOLUME', 'SAVE_SCOPED_SPEED'].includes(message?.type) && sender.tab?.id) {
    changeScopes(async (scopes) => {
      if (!Object.hasOwn(scopes, sender.tab.id)) return { active: false };
      if (message.type === 'SAVE_SCOPED_SPEED') scopes[sender.tab.id].speed = Math.max(0.1, Math.min(16, Number(message.speed) || 1));
      else scopes[sender.tab.id].volume = Math.max(0, Math.min(3, Number(message.volume) || 0));
      await rememberScope(sender.tab.id, scopes[sender.tab.id]);
      return { active: true };
    }).then(respond, (error) => respond({ error: String(error) }));
    return true;
  }
  if (!sender.tab?.id) return;
  if (message?.type !== 'INIT_PREFERENCES' && (message?.type !== 'VIDEO_SHORTCUT' || !actions.has(message.action))) return;
  let pageHost = null;
  try { pageHost = new URL(sender.tab.url).hostname.toLowerCase(); } catch { /* No web tab. */ }
  if (pageHost) {
    const task = sessionReady.then(() => api.storage.local.get('settings')).then(({ settings }) =>
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
