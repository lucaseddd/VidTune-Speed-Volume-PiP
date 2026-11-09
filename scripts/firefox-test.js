import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { installTestAddons } from './firefox-addons.js';
import { checkPlayerVolume } from './player-volume-test.js';

process.env.SE_CACHE_PATH = resolve('work/selenium-cache');
process.env.SE_AVOID_STATS = 'true';
await mkdir(process.env.SE_CACHE_PATH, { recursive: true });

const html = '<!doctype html><title>VidTune Firefox test</title><body tabindex="0"><input id="typing"><video id="main" width="640" height="360" controls></video>';
const wav = Buffer.alloc(44 + 48000, 128);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write('data', 36);
wav.writeUInt32LE(48000, 40);
const wavUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
const server = createServer((request, response) => {
  if (request.url.startsWith('/audio')) {
    const allowed = ['/audio-cors', '/audio-head-rejected'].includes(request.url) || (request.url === '/audio-rollback' && request.method === 'HEAD');
    response.writeHead(request.url === '/audio-head-rejected' && request.method === 'HEAD' ? 405 : 200, { 'content-type': 'audio/wav', 'content-length': wav.length,
      ...(allowed ? { 'access-control-allow-origin': '*' } : {}) });
    response.end(request.method === 'HEAD' ? undefined : wav);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(request.url === '/frames'
    ? `<!doctype html><title>Embedded player test</title><iframe width="800" height="500" src="http://localhost:${server.address().port}/"></iframe>`
    : html);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

let driver;
try {
  const options = new firefox.Options().setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe').addArguments('-headless');
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
  await installTestAddons(driver);
  await driver.setContext(firefox.Context.CHROME);
  const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['vidtune@vidtune.local'];");
  await driver.setContext(firefox.Context.CONTENT);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  console.log('Firefox Picture in Picture API:', await driver.executeScript('return {enabled:document.pictureInPictureEnabled,request:typeof document.querySelector("video").requestPictureInPicture}'));
  const controller = await readFile('src/content.js', 'utf8');
  const compressorSettings = Object.fromEntries([...controller.matchAll(/compressor\.(\w+)\.value = (-?[\d.]+);/g)]
    .map((match) => [match[1], Number(match[2])]));
  const gainExpression = controller.match(/function routeBoost[\s\S]*?const gain = ([^;]+);/)[1];
  const measured = await driver.executeAsyncScript(`
    const settings = arguments[0], done = arguments[arguments.length - 1];
    async function measure(volume) {
      const context = new OfflineAudioContext(1, 48000, 48000);
      const buffer = context.createBuffer(1, 48000, 48000);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = 0.01 * Math.sin(2 * Math.PI * 440 * i / 48000);
      const source = context.createBufferSource(); source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.setTargetAtTime(${gainExpression}, context.currentTime, 0.03);
      const compressor = context.createDynamicsCompressor();
      for (const [key, value] of Object.entries(settings)) compressor[key].value = value;
      source.connect(gain); gain.connect(compressor); compressor.connect(context.destination);
      source.start();
      const output = (await context.startRendering()).getChannelData(0);
      let energy = 0;
      for (let i = 24000; i < output.length; i++) energy += output[i] ** 2;
      return Math.sqrt(energy / 24000);
    }
    Promise.all([1, 2, 3].map(measure)).then(done, error => done({error: String(error)}));
  `, compressorSettings);
  if (!Array.isArray(measured) || Math.abs(measured[1] / measured[0] - 8) > 0.2 || Math.abs(measured[2] / measured[0] - 32) > 0.4) {
    throw new Error(`Compressor suppressed the requested audio gain: ${JSON.stringify(measured)}`);
  }
  console.log(`Measured audio gain: ${(measured[1] / measured[0]).toFixed(2)}x and ${(measured[2] / measured[0]).toFixed(2)}x`);
  const pageHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow('tab');
  const extensionHandle = await driver.getWindowHandle();
  await driver.get(`moz-extension://${uuid}/popup.html`);
  await driver.wait(async () => await driver.executeScript('return !!document.querySelector("#speed-value")'), 5000);
  if (!(await driver.findElement({ id: 'speed-value' }).isDisplayed())) throw new Error('Popup speed control did not render');
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#video-summary").textContent === "1 video found"'),
    5000, 'Extension tab did not locate the video tab');
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="10";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === 10'), 5000);
  await driver.executeScript('const toggle=document.getElementById("smart-organize");if(!toggle.checked)toggle.click()');
  await driver.wait(async () => await driver.executeScript('return !!document.querySelector(".speed-workspace")'), 5000);
  await driver.findElement({ id: 'volume-slider' }).sendKeys('d');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.1×', 5000);
  await driver.findElement({ id: 'tool-count' }).sendKeys('a');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1×', 5000);
  await driver.executeScript('document.getElementById("smart-organize").click()');
  await driver.wait(async () => await driver.executeScript('return !document.querySelector(".speed-workspace")'), 5000);
  if (await driver.findElement({ id: 'volume-slider' }).getAttribute('value') !== '100') {
    throw new Error('100% volume did not start at the slider midpoint');
  }
  const spinnerStep = await driver.executeScript("const input = document.getElementById('manual-value'); input.stepUp(); return input.value;");
  if (spinnerStep !== '1.1') throw new Error(`Manual spinner used the wrong step: ${spinnerStep}`);

  async function setPopupVolume(position, expected) {
    await driver.executeScript(`
      const slider = document.getElementById('volume-slider');
      slider.value = arguments[0];
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    `, position);
    await driver.wait(async () => (await driver.findElement({ id: 'volume-value' }).getText()) === expected,
      5000, `Popup volume did not show ${expected}`);
  }

  async function control(message) {
    const result = await driver.executeAsyncScript(`
      const message = arguments[0];
      const done = arguments[arguments.length - 1];
      browser.tabs.query({}).then((tabs) => {
        const tab = tabs.find((candidate) => candidate.url?.startsWith('http://127.0.0.1:'));
        if (!tab) throw new Error('Video test tab was not found');
        return import(browser.runtime.getURL('src/browser.js')).then(({ sendToVideo }) => sendToVideo(tab.id, message));
      }).then(done, (error) => done({ error: String(error) }));
    `, message);
    if (result?.error) throw new Error(result.error);
    return result;
  }

  const monoOn = await control({ type: 'SET_MONO', enabled: true });
  if (!monoOn.mono || monoOn.monoUnavailable) throw new Error('Mono audio did not activate');
  const monoOff = await control({ type: 'SET_MONO', enabled: false });
  if (monoOff.mono) throw new Error('Mono audio did not turn off');

  async function waitForRate(id, speed) {
    await driver.wait(async () =>
      Math.abs(await driver.executeScript(`return document.getElementById('${id}')?.playbackRate ?? 0`) - speed) < 0.001,
    10000, `${id} did not reach ${speed}×`);
  }

  async function waitForVolume(id, volume) {
    await driver.wait(async () =>
      Math.abs(await driver.executeScript(`return document.getElementById('${id}')?.volume ?? -1`) - volume) < 0.00005,
    10000, `${id} did not reach ${volume} volume`);
  }

  await driver.switchTo().window(pageHandle);
  await driver.executeScript("const video = document.getElementById('main'); video.src = arguments[0]; video.loop = true", wavUrl);
  await driver.wait(async () => await driver.executeScript("return document.getElementById('main').readyState >= 1"),
    5000, 'Local media did not load for boost testing');
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript("const video = document.getElementById('main'); video.muted = true; return video.play()");
  await driver.wait(async () => await driver.executeScript("return !document.getElementById('main').paused"),
    5000, 'Local media did not start for boost testing');
  await driver.executeScript("document.getElementById('main').muted = false");
  await driver.switchTo().window(extensionHandle);

  await setPopupVolume(1, '0.01%');
  await driver.switchTo().window(pageHandle);
  await waitForVolume('main', 0.0001);
  await driver.switchTo().window(extensionHandle);
  await setPopupVolume(50, '25%');
  await driver.switchTo().window(pageHandle);
  await waitForVolume('main', 0.25);
  await driver.switchTo().window(extensionHandle);
  await setPopupVolume(150, '200%');
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).volume === 2,
    5000, 'Firefox did not activate 200% audio boost');
  await setPopupVolume(200, '300%');
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).volume === 3,
    5000, 'Firefox did not activate 300% audio boost');
  await checkPlayerVolume(driver, control, pageHandle, extensionHandle, '#main');
  await setPopupVolume(100, '100%');
  await driver.switchTo().window(pageHandle);
  await waitForVolume('main', 1);
  await driver.switchTo().window(extensionHandle);
  await setPopupVolume(50, '25%');

  const changed = await control({ type: 'SET_SPEED', speed: 1.5 });
  if (changed.speed !== 1.5 || changed.count !== 1) throw new Error('Firefox did not apply speed to the main video');
  await driver.switchTo().window(pageHandle);
  await waitForRate('main', 1.5);
  await driver.switchTo().window(extensionHandle);
  await control({ type: 'SET_SPEED', speed: 0.1 });
  await driver.switchTo().window(pageHandle);
  await waitForRate('main', 0.1);
  await driver.switchTo().window(extensionHandle);
  await control({ type: 'SET_SPEED', speed: 16 });
  await driver.switchTo().window(pageHandle);
  await waitForRate('main', 16);
  await driver.switchTo().window(extensionHandle);
  await control({ type: 'SET_SPEED', speed: 1.5 });
  await driver.switchTo().window(pageHandle);
  await driver.executeScript("document.getElementById('main').remove(); const video = document.createElement('video'); video.id = 'replacement'; video.width = 640; video.height = 360; document.body.append(video);");
  await waitForRate('replacement', 1.5);
  await waitForVolume('replacement', 0.25);
  await driver.switchTo().window(extensionHandle);
  const reset = await control({ type: 'RESET' });
  if (reset.speed !== 1) throw new Error('Firefox did not reset speed');
  const stored = await driver.executeAsyncScript("browser.storage.local.get('settings').then(arguments[arguments.length - 1]);");
  if (stored.settings.speed !== 1) throw new Error('Firefox did not persist the reset speed');
  await driver.switchTo().window(pageHandle);
  await waitForRate('replacement', 1);
  await driver.findElement({ id: 'typing' }).sendKeys('d');
  if (await driver.executeScript("return document.getElementById('replacement').playbackRate") !== 1) {
    throw new Error('Speed shortcut interfered with text entry');
  }
  await driver.executeScript('document.body.focus()');
  await driver.findElement({ css: 'body' }).sendKeys('d');
  await waitForRate('replacement', 1.1);
  await driver.findElement({ css: 'body' }).sendKeys('ddd');
  await waitForRate('replacement', 1.4);
  await driver.findElement({ css: 'body' }).sendKeys('a');
  await waitForRate('replacement', 1.3);
  await driver.findElement({ css: 'body' }).sendKeys('q');
  await waitForRate('replacement', 1);
  await driver.switchTo().window(extensionHandle);
  await driver.findElement({ css: 'body' }).sendKeys('d');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.1×',
    5000, 'Popup keyboard shortcut did not update its speed display');
  await driver.switchTo().window(pageHandle);
  await waitForRate('replacement', 1.1);
  const indicator = await driver.findElement({ id: 'vidtune-speed-indicator' });
  if (await indicator.getText() !== '1.10×') throw new Error('Video speed indicator showed the wrong value');
  if (await indicator.getCssValue('pointer-events') !== 'none') throw new Error('Video speed indicator blocked player input');
  await driver.wait(async () => (await driver.executeScript("return getComputedStyle(document.getElementById('vidtune-speed-indicator')).opacity")) === '0',
    5000, 'Video speed indicator did not fade after the speed change');
  await driver.actions().move({ origin: await driver.findElement({ id: 'replacement' }) }).perform();
  await driver.wait(async () => (await indicator.getCssValue('opacity')) === '1',
    5000, 'Video speed indicator did not follow player pointer activity');
  await driver.wait(async () => (await indicator.getCssValue('opacity')) === '0',
    5000, 'Video speed indicator did not hide when player activity stopped');

  await driver.switchTo().window(extensionHandle);
  await driver.findElement({ id: 'open-settings' }).click();
  await driver.wait(async () => (await driver.getAllWindowHandles()).length === 3, 5000, 'Settings tab did not open');
  const optionsHandle = (await driver.getAllWindowHandles()).find((handle) => ![pageHandle, extensionHandle].includes(handle));
  await driver.switchTo().window(optionsHandle);
  await driver.wait(async () => (await driver.findElement({ id: 'site-name' }).getText()) === '127.0.0.1',
    5000, 'Settings page did not identify the video site');
  await driver.executeScript("document.getElementById('key-increase').value = 'KeyA'");
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()).includes('different letter'),
    5000, 'Duplicate shortcut was not rejected');
  await driver.executeScript(`
    document.getElementById('speed-step').value = '0.2';
    document.getElementById('presets').value = '0.5, 1, 1.25';
    document.getElementById('seek-enabled').checked = true;
    document.getElementById('seek-seconds').value = '2';
    document.getElementById('key-decrease').value = 'KeyC';
    document.getElementById('key-increase').value = 'KeyV';
    document.getElementById('key-seek-backward').value = 'KeyZ';
    document.getElementById('key-seek-forward').value = 'KeyX';
    document.getElementById('site-enabled').checked = true;
    document.getElementById('site-speed').value = '1.5';
  `);
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.',
    5000, 'Advanced settings were not saved');
  await driver.switchTo().window(pageHandle);
  await waitForRate('replacement', 1.5);
  await driver.executeScript(`
    const video = document.getElementById('replacement');
    video.src = arguments[0];
    document.body.focus();
  `, wavUrl);
  await driver.wait(async () => await driver.executeScript("const v = document.getElementById('replacement'); return v.readyState >= 1 && v.seekable.length > 0"),
    5000, 'Local media fixture was not seekable');
  await driver.executeScript("document.getElementById('replacement').currentTime = 1");
  await driver.findElement({ css: 'body' }).sendKeys('x');
  await driver.wait(async () => Math.abs((await driver.executeScript("return document.getElementById('replacement').currentTime")) - 3) < 0.05,
    5000, 'Configured forward skip did not work');
  await driver.findElement({ css: 'body' }).sendKeys('z');
  await driver.wait(async () => Math.abs((await driver.executeScript("return document.getElementById('replacement').currentTime")) - 1) < 0.05,
    5000, 'Configured backward skip did not work');
  await driver.findElement({ css: 'body' }).sendKeys('v');
  await waitForRate('replacement', 1.7);
  await driver.navigate().refresh();
  await waitForRate('main', 1.7);
  await waitForVolume('main', 0.25);
  await driver.switchTo().window(extensionHandle);
  await setPopupVolume(200, '300%');
  await driver.switchTo().window(pageHandle);
  await driver.executeScript(`
    document.getElementById('main').remove();
    const video = document.createElement('video');
    video.id = 'boost-replacement';
    video.width = 640;
    video.height = 360;
    video.controls = true;
    video.loop = true;
    video.src = arguments[0];
    document.body.append(video);
  `, wavUrl);
  await driver.findElement({ id: 'boost-replacement' }).click();
  await driver.executeScript("const video = document.getElementById('boost-replacement'); video.muted = true; return video.play()");
  await driver.executeScript("document.getElementById('boost-replacement').muted = false");
  await driver.switchTo().window(extensionHandle);
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).volume === 3,
    5000, 'Boost did not follow a dynamically replaced video');
  await driver.switchTo().window(pageHandle);
  await driver.navigate().refresh();
  await driver.executeScript("const video = document.getElementById('main'); video.src = arguments[0]; video.loop = true", wavUrl);
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript("const video = document.getElementById('main'); video.muted = true; return video.play()");
  await driver.executeScript("document.getElementById('main').muted = false");
  await driver.switchTo().window(extensionHandle);
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).volume === 3,
    5000, 'Saved boost did not apply after reload');
  await driver.switchTo().window(pageHandle);
  await driver.get(`http://127.0.0.1:${server.address().port}/frames`);
  await driver.switchTo().frame(await driver.findElement({ css: 'iframe' }));
  await driver.wait(async () => await driver.executeScript("return !!document.getElementById('main')"), 5000);
  await driver.switchTo().defaultContent();
  await driver.switchTo().window(extensionHandle);
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).count === 1,
    5000, 'Cross-origin frame video was not detected');
  const framed = await control({ type: 'SET_SPEED', speed: 1.8 });
  if (framed.speed !== 1.8) throw new Error('Speed did not reach the embedded video');
  await control({ type: 'SET_VOLUME', volume: 0.25 });
  await driver.switchTo().window(pageHandle);
  await driver.switchTo().frame(await driver.findElement({ css: 'iframe' }));
  await waitForRate('main', 1.8);
  await waitForVolume('main', 0.25);
  await driver.findElement({ css: 'body' }).sendKeys('v');
  await waitForRate('main', 2);
  await driver.executeScript("const video = document.getElementById('main'); video.src = arguments[0]; video.loop = true", wavUrl);
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript("const video = document.getElementById('main'); video.muted = true; return video.play()");
  await driver.executeScript("document.getElementById('main').muted = false");
  await driver.switchTo().defaultContent();
  await driver.switchTo().window(extensionHandle);
  const boostedFrame = await control({ type: 'SET_VOLUME', volume: 3 });
  if (boostedFrame.volume !== 3 || boostedFrame.boostUnavailable) throw new Error('Embedded audio boost did not activate');
  await control({ type: 'SET_VOLUME', volume: 1 });
  for (const scenario of ['cors', 'head-rejected', 'denied', 'rollback']) {
    const supported = ['cors', 'head-rejected'].includes(scenario);
    await driver.switchTo().window(pageHandle);
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    await driver.executeScript(`const v=document.getElementById('main');
      v.src=arguments[0]; v.loop=true; v.addEventListener('loadstart',()=>{v.dataset.loads=String(Number(v.dataset.loads||0)+1)});`,
    `http://localhost:${server.address().port}/audio-${scenario}`);
    await driver.wait(async () => await driver.executeScript("return document.getElementById('main').readyState >= 2"), 5000);
    await driver.findElement({ id: 'main' }).click();
    await driver.executeScript("const v=document.getElementById('main');v.currentTime=2;v.muted=true;return v.play()");
    await driver.executeScript("document.getElementById('main').muted=false");
    await driver.switchTo().window(extensionHandle);
    const result = await control({ type: 'SET_VOLUME', volume: 3 });
    if (result.boostUnavailable !== !supported || result.volume !== (supported ? 3 : 1)) {
      throw new Error(`Incorrect CORS recovery result: ${scenario} ${JSON.stringify(result)}`);
    }
    await driver.switchTo().window(pageHandle);
    const media = await driver.executeScript(`const v=document.getElementById('main');
      return {cors:v.crossOrigin,time:v.currentTime,paused:v.paused,error:v.error?.code,loads:Number(v.dataset.loads)};`);
    if (media.error || media.paused || media.time < 1.9 || media.cors !== (supported ? 'anonymous' : null)) {
      throw new Error(`Playback was not preserved: ${scenario} ${JSON.stringify(media)}`);
    }
    if (scenario === 'denied' && media.loads !== 1) throw new Error('Denied CORS unnecessarily reloaded media');
    await driver.switchTo().window(extensionHandle);
    await control({ type: 'SET_VOLUME', volume: 1 });
  }
  await driver.switchTo().window(pageHandle);
  await driver.get(`http://127.0.0.1:${server.address().port}/shadow`);
  await driver.executeScript(`
    document.getElementById('main').remove();
    const host = document.createElement('div'); document.body.append(host);
    const inner = document.createElement('div'); host.attachShadow({ mode: 'open' }).append(inner);
    const root = inner.attachShadow({ mode: 'open' });
    const video = document.createElement('video'); video.width = 640; video.height = 360;
    video.controls = true; video.loop = true; video.src = arguments[0]; root.append(video);
    window.testVideo = video;
  `, wavUrl);
  await driver.wait(async () => await driver.executeScript('return window.testVideo.readyState >= 2'), 5000);
  await driver.actions().click(await driver.executeScript('return window.testVideo')).perform();
  await driver.executeScript('window.testVideo.muted = true; return window.testVideo.play()');
  await driver.executeScript('window.testVideo.muted = false');
  await driver.switchTo().window(extensionHandle);
  const shadowSpeed = await control({ type: 'SET_SPEED', speed: 1.6 });
  const shadowBoost = await control({ type: 'SET_VOLUME', volume: 3 });
  if (shadowSpeed.speed !== 1.6 || shadowSpeed.count !== 1 || shadowBoost.volume !== 3 || shadowBoost.boostUnavailable) {
    throw new Error('Nested shadow player controls failed');
  }
  await driver.switchTo().window(pageHandle);
  await driver.executeScript('window.testVideo.playbackRate = 1');
  await driver.wait(async () => await driver.executeScript('return window.testVideo.playbackRate === 1.6'),
    5000, 'Player speed override was not recovered');
  await driver.findElement({ css: 'body' }).sendKeys('v');
  await driver.wait(async () => await driver.executeScript('return Math.abs(window.testVideo.playbackRate - 1.8) < 0.001'),
    5000, 'Shortcut did not detect the shadow player');
  await driver.executeScript(`const old = window.testVideo; const video = old.cloneNode(true);
    old.replaceWith(video); window.testVideo = video; video.muted = true; return video.play();`);
  await driver.wait(async () => await driver.executeScript('return Math.abs(window.testVideo.playbackRate - 1.8) < 0.001'),
    5000, 'Shadow player replacement lost its speed');
  await driver.executeScript('window.testVideo.muted = false');
  await driver.switchTo().window(extensionHandle);
  await driver.wait(async () => (await control({ type: 'GET_STATE' })).volume === 3,
    5000, 'Shadow player replacement lost its boost');
  await control({ type: 'SET_VOLUME', volume: 1 });
  await driver.switchTo().window(pageHandle);
  await driver.get(`http://127.0.0.1:${server.address().port}/scoped`);
  await driver.switchTo().newWindow('tab');
  const otherHandle = await driver.getWindowHandle();
  await driver.get(`http://127.0.0.1:${server.address().port}/other`);
  await driver.switchTo().window(extensionHandle);
  const scopeTest = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const tabs = await browser.tabs.query({});
      const selected = tabs.find(tab => tab.url?.endsWith('/scoped'));
      const other = tabs.find(tab => tab.url?.endsWith('/other'));
      const { sendToVideo } = await import(browser.runtime.getURL('src/browser.js'));
      const send = (tab, type, volume) => sendToVideo(tab.id, { type, volume });
      await send(selected, 'SET_VOLUME', 3);
      await send(other, 'GET_STATE');
      const enabled = await browser.runtime.sendMessage({ type: 'SET_VOLUME_SCOPE', tabId: selected.id, enabled: true, volume: 3 });
      await send(selected, 'SYNC_VOLUME_SCOPE');
      const selectedState = await send(selected, 'SET_VOLUME', 2);
      const otherGlobal = await send(other, 'GET_STATE');
      const globalChanged = await send(other, 'SET_VOLUME', 1.5);
      const selectedAfterGlobal = await send(selected, 'GET_STATE');
      const enabledOther = await browser.runtime.sendMessage({ type: 'SET_VOLUME_SCOPE', tabId: other.id, enabled: true, volume: 1.5 });
      await send(other, 'SYNC_VOLUME_SCOPE');
      const otherScoped = await send(other, 'SET_VOLUME', 3);
      const selectedAfterOther = await send(selected, 'GET_STATE');
      done({ selectedId: selected.id, otherId: other.id, enabled, enabledOther,
        selectedState, otherGlobal, globalChanged, selectedAfterGlobal, otherScoped, selectedAfterOther });
    })().catch(error => done({ error: String(error) }));
  `);
  if (scopeTest.error || scopeTest.enabled.error || scopeTest.enabledOther.error ||
      scopeTest.selectedState.volume !== 2 || scopeTest.otherGlobal.volume !== 3 ||
      scopeTest.globalChanged.volume !== 1.5 || scopeTest.selectedAfterGlobal.volume !== 2 ||
      scopeTest.otherScoped.volume !== 3 || scopeTest.selectedAfterOther.volume !== 2) {
    throw new Error(`Independent tab volumes failed: ${JSON.stringify(scopeTest)}`);
  }
  await driver.switchTo().window(pageHandle);
  await driver.navigate().refresh();
  await driver.switchTo().window(extensionHandle);
  const reloadScope = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { sendToVideo } = await import(browser.runtime.getURL('src/browser.js'));
      return sendToVideo(arguments[0], { type: 'GET_STATE' });
    })().then(done, error => done({ error: String(error) }));
  `, scopeTest.selectedId);
  if (reloadScope.volume !== 2) throw new Error(`Scoped boost was lost after reload: ${JSON.stringify(reloadScope)}`);
  await driver.switchTo().window(otherHandle);
  await driver.navigate().refresh();
  await driver.switchTo().window(extensionHandle);
  const independentReload = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { sendToVideo } = await import(browser.runtime.getURL('src/browser.js'));
      return sendToVideo(arguments[0], { type: 'GET_STATE' });
    })().then(done, error => done({ error: String(error) }));
  `, scopeTest.otherId);
  if (independentReload.volume !== 3) throw new Error(`Second tab lost its volume: ${JSON.stringify(independentReload)}`);
  const restored = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const result = await browser.runtime.sendMessage({ type: 'SET_VOLUME_SCOPE', tabId: arguments[0], enabled: false });
      const settings = (await browser.storage.local.get('settings')).settings;
      const other = await browser.runtime.sendMessage({ type: 'GET_VOLUME_SCOPE', tabId: arguments[1] });
      return { result, volume: settings.volume, other };
    })().then(done, error => done({ error: String(error) }));
  `, scopeTest.selectedId, scopeTest.otherId);
  if (restored.error || restored.volume !== 1.5 || !restored.other.active || restored.other.volume !== 3) {
    throw new Error(`Disabling one tab changed another: ${JSON.stringify(restored)}`);
  }
  await driver.switchTo().window(pageHandle);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  await driver.executeScript(`const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    canvas.getContext('2d').fillRect(0,0,320,180);
    const video=document.querySelector('video');video.srcObject=canvas.captureStream(15);
    video.muted=true;return video.play();`);
  await driver.wait(async () => await driver.executeScript('const v=document.querySelector("video");return v.videoWidth > 0 && v.readyState >= 2'), 5000);
  await driver.switchTo().window(extensionHandle);
  await driver.navigate().refresh();
  await driver.wait(async () => await driver.findElement({ id: 'toggle-pip' }).isEnabled(), 5000);
  await driver.findElement({ id: 'toggle-pip' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'status' }).getText()) === 'Click PiP on the video',
    5000, 'Firefox did not offer the in-video PiP control');
  await driver.switchTo().window(pageHandle);
  await driver.findElement({ css: 'button[aria-label="Open Picture in Picture for this video"]' }).click();
  await driver.switchTo().window(extensionHandle);
  await driver.navigate().refresh();
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#toggle-pip")?.getAttribute("aria-pressed") === "true"'),
    5000, 'Firefox Picture in Picture did not open');
  await driver.findElement({ id: 'toggle-pip' }).click();
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#toggle-pip")?.getAttribute("aria-pressed") === "false"'),
    5000, 'Firefox Picture in Picture did not close');
  await driver.switchTo().window(pageHandle);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  await driver.executeScript('document.querySelector("video").src=arguments[0]', wavUrl);
  await driver.wait(async () => await driver.executeScript('return document.querySelector("video").readyState >= 2'), 5000);
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript('return document.querySelector("video").play()');
  await waitForRate('main', 1.8);
  await driver.switchTo().window(optionsHandle);
  await driver.navigate().refresh();
  await driver.executeScript(`document.querySelector('#site-volume-enabled').checked=true;
    document.querySelector('#site-volume').value='75';
    document.querySelector('#site-disabled').checked=true;`);
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.', 5000);
  await driver.switchTo().window(extensionHandle);
  await driver.navigate().refresh();
  await driver.wait(async () => (await driver.findElement({ id: 'status' }).getText()) === 'Disabled on this site',
    5000, 'Firefox site disable did not reach the popup');
  await driver.switchTo().window(pageHandle);
  if (await driver.executeScript('return document.querySelector("video").playbackRate') !== 1) {
    throw new Error('Firefox site disable did not restore native speed');
  }
  await driver.switchTo().window(optionsHandle);
  await driver.findElement({ id: 'site-disabled' }).click();
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  const siteAfterEnable = await driver.executeAsyncScript('browser.storage.local.get("settings").then(arguments[arguments.length-1])');
  await driver.switchTo().window(pageHandle);
  await waitForRate('main', siteAfterEnable.settings.siteSpeeds['127.0.0.1']);
  await waitForVolume('main', 0.75);
  console.log('Firefox passed: nested shadow players, dynamic replacement, speed recovery, HEAD-rejected audio, independent tab volumes and existing controls.');
} finally {
  if (driver) await driver.quit();
  await new Promise((done) => server.close(done));
}
