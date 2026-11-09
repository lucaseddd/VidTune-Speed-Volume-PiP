// A passive key listener is the only work performed on pages until a video shortcut is used.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  let shortcuts = { decrease: 'KeyA', increase: 'KeyD', reset: 'KeyQ', seekBackward: null, seekForward: null, pip: null };
  let seekEnabled = false;
  let disabled = false;
  let siteHost = location.hostname;
  let preferenceKey = null;

  function useSettings(settings) {
    shortcuts = {
      decrease: 'KeyA', increase: 'KeyD', reset: 'KeyQ', seekBackward: null, seekForward: null, pip: null,
      ...settings?.shortcuts
    };
    seekEnabled = settings?.seekEnabled === true;
    disabled = settings?.disabledSites?.includes(siteHost) === true;
    if (disabled) return;
    const speed = settings?.siteSpeeds?.[siteHost];
    const volume = settings?.siteVolumes?.[siteHost] ?? settings?.volume ?? 1;
    const nextKey = speed != null || volume !== 1 || settings?.mono === true
      ? `${speed ?? ''}:${volume}:${settings?.mono === true}` : null;
    if (nextKey && nextKey !== preferenceKey) {
      preferenceKey = nextKey;
      api.runtime.sendMessage({ type: 'INIT_PREFERENCES' }).catch(() => {});
    }
  }

  Promise.all([api.storage.local.get('settings'), api.runtime.sendMessage({ type: 'GET_VOLUME_SCOPE' })])
    .then(([{ settings }, scope]) => {
      siteHost = scope?.siteHost || siteHost;
      useSettings(settings);
      if (!disabled && scope?.active) api.runtime.sendMessage({ type: 'INIT_PREFERENCES' }).catch(() => {});
    }).catch(() => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) useSettings(changes.settings.newValue);
  });

  function inEditable(element) {
    return Boolean(element?.closest?.('input, textarea, select, [contenteditable], [role="textbox"]'));
  }

  window.addEventListener('keydown', (event) => {
    if (disabled || !event.isTrusted || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const name = Object.keys(shortcuts).find((key) => shortcuts[key] === event.code);
    if (!name || (name.startsWith('seek') && !seekEnabled)) return;
    const action = {
      decrease: 'DECREASE', increase: 'INCREASE', reset: 'RESET',
      seekBackward: 'SEEK_BACKWARD', seekForward: 'SEEK_FORWARD', pip: 'TOGGLE_PIP'
    }[name];
    if (event.repeat && !['INCREASE', 'DECREASE'].includes(action)) return;
    if (event.composedPath().some(inEditable) || !(globalThis.__vidTuneFindVideos?.().length ?? document.querySelector('video'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    api.runtime.sendMessage({ type: 'VIDEO_SHORTCUT', action }).catch(() => {});
  }, true);
})();
