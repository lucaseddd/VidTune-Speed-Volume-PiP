// Passive frame bootstrap; the controller initializes only for a control request.
(() => {
  if (globalThis.__vidTuneBootstrap) return;
  globalThis.__vidTuneBootstrap = true;
  let cachedTree;
  function mediaTree() {
    if (cachedTree) return cachedTree;
    const roots = [document];
    const videos = [];
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      videos.push(...root.querySelectorAll('video'));
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    cachedTree = { roots, videos: videos.filter((video) => video.isConnected) };
    queueMicrotask(() => { cachedTree = null; });
    return cachedTree;
  }
  globalThis.__vidTuneFindVideos = () => mediaTree().videos;
  const bootstrapApi = globalThis.browser ?? globalThis.chrome;
  let handleMessage;
  bootstrapApi.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type === 'PROBE_VIDEOS') {
      const videos = mediaTree().videos;
      const visible = videos.filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const candidates = visible.length ? visible : videos;
      const playing = candidates.filter((video) => !video.paused && !video.ended);
      const area = Math.max(0, ...(playing.length ? playing : candidates).map((video) => {
        const rect = video.getBoundingClientRect();
        return Math.max(0, rect.width) * Math.max(0, rect.height);
      }));
      respond({ count: videos.length, playing: playing.length > 0, area });
      return;
    }
    if (!['GET_STATE', 'SET_SPEED', 'INCREASE', 'DECREASE', 'RESET', 'SET_VOLUME', 'PREVIEW_VOLUME', 'SYNC_VOLUME_SCOPE', 'SEEK_BACKWARD', 'SEEK_FORWARD', 'TOGGLE_PIP', 'SET_MONO'].includes(message?.type)) return;
    initialize();
    return handleMessage(message, sender, respond);
  });

  function initialize() {
    if (globalThis.__vidTuneController) return;
    globalThis.__vidTuneController = true;

    const api = globalThis.browser ?? globalThis.chrome;
    const MIN = 0.1;
    const MAX = 16;
    let siteHost = globalThis.location?.hostname ?? '';
    let desiredSpeed = 1;
    let desiredVolume = 1;
    let desiredMono = false;
    let monoError = false;
    let volumeManaged = false;
    let scopedVolume = false;
    let activeBoostVideo = null;
    let activeMonoVideo = null;
    let boostError = null;
    const audioRoutes = new WeakMap();
    const pendingRoutes = new WeakMap();
    const failedSources = new WeakMap();
    const rateCorrections = new WeakMap();
    const shadowRoots = new Set();
    const mediaEvents = ['play', 'playing', 'loadedmetadata', 'loadeddata', 'canplay', 'loadstart', 'ratechange'];
    let hasSiteProfile = false;
    let disabled = false;
    let pipError = null;
    let pipPrompt = null;
    let speedStep = 0.1;
    let seekSeconds = 10;
    let lastActiveVideo = null;
    let observer = null;
    let scanQueued = false;
    let indicator = null;
    let indicatorVideo = null;
    let indicatorPlayer = null;
    let controlsObserver = null;
    let pointerVisible = false;
    let changeVisible = false;
    let pointerTimer = null;
    let changeTimer = null;

    function normalize(value) {
      if (value == null || value === '') return 1;
      const number = Number(value);
      return Number.isFinite(number)
        ? Math.round(Math.min(MAX, Math.max(MIN, number)) * 100) / 100
        : 1;
    }

    function normalizeVolume(value) {
      if (value == null || value === '') return 1;
      const number = Number(value);
      return Number.isFinite(number)
        ? Math.round(Math.max(0, Math.min(3, number)) * 10000) / 10000
        : 1;
    }

    function videos() {
      const tree = mediaTree();
      if (observer) {
        for (const root of tree.roots.slice(1)) {
          if (shadowRoots.has(root)) continue;
          shadowRoots.add(root);
          observer.observe(root, { childList: true, subtree: true });
          for (const name of mediaEvents) root.addEventListener(name, onMediaEvent, true);
        }
        for (const root of shadowRoots) {
          if (root.host.isConnected) continue;
          for (const name of mediaEvents) root.removeEventListener(name, onMediaEvent, true);
          shadowRoots.delete(root);
        }
      }
      return tree.videos;
    }

    function mainVideo() {
      if (lastActiveVideo && !lastActiveVideo.isConnected) lastActiveVideo = null;
      let winner = null;
      let best = -1;
      const all = videos();
      const visible = all.filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      for (const video of visible.length ? visible : all) {
        const rect = video.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        const playing = !video.paused && !video.ended;
        const score = (playing ? 1e9 : 0) + (video === lastActiveVideo ? 1e6 : 0) + area;
        if (score > best) { best = score; winner = video; }
      }
      return winner;
    }

    function apply(video, speed = desiredSpeed) {
      if (video && Math.abs(video.playbackRate - speed) > 0.001) video.playbackRate = speed;
    }

    function canRouteAudio(video) {
      if (video.srcObject) return true;
      const source = video.currentSrc || video.src;
      if (!source) return false;
      try {
        const url = new URL(source, document.baseURI);
        return url.protocol === 'data:' || url.origin === location.origin || Boolean(video.crossOrigin);
      } catch { return false; }
    }

    async function audioRoute(video) {
      if (audioRoutes.has(video)) return audioRoutes.get(video);
      if (pendingRoutes.has(video)) return pendingRoutes.get(video);
      const task = (async () => {
        if (!canRouteAudio(video) && !await prepareAudioSource(video)) return null;
        const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AudioContextClass) return null;
        let context;
        try {
          context = new AudioContextClass();
          let timeout;
          try {
            await Promise.race([
              context.resume(),
              new Promise((resolve) => { timeout = setTimeout(resolve, 500); })
            ]);
          } finally { clearTimeout(timeout); }
          if (context.state !== 'running') throw new Error('Audio context is suspended');
          const gain = context.createGain();
          const compressor = context.createDynamicsCompressor();
          // Limit only peaks near full scale, leaving the requested gain audible.
          compressor.threshold.value = -1;
          compressor.knee.value = 0;
          compressor.ratio.value = 20;
          compressor.attack.value = 0.003;
          compressor.release.value = 0.25;
          const output = context.createGain();
          gain.connect(compressor);
          compressor.connect(output);
          output.connect(context.destination);
          const source = context.createMediaElementSource(video);
          source.connect(gain);
          const route = { context, gain, compressor, output, mode: 'boost', mono: false };
          audioRoutes.set(video, route);
          return route;
        } catch {
          await context?.close().catch(() => {});
          return null;
        }
      })();
      pendingRoutes.set(video, task);
      try { return await task; }
      finally { pendingRoutes.delete(video); }
    }

    async function prepareAudioSource(video) {
      const source = video.currentSrc || video.src;
      if (!source || video.mediaKeys || failedSources.get(video) === source) return false;
      try {
        const url = new URL(source, document.baseURI);
        if (!['http:', 'https:'].includes(url.protocol)) return false;
        let allowed = false;
        for (const method of ['HEAD', 'GET']) {
          try {
            const response = await fetch(source, {
              method, mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(5000),
              ...(method === 'GET' ? { headers: { Range: 'bytes=0-0' } } : {})
            });
            allowed = response.ok;
            // Stop reading immediately even when a server ignores the requested range.
            await response.body?.cancel();
            if (allowed) break;
          } catch { /* Some media servers reject HEAD but accept a CORS GET. */ }
        }
        if (!allowed || !video.isConnected || (video.currentSrc || video.src) !== source) {
          failedSources.set(video, source);
          return false;
        }
      } catch {
        failedSources.set(video, source);
        return false;
      }
      const snapshot = {
        time: video.currentTime, paused: video.paused, speed: video.playbackRate,
        muted: video.muted, volume: video.volume, crossOrigin: video.getAttribute('crossorigin')
      };
      // Reloading a non-seekable stream would restart it and lose the current position.
      if (snapshot.time > 0.1 && !Array.from({ length: video.seekable.length }, (_, index) =>
        snapshot.time >= video.seekable.start(index) && snapshot.time <= video.seekable.end(index)).some(Boolean)) {
        return false;
      }
      const sourceSignature = () => JSON.stringify([video.getAttribute('src'),
        [...video.querySelectorAll('source')].map((item) => item.getAttribute('src'))]);
      const originalSignature = sourceSignature();
      const stillCurrent = () => video.isConnected && sourceSignature() === originalSignature &&
        (!video.currentSrc || video.currentSrc === source);
      const reload = (cors) => new Promise((resolve) => {
        const finish = (success) => {
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', loaded);
          video.removeEventListener('error', failed);
          resolve(success);
        };
        const loaded = () => {
          if (!stillCurrent()) { finish(false); return; }
          try {
            video.playbackRate = snapshot.speed;
            video.volume = snapshot.volume;
            video.muted = snapshot.muted;
            if (Number.isFinite(snapshot.time)) video.currentTime = snapshot.time;
            if (!snapshot.paused) video.play().catch(() => {});
            finish(true);
          } catch { finish(false); }
        };
        const failed = () => finish(false);
        const timer = setTimeout(failed, 10000);
        video.addEventListener('loadedmetadata', loaded);
        video.addEventListener('error', failed);
        try {
          if (cors == null) video.removeAttribute('crossorigin');
          else video.setAttribute('crossorigin', cors);
          video.load();
        } catch { finish(false); }
      });
      if (await reload('anonymous')) return true;
      failedSources.set(video, source);
      if (stillCurrent()) await reload(snapshot.crossOrigin);
      return false;
    }

    function routeNative(video, volume) {
      const route = audioRoutes.get(video);
      if (route) {
        route.gain.gain.cancelScheduledValues(route.context.currentTime);
        route.gain.gain.value = 1;
        if (route.mode !== 'native') {
          route.gain.disconnect();
          route.gain.connect(route.output);
          route.mode = 'native';
        }
      }
      if (Math.abs(video.volume - volume) > 0.00005) video.volume = volume;
    }

    function routeBoost(video, route, volume) {
      if (route.mode !== 'boost') {
        route.gain.disconnect();
        route.gain.connect(route.compressor);
        route.mode = 'boost';
      }
      // Initialize the player level only when entering boost. Later player adjustments
      // scale the amplified audio and must survive play, metadata and speed updates.
      if (activeBoostVideo !== video && video.volume !== 1) video.volume = 1;
      // The upper slider reaches 4x at 150%, 8x at 200%, and 32x at 300%.
      const gain = volume <= 1.5 ? 16 ** (volume - 1) : 2 ** (2 * volume - 1);
      route.gain.gain.setTargetAtTime(gain, route.context.currentTime, 0.03);
    }

    function routeMono(route, enabled) {
      if (route.mono === enabled) return;
      if (enabled && !route.monoMixer) {
        const splitter = route.context.createChannelSplitter(2);
        const merger = route.context.createChannelMerger(2);
        for (let channel = 0; channel < 2; channel++) {
          const half = route.context.createGain();
          half.gain.value = 0.5;
          splitter.connect(half, channel);
          half.connect(merger, 0, 0);
          half.connect(merger, 0, 1);
        }
        merger.connect(route.context.destination);
        route.monoMixer = splitter;
      }
      route.output.disconnect();
      route.output.connect(enabled ? route.monoMixer : route.context.destination);
      route.mono = enabled;
    }

    function indicatorControlsVisible() {
      return indicatorPlayer?.classList?.contains('html5-video-player')
        ? !indicatorPlayer.classList.contains('ytp-autohide')
        : pointerVisible;
    }

    function updateIndicator() {
      if (!indicator) return;
      indicator.textContent = `${normalize(indicatorVideo.playbackRate).toFixed(2)}×`;
      indicator.style.opacity = String(Number(changeVisible || indicatorControlsVisible()));
    }

    function positionIndicator() {
      if (!indicator || !indicatorVideo?.isConnected) return;
      const fullscreen = document.fullscreenElement;
      const parent = fullscreen?.contains(indicatorVideo) && fullscreen !== indicatorVideo ? fullscreen : document.body;
      if (parent && indicator.parentElement !== parent) parent.append(indicator);
      const rect = indicatorVideo.getBoundingClientRect();
      indicator.style.left = `${Math.max(0, Math.min(rect.left + 12, window.innerWidth - 64))}px`;
      indicator.style.top = `${Math.max(0, rect.top + 12)}px`;
      indicator.style.display = rect.width >= 80 && rect.height >= 50 ? 'block' : 'none';
    }

    function onPointerActivity() {
      pointerVisible = true;
      clearTimeout(pointerTimer);
      pointerTimer = setTimeout(() => { pointerVisible = false; updateIndicator(); }, 2200);
      positionIndicator();
      updateIndicator();
    }

    function onPointerLeave() {
      pointerVisible = false;
      clearTimeout(pointerTimer);
      updateIndicator();
    }

    function detachIndicator() {
      if (!indicator && !indicatorPlayer) return;
      indicatorPlayer?.removeEventListener('pointermove', onPointerActivity);
      indicatorPlayer?.removeEventListener('pointerenter', onPointerActivity);
      indicatorPlayer?.removeEventListener('pointerleave', onPointerLeave);
      controlsObserver?.disconnect();
      window.removeEventListener('scroll', positionIndicator, true);
      window.removeEventListener('resize', positionIndicator);
      document.removeEventListener('fullscreenchange', positionIndicator);
      clearTimeout(pointerTimer);
      clearTimeout(changeTimer);
      indicator?.remove();
      indicator = null;
      indicatorVideo = null;
      indicatorPlayer = null;
      controlsObserver = null;
      pointerVisible = false;
      changeVisible = false;
    }

    function bindIndicator(video) {
      if (video === indicatorVideo) return;
      detachIndicator();
      if (!video || !document.body) return;
      indicatorVideo = video;
      indicatorPlayer = video.closest?.('.html5-video-player') ?? video.parentElement ?? video;
      indicator = document.createElement('div');
      indicator.id = 'vidtune-speed-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      Object.assign(indicator.style, {
        position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
        background: 'rgba(0, 0, 0, 0.58)', color: '#fff', borderRadius: '5px',
        padding: '4px 7px', font: '12px/1.2 system-ui, sans-serif',
        fontVariantNumeric: 'tabular-nums', opacity: '0', transition: 'opacity 160ms ease'
      });
      indicatorPlayer.addEventListener('pointermove', onPointerActivity, { passive: true });
      indicatorPlayer.addEventListener('pointerenter', onPointerActivity, { passive: true });
      indicatorPlayer.addEventListener('pointerleave', onPointerLeave, { passive: true });
      if (indicatorPlayer.classList?.contains('html5-video-player')) {
        controlsObserver = new MutationObserver(updateIndicator);
        controlsObserver.observe(indicatorPlayer, { attributes: true, attributeFilter: ['class'] });
      }
      window.addEventListener('scroll', positionIndicator, true);
      window.addEventListener('resize', positionIndicator);
      document.addEventListener('fullscreenchange', positionIndicator);
      positionIndicator();
      updateIndicator();
    }

    function flashIndicator() {
      if (!indicator) return;
      changeVisible = true;
      clearTimeout(changeTimer);
      positionIndicator();
      updateIndicator();
      changeTimer = setTimeout(() => { changeVisible = false; updateIndicator(); }, 1400);
    }

    async function applyToMain() {
      if (disabled) return;
      const video = mainVideo();
      if (activeBoostVideo && activeBoostVideo !== video) {
        routeNative(activeBoostVideo, 1);
        activeBoostVideo = null;
      }
      if (activeMonoVideo && activeMonoVideo !== video) {
        const previousRoute = audioRoutes.get(activeMonoVideo);
        if (previousRoute) routeMono(previousRoute, false);
        activeMonoVideo = null;
      }
      bindIndicator(video);
      apply(video);
      if (video && (desiredVolume > 1 || desiredMono)) {
        if (video.paused && !audioRoutes.has(video)) {
          routeNative(video, desiredVolume > 1 ? 1 : desiredVolume);
          boostError = null;
          monoError = false;
          updateIndicator();
          return;
        }
        const requestedVolume = desiredVolume;
        const route = await audioRoute(video);
        if (requestedVolume !== desiredVolume || video !== mainVideo()) return applyToMain();
        if (route) {
          routeMono(route, desiredMono);
          activeMonoVideo = desiredMono ? video : null;
          if (desiredVolume > 1) {
            routeBoost(video, route, desiredVolume);
            activeBoostVideo = video;
          } else {
            routeNative(video, desiredVolume);
            activeBoostVideo = null;
          }
          boostError = null;
          monoError = false;
        } else {
          routeNative(video, 1);
          boostError = desiredVolume > 1 ? 'Boost unavailable for this video' : null;
          monoError = desiredMono;
        }
      } else if (video && (volumeManaged || audioRoutes.has(video))) {
        routeNative(video, desiredVolume);
        const route = audioRoutes.get(video);
        if (route) routeMono(route, false);
        activeMonoVideo = null;
        if (activeBoostVideo === video) activeBoostVideo = null;
        boostError = null;
        monoError = false;
      } else if (!video) {
        boostError = null;
        monoError = false;
      }
      updateIndicator();
    }

    function onMediaEvent(event) {
      if (event.target?.localName !== 'video') return;
      if (event.type === 'ratechange') {
        if (desiredSpeed === 1 || event.target !== mainVideo() || Math.abs(event.target.playbackRate - desiredSpeed) < 0.001) return;
        const now = Date.now();
        const recent = (rateCorrections.get(event.target) ?? []).filter((time) => now - time < 1000);
        // Stop contending with players that continuously override the media property.
        if (recent.length >= 5) return;
        rateCorrections.set(event.target, [...recent, now]);
      }
      if (event.type === 'play') lastActiveVideo = event.target;
      applyToMain().catch(() => {});
    }

    function onMutations(mutations) {
      if (scanQueued) return;
      const hasVideoChange = mutations.some(({ addedNodes, removedNodes }) =>
        [...addedNodes, ...removedNodes].some((node) =>
          node.nodeType === 1 && (node.localName === 'video' || node.shadowRoot || node.querySelector?.('video') ||
            [...(node.querySelectorAll?.('*') ?? [])].some((element) => element.shadowRoot))
        )
      );
      if (!hasVideoChange) return;
      scanQueued = true;
      queueMicrotask(() => { scanQueued = false; applyToMain().catch(() => {}); });
    }

    function updateMonitoring() {
      if (!disabled && (desiredSpeed !== 1 || desiredVolume !== 1 || desiredMono || hasSiteProfile || scopedVolume) && !observer) {
        for (const name of mediaEvents) document.addEventListener(name, onMediaEvent, true);
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        videos();
      } else if ((disabled || desiredSpeed === 1 && desiredVolume === 1 && !desiredMono && !hasSiteProfile && !scopedVolume) && observer) {
        observer.disconnect();
        observer = null;
        lastActiveVideo = null;
        for (const name of mediaEvents) document.removeEventListener(name, onMediaEvent, true);
        for (const root of shadowRoots) {
          for (const name of mediaEvents) root.removeEventListener(name, onMediaEvent, true);
        }
        shadowRoots.clear();
      }
    }

    function state() {
      const video = mainVideo();
      if (disabled) detachIndicator();
      else bindIndicator(video);
      return {
        count: videos().length,
        speed: video ? normalize(video.playbackRate) : desiredSpeed,
        volume: video ? normalizeVolume(video.muted ? 0 : activeBoostVideo === video || (desiredVolume > 1 && video.paused && !boostError) ? desiredVolume : video.volume) : desiredVolume,
        boostUnavailable: Boolean(video && desiredVolume > 1 && boostError),
        mono: desiredMono,
        monoUnavailable: Boolean(video && desiredMono && monoError),
        boostPending: Boolean(video && desiredVolume > 1 && video.paused && !audioRoutes.has(video)),
        hasVideo: Boolean(video),
        playing: Boolean(video && !video.paused && !video.ended),
        disabled,
        pipAvailable: Boolean(!disabled && video?.requestPictureInPicture && document.pictureInPictureEnabled &&
          !video.disablePictureInPicture && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0),
        pipActive: Boolean(video && document.pictureInPictureElement === video),
        pipPrompt: Boolean(pipPrompt),
        pipError
      };
    }

    function showPipPrompt(video) {
      pipPrompt?.remove();
      const rect = video.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 50) return false;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'PiP';
      button.setAttribute('aria-label', 'Open Picture in Picture for this video');
      button.title = 'Click to open Picture in Picture';
      Object.assign(button.style, {
        position: 'fixed', zIndex: '2147483647',
        left: `${Math.max(0, Math.min(rect.right - 52, innerWidth - 52))}px`,
        top: `${Math.max(0, rect.top + 12)}px`,
        width: '40px', height: '30px', border: '1px solid #79e6bb', borderRadius: '6px',
        background: '#19212d', color: '#edf1f8', font: '600 12px system-ui', cursor: 'pointer'
      });
      button.addEventListener('click', () => {
        button.remove();
        pipPrompt = null;
        video.requestPictureInPicture().catch((error) => { pipError = error?.message || 'Picture in Picture could not open'; });
      }, { once: true });
      document.body.append(button);
      pipPrompt = button;
      setTimeout(() => { if (pipPrompt === button) { button.remove(); pipPrompt = null; } }, 20000);
      return true;
    }

    async function togglePip() {
      pipError = null;
      pipPrompt?.remove();
      pipPrompt = null;
      const video = mainVideo();
      try {
        if (!video || !document.pictureInPictureEnabled || !video.requestPictureInPicture || video.disablePictureInPicture) {
          throw new Error('Picture in Picture is unavailable for this video');
        }
        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (error) {
        if (error?.name === 'NotAllowedError' && video && showPipPrompt(video)) {
          pipError = null;
        } else pipError = error?.message || 'Picture in Picture could not open';
      }
      return state();
    }

    async function setSpeed(value) {
      if (disabled) return state();
      desiredSpeed = normalize(value);
      const video = mainVideo();
      if (video) rateCorrections.delete(video);
      updateMonitoring();
      await applyToMain();
      flashIndicator();
      const { settings } = await api.storage.local.get('settings');
      const siteSpeeds = settings?.siteSpeeds ?? {};
      const updated = Object.hasOwn(siteSpeeds, siteHost)
        ? { ...settings, siteSpeeds: { ...siteSpeeds, [siteHost]: desiredSpeed } }
        : { ...settings, speed: desiredSpeed };
      await api.storage.local.set({ settings: updated });
      return state();
    }

    async function setVolume(value, persist) {
      if (disabled) return state();
      desiredVolume = normalizeVolume(value);
      volumeManaged = true;
      updateMonitoring();
      const video = mainVideo();
      if (video && desiredVolume > 0 && video.muted) video.muted = false;
      await applyToMain();
      if (persist) {
        if (scopedVolume) await api.runtime.sendMessage({ type: 'SAVE_SCOPED_VOLUME', volume: desiredVolume });
        else {
          const { settings } = await api.storage.local.get('settings');
          const siteVolumes = settings?.siteVolumes ?? {};
          const updated = Object.hasOwn(siteVolumes, siteHost)
            ? { ...settings, siteVolumes: { ...siteVolumes, [siteHost]: desiredVolume } }
            : { ...settings, volume: desiredVolume };
          await api.storage.local.set({ settings: updated });
        }
      }
      return state();
    }

    async function setMono(enabled) {
      desiredMono = Boolean(enabled);
      updateMonitoring();
      await applyToMain();
      const { settings } = await api.storage.local.get('settings');
      await api.storage.local.set({ settings: { ...settings, mono: desiredMono } });
      return state();
    }

    function seek(direction) {
      const video = mainVideo();
      if (!video || !Number.isFinite(video.currentTime)) return state();
      const ranges = video.seekable;
      let start = 0;
      let end = Number.isFinite(video.duration) ? video.duration : null;
      if (ranges?.length) {
        const index = [...Array(ranges.length).keys()].find((i) =>
          video.currentTime >= ranges.start(i) && video.currentTime <= ranges.end(i));
        if (index != null) { start = ranges.start(index); end = ranges.end(index); }
      }
      if (end == null || end <= start) return state();
      video.currentTime = Math.max(start, Math.min(end, video.currentTime + direction * seekSeconds));
      return state();
    }

    const ready = Promise.all([api.storage.local.get('settings'),
      api.runtime.sendMessage({ type: 'GET_VOLUME_SCOPE' }).catch(() => null)])
      .then(async ([{ settings }, scope]) => {
      siteHost = scope?.siteHost || siteHost;
      disabled = settings?.disabledSites?.includes(siteHost) === true;
      hasSiteProfile = Object.hasOwn(settings?.siteSpeeds ?? {}, siteHost) ||
        Object.hasOwn(settings?.siteVolumes ?? {}, siteHost);
      desiredSpeed = normalize(settings?.siteSpeeds?.[siteHost] ?? settings?.speed);
      scopedVolume = Boolean(scope?.active);
      desiredVolume = normalizeVolume(scopedVolume ? scope.volume : settings?.siteVolumes?.[siteHost] ?? settings?.volume);
      desiredMono = settings?.mono === true;
      volumeManaged = scopedVolume || desiredVolume !== 1;
      speedStep = Number(settings?.speedStep) || 0.1;
      seekSeconds = Number(settings?.seekSeconds) || 10;
      updateMonitoring();
      if (!disabled && (desiredSpeed !== 1 || desiredVolume !== 1 || desiredMono || hasSiteProfile || scopedVolume)) await applyToMain();
    });

    api.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const settings = changes.settings.newValue;
      const wasDisabled = disabled;
      disabled = settings?.disabledSites?.includes(siteHost) === true;
      if (disabled && !wasDisabled) {
        pipPrompt?.remove();
        pipPrompt = null;
        const video = mainVideo();
        if (video) {
          if (activeBoostVideo === video || audioRoutes.has(video)) {
            routeNative(video, 1);
            const route = audioRoutes.get(video);
            if (route) routeMono(route, false);
          }
          else if (volumeManaged) video.volume = 1;
          if (desiredSpeed !== 1) video.playbackRate = 1;
        }
        activeBoostVideo = null;
        activeMonoVideo = null;
        boostError = null;
        monoError = false;
      }
      speedStep = Number(settings?.speedStep) || 0.1;
      seekSeconds = Number(settings?.seekSeconds) || 10;
      if (desiredMono !== (settings?.mono === true)) {
        desiredMono = settings?.mono === true;
        if (!disabled) applyToMain().catch(() => {});
      }
      hasSiteProfile = Object.hasOwn(settings?.siteSpeeds ?? {}, siteHost) ||
        Object.hasOwn(settings?.siteVolumes ?? {}, siteHost);
      const nextSpeed = normalize(settings?.siteSpeeds?.[siteHost] ?? settings?.speed);
      const nextVolume = normalizeVolume(scopedVolume ? desiredVolume : settings?.siteVolumes?.[siteHost] ?? settings?.volume);
      const oldSiteSpeed = changes.settings.oldValue?.siteSpeeds?.[siteHost];
      const siteSpeedChanged = oldSiteSpeed !== settings?.siteSpeeds?.[siteHost];
      if (!disabled && (siteSpeedChanged || wasDisabled) && nextSpeed !== desiredSpeed) {
        desiredSpeed = nextSpeed;
        applyToMain().catch(() => {});
      }
      if (!scopedVolume && nextVolume !== desiredVolume) {
        desiredVolume = nextVolume;
        volumeManaged = true;
        if (!disabled) applyToMain().catch(() => {});
      }
      updateMonitoring();
      if (disabled) detachIndicator();
      else if (wasDisabled) applyToMain().catch(() => {});
    });

    let pending = ready;
    handleMessage = (message, _sender, respond) => {
      if (!['GET_STATE', 'SET_SPEED', 'INCREASE', 'DECREASE', 'RESET', 'SET_VOLUME', 'PREVIEW_VOLUME', 'SYNC_VOLUME_SCOPE', 'SEEK_BACKWARD', 'SEEK_FORWARD', 'TOGGLE_PIP', 'SET_MONO'].includes(message?.type)) return;
      pending = pending.then(async () => {
        if (disabled) return state();
        const current = state().speed;
        switch (message.type) {
          case 'SET_SPEED': return setSpeed(message.speed);
          case 'INCREASE': return setSpeed(current + speedStep);
          case 'DECREASE': return setSpeed(current - speedStep);
          case 'RESET': return setSpeed(1);
          case 'SET_VOLUME': return setVolume(message.volume, true);
          case 'PREVIEW_VOLUME': return setVolume(message.volume, false);
          case 'SET_MONO': return setMono(message.enabled);
          case 'SYNC_VOLUME_SCOPE': {
            const scope = await api.runtime.sendMessage({ type: 'GET_VOLUME_SCOPE' });
            scopedVolume = Boolean(scope?.active);
            const { settings } = await api.storage.local.get('settings');
            return setVolume(scopedVolume ? scope.volume : settings?.siteVolumes?.[siteHost] ?? settings?.volume, false);
          }
          case 'TOGGLE_PIP': return togglePip();
          case 'SEEK_BACKWARD': return seek(-1);
          case 'SEEK_FORWARD': return seek(1);
          default: return state();
        }
      });
      pending.then(respond, (error) => respond({ error: String(error) }));
      pending = pending.catch(() => {});
      return true;
    };
  }
})();
