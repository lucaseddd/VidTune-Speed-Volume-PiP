import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { Builder } from 'selenium-webdriver';
import edge from 'selenium-webdriver/edge.js';
import firefox from 'selenium-webdriver/firefox.js';
import { installTestAddons } from './firefox-addons.js';

process.env.SE_CACHE_PATH = resolve('work/selenium-cache');
process.env.SE_AVOID_STATS = 'true';
await mkdir(process.env.SE_CACHE_PATH, { recursive: true });
const wav = Buffer.alloc(44 + 480000, 128);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36);
wav.writeUInt32LE(480000, 40);
const server = createServer((request, response) => {
  if (request.url === '/tone.wav') {
    response.writeHead(200, { 'content-type': 'audio/wav' }); response.end(wav); return;
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>VidTune regression</title><body><video id="main" controls width="400" height="240" src="/tone.wav" loop></video></body>');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const useFirefox = process.argv.includes('--firefox');
const profile = useFirefox ? null : await mkdtemp(resolve('work/regression-profile-'));
const startEdge = () => new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(new edge.Options()
  .addArguments('--headless=new', '--no-first-run', '--restore-last-session',
    `--user-data-dir=${profile}`, `--load-extension=${resolve('dist-chromium')}`)).build();
let driver;
try {
  if (useFirefox) {
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(new firefox.Options()
      .setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe').addArguments('-headless', '-no-remote'))
      .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access')).build();
    await installTestAddons(driver);
  } else {
    driver = await startEdge();
  }
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  const page = await driver.getWindowHandle();
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript('return document.querySelector("video").play()');
  let extensionUrl;
  if (useFirefox) {
    await driver.setContext(firefox.Context.CHROME);
    const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['vidtune@vidtune.local']");
    await driver.setContext(firefox.Context.CONTENT);
    extensionUrl = `moz-extension://${uuid}`;
  } else {
    const targets = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
    const worker = targets.targetInfos.find((target) => target.url.endsWith('/src/background.js'));
    assert.ok(worker, 'extension worker is available');
    const url = new URL(worker.url);
    extensionUrl = `${url.protocol}//${url.host}`;
  }
  await driver.switchTo().newWindow('tab');
  let popup = await driver.getWindowHandle();
  await driver.get(`${extensionUrl}/popup.html`);
  async function command(message, runtime = false) {
    await driver.switchTo().window(popup);
    const result = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      const api=globalThis.browser??globalThis.chrome, message=arguments[0], runtime=arguments[1];
      import(api.runtime.getURL('src/browser.js')).then(async ({activeTab,sendToVideo})=>{
        const tab=await activeTab();
        return runtime ? api.runtime.sendMessage({...message,tabId:tab.id}) : sendToVideo(tab.id,message);
      }).then(done,error=>done({error:String(error)}));`, message, runtime);
    if (result?.error) throw new Error(result.error);
    return result;
  }
  assert.equal((await command({ type: 'SET_VOLUME', volume: 2 })).boostUnavailable, false);
  for (const type of ['SEEK_FORWARD', 'SEEK_BACKWARD']) {
    await command({ type });
    await driver.switchTo().window(page);
    await driver.wait(async () => await driver.executeScript('return !document.querySelector("video").seeking'), 5000);
    const state = await command({ type: 'GET_STATE' });
    assert.equal(state.volume, 2);
    assert.equal(state.boostUnavailable, false);
  }
  console.log('PASS: real seeking preserves boost');
  await command({ type: 'SET_VOLUME_SCOPE', enabled: true, volume: 2.5, speed: 1.5 }, true);
  await command({ type: 'SYNC_VOLUME_SCOPE' });
  await driver.switchTo().window(page);
  await driver.navigate().refresh();
  await driver.findElement({ id: 'main' }).click();
  await driver.executeScript('return document.querySelector("video").play()');
  await driver.wait(async () => (await command({ type: 'GET_STATE' })).volume === 2.5, 5000);
  assert.equal((await command({ type: 'GET_STATE' })).speed, 1.5);
  console.log('PASS: marked tab preserves volume and speed across navigation');
  await driver.switchTo().window(page);
  await driver.executeScript(`const old=document.querySelector('video');
    old.style.position='absolute';old.style.top='-1000px';
    const next=document.createElement('video');next.id='next';next.width=400;next.height=240;
    next.src='/tone.wav';next.controls=true;document.body.append(next);`);
  await command({ type: 'SET_SPEED', speed: 1.75 });
  await driver.switchTo().window(page);
  assert.equal(await driver.executeScript('return document.querySelector("#next").playbackRate'), 1.75);
  await driver.findElement({ id: 'next' }).click();
  await driver.executeScript('return document.querySelector("#next").play()');
  await driver.wait(async () => {
    const state = await command({ type: 'GET_STATE' });
    return state.volume === 2.5 && !state.boostUnavailable;
  }, 5000);
  console.log('PASS: feed player selection and boost transfer');
  await driver.executeScript(`const slider=document.querySelector('#volume-slider');
    for(const value of [20,60]) {slider.value=value;slider.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await driver.wait(async () => (await command({ type: 'GET_STATE' })).volume === 0.36, 5000);
  await driver.executeScript(`const slider=document.querySelector('#volume-slider');
    slider.value=20;slider.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-volume="2"]').click();`);
  await driver.executeAsyncScript('setTimeout(arguments[arguments.length-1], 100)');
  assert.equal((await command({ type: 'GET_STATE' })).volume, 2);
  await command({ type: 'SET_VOLUME', volume: 2.5 });
  console.log('PASS: rapid slider preview uses the latest value and cannot overwrite a preset');
  await driver.get(`${extensionUrl}/options.html`);
  await driver.wait(async () => await driver.executeScript('return !!document.querySelector("#speed-step").value'), 5000);
  await driver.executeAsyncScript(`const done=arguments[arguments.length-1],api=globalThis.browser??globalThis.chrome;
    api.storage.local.get('settings').then(({settings})=>
      api.storage.local.set({settings:{...settings,volume:0.42,moduleCount:2}})).then(done);`);
  await driver.executeScript('document.querySelector("#settings-form").requestSubmit()');
  await driver.wait(async () => (await driver.findElement({ id: 'feedback' }).getText()) === 'Settings saved.', 5000);
  const saved = await driver.executeAsyncScript(`const done=arguments[arguments.length-1],api=globalThis.browser??globalThis.chrome;
    api.storage.local.get('settings').then(({settings})=>done(settings));`);
  assert.equal(saved.volume, 0.42);
  assert.equal(saved.moduleCount, 2);
  console.log('PASS: saving an older Settings page preserves newer volume and layout choices');
  await driver.get(`${extensionUrl}/popup.html`);
  // Exercise the browser-session boundary without destroying the running test harness.
  await driver.executeAsyncScript(`const done=arguments[arguments.length-1],api=globalThis.browser??globalThis.chrome;
    api.storage.session.clear().then(done);`);
  if (!useFirefox) {
    await driver.sendAndGetDevToolsCommand('ServiceWorker.enable', {});
    await driver.sendAndGetDevToolsCommand('ServiceWorker.stopAllWorkers', {});
    const scope = await command({ type: 'GET_VOLUME_SCOPE' }, true);
    assert.equal(scope.active, true);
    assert.equal(scope.volume, 2.5);
    const globalVolume = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      chrome.storage.local.get('settings').then(({settings})=>done(settings.volume));`);
    assert.equal(globalVolume, 1);
    console.log('PASS: new session resets global volume and restores the marked tab');
    await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      chrome.storage.local.get('settings').then(({settings})=>
        chrome.storage.local.set({settings:{...settings,volume:2.2}})).then(done);`);
    await driver.quit();
    driver = null;
    driver = await startEdge();
    const handles = await driver.getAllWindowHandles();
    let restoredPage;
    for (const handle of handles) {
      await driver.switchTo().window(handle);
      if ((await driver.getCurrentUrl()).startsWith(`http://127.0.0.1:${server.address().port}/`)) restoredPage = handle;
    }
    assert.ok(restoredPage, 'browser restored the video tab');
    await driver.switchTo().window(restoredPage);
    await driver.switchTo().newWindow('tab');
    popup = await driver.getWindowHandle();
    await driver.get(`${extensionUrl}/popup.html`);
    const restartedScope = await command({ type: 'GET_VOLUME_SCOPE' }, true);
    assert.equal(restartedScope.active, true);
    assert.equal(restartedScope.volume, 2.5);
    const reset = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];
      chrome.storage.local.get('settings').then(({settings})=>done(settings.volume));`);
    assert.equal(reset, 1);
    console.log('PASS: full browser shutdown/relaunch restores marked tab and resets global volume');
  }
  console.log(`${useFirefox ? 'Firefox' : 'Edge'} regression checks passed.`);
} finally {
  if (driver) await driver.quit();
  await new Promise((done) => server.close(done));
}
