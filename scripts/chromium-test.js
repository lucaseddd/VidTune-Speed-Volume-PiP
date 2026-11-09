import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Builder } from 'selenium-webdriver';
import edge from 'selenium-webdriver/edge.js';
import chrome from 'selenium-webdriver/chrome.js';
import { checkPlayerVolume } from './player-volume-test.js';

process.env.SE_CACHE_PATH = resolve('work/selenium-cache');
process.env.SE_AVOID_STATS = 'true';
const wav = Buffer.alloc(44 + 480000, 128);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(480000, 40);
const media = `data:audio/wav;base64,${wav.toString('base64')}`;
const server = createServer((request, response) => {
  if (request.url.startsWith('/audio-')) {
    const allowed = request.url !== '/audio-denied';
    const range = request.url === '/audio-no-range' ? null : request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    response.writeHead(request.url === '/audio-no-head' && request.method === 'HEAD' ? 405 : range ? 206 : 200,
      { 'content-type': 'audio/wav', 'content-length': end - start + 1,
        ...(request.url === '/audio-no-range' ? {} : { 'accept-ranges': 'bytes' }),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}),
        ...(allowed ? { 'access-control-allow-origin': '*' } : {}) });
    response.end(request.method === 'HEAD' ? undefined : wav.subarray(start, end + 1));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(request.url === '/frames'
    ? `<!doctype html><iframe width="800" height="500" src="http://localhost:${server.address().port}/"></iframe>`
    : '<!doctype html><body tabindex="0"><input id="typing"><video id="video" controls width="640" height="360"></video>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let driver;
const useChrome = process.argv.includes('--chrome');
try {
  const options = (useChrome ? new chrome.Options() : new edge.Options()).addArguments('--headless=new', '--no-first-run',
    `--load-extension=${resolve('dist-chromium')}`);
  if (useChrome) options.setBrowserVersion('stable');
  driver = useChrome
    ? await new Builder().forBrowser('chrome').setChromeOptions(options).build()
    : await new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(options).build();
  console.log(`Testing ${useChrome ? 'Chrome for Testing' : 'Edge'} ${(await driver.getCapabilities()).get('browserVersion')}`);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  const controller = await readFile('src/content.js', 'utf8');
  const compressorSettings = Object.fromEntries([...controller.matchAll(/compressor\.(\w+)\.value = (-?[\d.]+);/g)]
    .map(match => [match[1], Number(match[2])]));
  const gainExpression = controller.match(/function routeBoost[\s\S]*?const gain = ([^;]+);/)[1];
  const measured = await driver.executeAsyncScript(`
    const settings=arguments[0], done=arguments[arguments.length-1];
    async function measure(volume) {
      const context=new OfflineAudioContext(1,48000,48000);
      const buffer=context.createBuffer(1,48000,48000), samples=buffer.getChannelData(0);
      for(let i=0;i<samples.length;i++) samples[i]=0.01*Math.sin(2*Math.PI*440*i/48000);
      const source=context.createBufferSource();source.buffer=buffer;
      const gain=context.createGain();gain.gain.setTargetAtTime(${gainExpression},0,0.03);
      const compressor=context.createDynamicsCompressor();
      for(const [key,value] of Object.entries(settings)) compressor[key].value=value;
      source.connect(gain);gain.connect(compressor);compressor.connect(context.destination);source.start();
      const output=(await context.startRendering()).getChannelData(0);
      let energy=0;for(let i=24000;i<output.length;i++) energy+=output[i]**2;
      return Math.sqrt(energy/24000);
    }
    Promise.all([1,2,3].map(measure)).then(done,error=>done({error:String(error)}));`, compressorSettings);
  if (!Array.isArray(measured) || Math.abs(measured[1] / measured[0] - 8) > 0.2 || Math.abs(measured[2] / measured[0] - 32) > 0.4) {
    throw new Error(`Audio gain mismatch: ${JSON.stringify(measured)}`);
  }
  console.log(`Measured audio gain: ${(measured[1] / measured[0]).toFixed(2)}x and ${(measured[2] / measured[0]).toFixed(2)}x`);
  const page = await driver.getWindowHandle();
  async function playMedia(source = media) {
    await driver.executeScript('const v=document.querySelector("video");v.src=arguments[0];v.loop=true;', source);
    await driver.wait(async () => await driver.executeScript('return document.querySelector("video").readyState >= 2'), 5000);
    await driver.findElement({ id: 'video' }).click();
    await driver.executeScript('return document.querySelector("video").play()');
  }
  await playMedia();
  const targets = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
  const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/src/background.js'));
  if (!worker) throw new Error('Chromium extension service worker did not start');
  // URL.origin is null for extension schemes in Node; retain the explicit scheme and host.
  const extensionUrl = `${new URL(worker.url).protocol}//${new URL(worker.url).host}`;
  await driver.switchTo().newWindow('tab');
  const popup = await driver.getWindowHandle();
  await driver.get(`${extensionUrl}/popup.html`);
  if (process.argv.includes('--screenshot')) await driver.manage().window().setRect({ width: 650, height: 900 });
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#video-summary").textContent === "1 video found"'), 5000);
  const initialLayout = await driver.executeScript('return {count:document.getElementById("tool-count").value,smart:document.getElementById("smart-organize").checked}');
  if (initialLayout.count !== '5' || !initialLayout.smart) throw new Error(`Unexpected default layout: ${JSON.stringify(initialLayout)}`);
  const layout = await driver.executeScript('return {width:document.body.scrollWidth,height:document.querySelector(".shell").getBoundingClientRect().bottom,refresh:!!document.querySelector("#refresh")}');
  if (layout.width !== 360 || layout.height > 600 || layout.refresh) throw new Error(`Popup layout overflow: ${JSON.stringify(layout)}`);
  if (process.argv.includes('--screenshot')) {
    await writeFile('work/popup-preview-chrome.png', Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
  }
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="10";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === 10'), 5000);
  const tenLayout = await driver.executeScript('return {height:document.querySelector(".shell").getBoundingClientRect().bottom,width:document.body.scrollWidth}');
  if (tenLayout.height > 600 || tenLayout.width !== 360) throw new Error(`Ten-module popup overflow: ${JSON.stringify(tenLayout)}`);
  if (process.argv.includes('--screenshot')) {
    await writeFile('work/popup-preview-10.png', Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
  }
  const swap = await driver.executeScript(`const select=document.querySelector('.module-row[data-index="0"] .module-select');
    select.value='pip';select.dispatchEvent(new Event('change',{bubbles:true}));return true;`);
  if (!swap) throw new Error('Module selection failed');
  await driver.wait(async () => await driver.executeScript('return document.querySelector(\'.module-row[data-index="0"]\')?.dataset.module === "pip" && document.querySelector(\'.module-row[data-index="3"]\')?.dataset.module === "speed"'), 5000);
  await driver.executeScript(`const select=document.querySelector('.module-row[data-index="0"] .module-select');
    select.value='speed';select.dispatchEvent(new Event('change',{bubbles:true}));`);
  await driver.wait(async () => await driver.executeScript('return document.querySelector(".module-row")?.dataset.module === "speed"'), 5000);
  await driver.executeScript('const toggle=document.getElementById("smart-organize");toggle.checked=true;toggle.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelector(".module-list.smart") !== null'), 5000);
  const smartHeight = await driver.executeScript('return document.querySelector(".shell").getBoundingClientRect().bottom');
  if (smartHeight > 600) throw new Error(`Smart Organize overflow: ${smartHeight}`);
  if (process.argv.includes('--screenshot')) {
    await writeFile('work/popup-preview-smart.png', Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
  }
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="5";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelector(".module-list.smart-five") !== null'), 5000);
  const grouped = await driver.executeScript('return !!document.querySelector(".audio-workspace #mono-toggle") && !!document.querySelector(".audio-workspace #tab-volume-only") && !!document.querySelector(".speed-workspace #smart-manual") && document.querySelectorAll(".speed-presets button").length >= 3');
  if (!grouped) throw new Error('Smart tools were not grouped with their related controls');
  if (process.argv.includes('--screenshot')) {
    await writeFile('work/popup-preview-smart-5.png', Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
  }
  await driver.executeScript('document.getElementById("customize-tools").click()');
  await driver.wait(async () => await driver.executeScript('return !document.getElementById("tool-choices").hidden && document.getElementById("module-list").hidden && document.querySelectorAll(".choice-select").length === 5'), 5000);
  const chooserHeight = await driver.executeScript('return document.querySelector(".shell").getBoundingClientRect().bottom');
  if (chooserHeight > 600) throw new Error(`Five-tool chooser overflow: ${chooserHeight}`);
  await driver.executeScript('document.getElementById("customize-tools").click()');
  await driver.wait(async () => await driver.executeScript('return document.getElementById("tool-choices").hidden && !document.getElementById("module-list").hidden'), 5000);
  for (const count of [2, 5, 10]) {
    await driver.executeScript('const select=document.getElementById("tool-count");select.value=String(arguments[0]);select.dispatchEvent(new Event("change",{bubbles:true}))', count);
    await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === arguments[0] && !!document.querySelector(".speed-workspace")', count), 5000);
    const size = await driver.executeScript('return {height:document.querySelector(".shell").getBoundingClientRect().height,width:document.body.scrollWidth}');
    if (size.height > 600 || size.width !== 360) throw new Error(`Smart ${count} overflow: ${JSON.stringify(size)}`);
    await driver.findElement({ id: 'volume-slider' }).sendKeys('d');
    await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.1×', 5000);
    await driver.findElement({ id: 'tool-count' }).sendKeys('a');
    await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1×', 5000);
    await driver.findElement({ css: '.speed-presets button[data-speed="1.5"]' }).click();
    await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.5×', 5000);
    await driver.findElement({ id: 'increase' }).sendKeys('q');
    await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1×', 5000);
    if (count === 5) {
      await driver.executeScript('document.getElementById("smart-manual").value="1.7"');
      await driver.findElement({ css: '[data-action="SMART_SPEED"]' }).click();
      await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.7×', 5000);
      await driver.findElement({ css: '.speed-details [data-action="RESET"]' }).click();
      await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1×', 5000);
      await driver.findElement({ css: '.module-list [data-volume="2"]' }).click();
      await driver.wait(async () => (await driver.findElement({ id: 'volume-value' }).getText()) === '200%', 5000);
      await driver.findElement({ css: '.module-list [data-volume="1"]' }).click();
      await driver.wait(async () => (await driver.findElement({ id: 'volume-value' }).getText()) === '100%', 5000);
    }
    if (process.argv.includes('--screenshot')) await writeFile(`work/smart-${count}.png`, Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
  }
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="10";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelector(".module-list.smart-ten") !== null'), 5000);
  await driver.executeScript('document.getElementById("smart-organize").click()');
  await driver.wait(async () => await driver.executeScript('return document.querySelector(".module-list.smart") === null'), 5000);
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="5";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === 5'), 5000);
  await driver.executeScript('const select=document.getElementById("tool-count");select.value="10";select.dispatchEvent(new Event("change",{bubbles:true}))');
  await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === 10'), 5000);
  await driver.findElement({ id: 'increase' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.1×', 5000);
  await driver.findElement({ id: 'increase' }).sendKeys('d');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.2×', 5000);
  await driver.findElement({ id: 'increase' }).sendKeys('a');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1.1×', 5000);
  await driver.findElement({ id: 'increase' }).sendKeys('q');
  await driver.wait(async () => (await driver.findElement({ id: 'speed-value' }).getText()) === '1×', 5000);
  if (await driver.executeScript('const input=document.querySelector("#manual-value");input.stepUp();return input.value') !== '1.1') {
    throw new Error('Popup spinner did not advance by 0.1');
  }
  async function control(message, tabId = null) {
    const result = await driver.executeAsyncScript(`const done=arguments[arguments.length-1], message=arguments[0], tabId=arguments[1];
      (async()=>{const {sendToVideo,activeTab}=await import(chrome.runtime.getURL('src/browser.js'));
      const tab=tabId ? {id:tabId} : await activeTab();return sendToVideo(tab.id,message);})()
      .then(done,error=>done({error:String(error)}));`, message, tabId);
    if (result.error) throw new Error(result.error);
    return result;
  }
  if ((await control({ type: 'SET_SPEED', speed: 1.5 })).speed !== 1.5) throw new Error('Chromium speed failed');
  if ((await control({ type: 'SET_VOLUME', volume: 0.25 })).volume !== 0.25) throw new Error('Chromium native volume failed');
  const boost = await control({ type: 'SET_VOLUME', volume: 3 });
  if (boost.volume !== 3 || boost.boostUnavailable) throw new Error('Chromium boost failed');
  await checkPlayerVolume(driver, control, page, popup, '#video');
  await driver.navigate().refresh();
  await driver.wait(async () => (await driver.findElement({ id: 'volume-value' }).getText()) === '300%', 5000);
  await driver.executeScript('document.getElementById("tab-volume-only").click()');
  await driver.wait(async () => {
    const scoped = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      chrome.storage.session.get('volumeScopes').then(done);`);
    return Object.values(scoped.volumeScopes ?? {})[0] === 3;
  }, 5000, 'Chromium tab-only toggle failed');
  await driver.switchTo().window(page);
  await driver.executeScript(`const video=document.querySelector('video');const host=document.createElement('div');
    document.body.append(host);host.attachShadow({mode:'open'}).append(video);window.testVideo=video;`);
  await driver.findElement({ css: 'body' }).sendKeys('d');
  await driver.wait(async () => await driver.executeScript('return window.testVideo.playbackRate === 1.6'), 5000);
  await driver.switchTo().window(popup);
  const nested = await control({ type: 'GET_STATE' });
  if (nested.count !== 1 || nested.speed !== 1.6 || nested.volume !== 3) throw new Error('Chromium shadow player failed');
  const firstId = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    import(chrome.runtime.getURL('src/browser.js')).then(m=>m.activeTab()).then(tab=>done(tab.id));`);
  await driver.switchTo().window(page);
  await driver.findElement({ id: 'typing' }).sendKeys('adq');
  if (await driver.executeScript('return window.testVideo.playbackRate') !== 1.6) throw new Error('Shortcut interfered with typing');
  await driver.executeScript('window.testVideo.playbackRate=1');
  await driver.wait(async () => await driver.executeScript('return window.testVideo.playbackRate === 1.6'), 5000);
  await driver.executeScript(`const old=window.testVideo;const next=old.cloneNode(true);old.replaceWith(next);
    window.testVideo=next;return next.play();`);
  await driver.wait(async () => await driver.executeScript('return window.testVideo.playbackRate === 1.6'), 5000);
  await driver.switchTo().window(popup);
  await driver.wait(async () => (await control({ type: 'GET_STATE' }, firstId)).volume === 3, 5000);

  await driver.switchTo().newWindow('tab');
  const secondPage = await driver.getWindowHandle();
  await driver.get(`http://127.0.0.1:${server.address().port}/second`);
  await playMedia();
  await driver.switchTo().window(popup);
  const secondId = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    import(chrome.runtime.getURL('src/browser.js')).then(m=>m.activeTab()).then(tab=>done(tab.id));`);
  if (secondId === firstId) throw new Error('Popup did not follow the most recently selected tab');
  const scope = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    chrome.runtime.sendMessage({type:'SET_VOLUME_SCOPE',tabId:arguments[0],enabled:true,volume:0.25}).then(done);`, secondId);
  if (scope.error) throw new Error(scope.error);
  await control({ type: 'SYNC_VOLUME_SCOPE' }, secondId);
  if ((await control({ type: 'GET_STATE' }, firstId)).volume !== 3 || (await control({ type: 'GET_STATE' }, secondId)).volume !== 0.25) {
    throw new Error('Per-tab volumes interfered');
  }
  await driver.switchTo().window(secondPage);
  await driver.navigate().refresh();
  await driver.switchTo().window(popup);
  if ((await control({ type: 'GET_STATE' }, secondId)).volume !== 0.25) throw new Error('Scoped volume did not survive reload');
  await driver.switchTo().window(secondPage);
  await driver.close();
  await driver.switchTo().window(popup);
  await driver.wait(async () => await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    chrome.runtime.sendMessage({type:'GET_VOLUME_SCOPE',tabId:arguments[0]}).then(s=>done(!s.active));`, secondId), 5000);
  await control({ type: 'SET_VOLUME', volume: 1 }, firstId);

  for (const scenario of ['cors', 'no-head', 'no-range', 'denied']) {
    await driver.switchTo().window(page);
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    await playMedia(`http://localhost:${server.address().port}/audio-${scenario}`);
    await driver.executeScript('document.querySelector("video").currentTime=2');
    await driver.wait(async () => await driver.executeScript('const v=document.querySelector("video");return !v.seeking && v.currentTime >= 1.9'),
      5000, `Test media did not seek before boost: ${scenario}`);
    await driver.switchTo().window(popup);
    const result = await control({ type: 'SET_VOLUME', volume: 3 }, firstId);
    const supported = !['denied', 'no-range'].includes(scenario);
    if (result.boostUnavailable !== !supported || result.volume !== (supported ? 3 : 1)) {
      throw new Error(`Cross-origin audio failed: ${scenario} ${JSON.stringify(result)}`);
    }
    await driver.switchTo().window(page);
    const state = await driver.executeScript('const v=document.querySelector("video");return {time:v.currentTime,paused:v.paused,error:v.error?.code,seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)]),buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])}');
    if (state.paused || state.error || state.time < 1.9) throw new Error(`Playback lost during audio recovery: ${scenario} ${JSON.stringify(state)}`);
    await driver.switchTo().window(popup);
    await control({ type: 'SET_VOLUME', volume: 1 }, firstId);
  }
  await driver.switchTo().window(page);
  await driver.get(`http://127.0.0.1:${server.address().port}/frames`);
  await driver.switchTo().frame(await driver.findElement({ css: 'iframe' }));
  await playMedia();
  await driver.switchTo().defaultContent();
  await driver.switchTo().window(popup);
  const framedSpeed = await control({ type: 'SET_SPEED', speed: 1.8 }, firstId);
  const framedBoost = await control({ type: 'SET_VOLUME', volume: 3 }, firstId);
  if (framedSpeed.speed !== 1.8 || framedBoost.volume !== 3 || framedBoost.boostUnavailable) throw new Error('Embedded cross-origin player failed');
  await driver.switchTo().window(page);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  await driver.executeScript(`const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    canvas.getContext('2d').fillRect(0,0,320,180);
    const video=document.querySelector('video');video.srcObject=canvas.captureStream(15);
    video.muted=true;return video.play();`);
  await driver.wait(async () => await driver.executeScript('const v=document.querySelector("video");return v.videoWidth > 0 && v.readyState >= 2'), 5000);
  await driver.switchTo().window(popup);
  await driver.navigate().refresh();
  await driver.wait(async () => await driver.findElement({ id: 'toggle-pip' }).isEnabled(), 5000);
  await driver.findElement({ id: 'toggle-pip' }).click();
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#toggle-pip")?.getAttribute("aria-pressed") === "true"'),
    5000, 'Popup Picture in Picture did not open');
  await driver.findElement({ id: 'toggle-pip' }).click();
  await driver.wait(async () => await driver.executeScript('return document.querySelector("#toggle-pip")?.getAttribute("aria-pressed") === "false"'),
    5000, 'Popup Picture in Picture did not close');
  const keySaved = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
    chrome.storage.local.get('settings').then(({settings}) => {
    settings.shortcuts={...(settings.shortcuts??{}),pip:'KeyP'};return chrome.storage.local.set({settings});
  }).then(()=>done(true),error=>done({error:String(error)}));`);
  if (keySaved !== true) throw new Error(`Could not set PiP shortcut: ${JSON.stringify(keySaved)}`);
  await driver.switchTo().window(page);
  await driver.findElement({ css: 'body' }).sendKeys('p');
  await driver.switchTo().window(popup);
  await driver.wait(async () => (await control({ type: 'GET_STATE' }, firstId)).pipActive, 5000,
    'Picture in Picture shortcut did not open');
  await driver.switchTo().window(page);
  await driver.findElement({ css: 'body' }).sendKeys('p');
  await driver.switchTo().window(popup);
  await driver.wait(async () => !(await control({ type: 'GET_STATE' }, firstId)).pipActive, 5000,
    'Picture in Picture shortcut did not close');
  await driver.executeAsyncScript(`chrome.runtime.sendMessage({type:'SET_VOLUME_SCOPE',tabId:arguments[0],enabled:false})
    .then(arguments[arguments.length-1]);`, firstId);
  await control({ type: 'SYNC_VOLUME_SCOPE' }, firstId);

  await driver.switchTo().newWindow('tab');
  const optionsPage = await driver.getWindowHandle();
  await driver.get(`${extensionUrl}/options.html`);
  await driver.wait(async () => (await driver.findElement({ id: 'site-name' }).getText()) === '127.0.0.1', 5000);
  await driver.executeScript(`document.querySelector('#site-enabled').checked=true;
    document.querySelector('#site-speed').value='1.25';
    document.querySelector('#site-volume-enabled').checked=true;
    document.querySelector('#site-volume').value='75';`);
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.', 5000);
  await driver.switchTo().window(page);
  await driver.navigate().refresh();
  await playMedia();
  await driver.switchTo().window(popup);
  const profiled = await control({ type: 'GET_STATE' }, firstId);
  if (profiled.speed !== 1.25 || profiled.volume !== 0.75) throw new Error(`Site profile did not apply: ${JSON.stringify(profiled)}`);
  await driver.switchTo().window(page);
  await driver.get(`http://127.0.0.1:${server.address().port}/frames`);
  await driver.switchTo().frame(await driver.findElement({ css: 'iframe' }));
  await playMedia();
  await driver.switchTo().defaultContent();
  await driver.switchTo().window(popup);
  const framedProfile = await control({ type: 'GET_STATE' }, firstId);
  if (framedProfile.speed !== 1.25 || framedProfile.volume !== 0.75) {
    throw new Error(`Site profile did not reach the embedded player: ${JSON.stringify(framedProfile)}`);
  }
  await driver.switchTo().window(page);
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  await playMedia();
  await driver.findElement({ css: 'body' }).sendKeys('d');
  await driver.wait(async () => await driver.executeScript('return document.querySelector("video").playbackRate === 1.35'), 5000);
  await driver.switchTo().window(popup);
  const savedProfile = await driver.executeAsyncScript('chrome.storage.local.get("settings").then(arguments[arguments.length-1])');
  if (savedProfile.settings.siteSpeeds['127.0.0.1'] !== 1.35 || savedProfile.settings.siteVolumes['127.0.0.1'] !== 0.75) {
    throw new Error('Site profile changes were not persisted');
  }
  await driver.executeAsyncScript(`chrome.storage.local.get('settings').then(({settings}) => {
    settings.siteSpeeds['localhost']=1.5;settings.siteVolumes['localhost']=1.25;
    return chrome.storage.local.set({settings});}).then(arguments[arguments.length-1]);`);
  await driver.switchTo().window(optionsPage);
  await driver.navigate().refresh();
  await driver.wait(async () => (await driver.findElement({ css: '.profile-row strong' }).getText()) === 'localhost', 5000);
  await driver.findElement({ css: '.profile-row .profile-speed' }).clear();
  await driver.findElement({ css: '.profile-row .profile-speed' }).sendKeys('1.75');
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.', 5000);
  const editedProfile = await driver.executeAsyncScript('chrome.storage.local.get("settings").then(arguments[arguments.length-1])');
  if (editedProfile.settings.siteSpeeds.localhost !== 1.75) throw new Error('Saved site could not be edited');
  await driver.findElement({ css: '.profile-row button' }).click();
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  const removedProfile = await driver.executeAsyncScript('chrome.storage.local.get("settings").then(arguments[arguments.length-1])');
  if (removedProfile.settings.siteSpeeds.localhost || removedProfile.settings.siteVolumes.localhost) {
    throw new Error('Saved site could not be removed');
  }
  await driver.findElement({ id: 'site-disabled' }).click();
  await driver.findElement({ css: '#settings-form button[type="submit"]' }).click();
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.', 5000);
  await driver.switchTo().window(popup);
  await driver.navigate().refresh();
  await driver.wait(async () => (await driver.findElement({ id: 'status' }).getText()) === 'Disabled on this site', 5000);
  if (await driver.findElement({ id: 'increase' }).isEnabled() || await driver.findElement({ id: 'toggle-pip' }).isEnabled()) {
    throw new Error('Disabled site kept active controls');
  }
  await driver.switchTo().window(page);
  const disabledVideo = await driver.executeScript('const v=document.querySelector("video");return {speed:v.playbackRate,volume:v.volume}');
  if (disabledVideo.speed !== 1 || disabledVideo.volume !== 1) throw new Error(`Disabling site kept video effects: ${JSON.stringify(disabledVideo)}`);
  console.log(`${useChrome ? 'Chrome' : 'Edge'} passed: playback, speed recovery, native volume, boost, independent tabs/reload/cleanup, shadow replacement, shortcuts, CORS recovery and cross-origin iframe.`);
} catch (error) {
  if (driver) console.error('Current test page:', await driver.executeScript('return document.body.innerText').catch(() => 'unavailable'));
  throw error;
} finally {
  if (driver) await driver.quit();
  await new Promise(done => server.close(done));
}
