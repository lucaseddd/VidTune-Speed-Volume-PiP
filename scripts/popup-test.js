import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import edge from 'selenium-webdriver/edge.js';
import { installTestAddons } from './firefox-addons.js';

process.env.SE_CACHE_PATH = resolve('work/selenium-cache');
process.env.SE_AVOID_STATS = 'true';
await mkdir(process.env.SE_CACHE_PATH, { recursive: true });
const outputs = resolve('../../outputs');
await mkdir(outputs, { recursive: true });
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>VidTune popup test</title><video controls width="640" height="360"></video>' +
    (request.url.startsWith('/next') ? '<script>setTimeout(()=>{const v=document.querySelector("video");v.volume=0.3;v.dispatchEvent(new Event("canplay"));window.siteInitialized=true;},100);</script>' : ''));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const useEdge = process.argv.includes('--edge');
const name = useEdge ? 'Edge' : 'Firefox';
let driver;
try {
  let extensionUrl;
  if (useEdge) {
    const options = new edge.Options().addArguments('--headless=new', '--no-first-run', `--load-extension=${resolve('dist-chromium')}`);
    options.set('ms:edgeOptions', { ...options.get('ms:edgeOptions'), enableExtensionTargets: true });
    driver = await new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(options).build();
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    const targets = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
    const worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/src/background.js'));
    assert.ok(worker, 'Extension worker must start');
    const parsed = new URL(worker.url);
    extensionUrl = `${parsed.protocol}//${parsed.host}`;
  } else {
    const options = new firefox.Options().setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe').addArguments('-headless');
    const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
    driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(service).build();
    await installTestAddons(driver);
    await driver.setContext(firefox.Context.CHROME);
    const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['vidtune@vidtune.local'];");
    await driver.setContext(firefox.Context.CONTENT);
    extensionUrl = `moz-extension://${uuid}`;
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
  }
  const source = await driver.getWindowHandle();
  await driver.switchTo().newWindow('tab');
  const popup = await driver.getWindowHandle();
  await driver.get(`${extensionUrl}/popup.html`);
  await driver.manage().window().setRect({ width: 850, height: 850 });
  await driver.wait(async () => await driver.executeScript('return document.getElementById("status").textContent === "Ready"'), 5000);
  const version = await driver.executeScript('return {shown:document.getElementById("version").textContent,actual:(globalThis.browser??globalThis.chrome).runtime.getManifest().version}');
  assert.equal(version.shown, `v${version.actual}`);
  const positions = await driver.executeScript(`
    const version=document.getElementById('version').getBoundingClientRect();
    const name=document.querySelector('.brand strong').getBoundingClientRect();
    const legend=document.querySelector('.footnote');
    const presets=document.getElementById('volume-presets');
    const volumeOutput=document.getElementById('volume-value').getBoundingClientRect();
    return {
      versionBesideName:version.left>=name.right&&version.top<name.bottom&&version.bottom>name.top,
      shortcutsBesideSpeed:!!legend.closest('.speed-workspace .section-heading'),
      presetsBesideVolume:!!presets.closest('.audio-workspace .section-heading'),
      presetsBeforeOutput:presets.getBoundingClientRect().right<=volumeOutput.left
    };`);
  assert.deepEqual(positions, { versionBesideName: true, shortcutsBesideSpeed: true, presetsBesideVolume: true, presetsBeforeOutput: true });

  async function assertLayout(count, smart, chooser = false) {
    const result = await driver.executeScript(`
      const shell=document.querySelector('.shell'), box=shell.getBoundingClientRect();
      const clipped=[];
      for(const el of shell.querySelectorAll('button,input,select,output,.module-title,.popup-footer')) {
        const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;
        if(r.left<box.left-1||r.top<box.top-1||r.right>box.right+1||r.bottom>box.bottom+1)clipped.push(el.id||el.className||el.tagName);
        for(let p=el.parentElement;p&&p!==shell;p=p.parentElement) {
          if(!['hidden','clip'].includes(getComputedStyle(p).overflow))continue;
          const b=p.getBoundingClientRect();
          if(r.left<b.left-1||r.top<b.top-1||r.right>b.right+1||r.bottom>b.bottom+1)clipped.push((el.id||el.tagName)+' in '+p.className);
        }
      }
      const dense=!!document.querySelector('.speed-workspace')&&!!document.querySelector('.audio-workspace')&&!!document.querySelector('.quick-actions');
      return {width:box.width,height:box.height,clipped,dense,scrollWidth:shell.scrollWidth,clientWidth:shell.clientWidth,scrollHeight:shell.scrollHeight,clientHeight:shell.clientHeight};`);
    assert.equal(result.width, 320);
    assert.ok(result.height > 100 && result.height <= 600, `Panel must fit the browser popup limit: ${JSON.stringify(result)}`);
    if (result.clipped.length || result.scrollHeight > result.clientHeight) {
      await writeFile(`work/popup-overflow-${name}.png`, Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
      console.log(await driver.executeScript(`return [...document.querySelectorAll('.module-list,.speed-workspace,.audio-workspace,.audio-switches,.popup-footer')].map(el=>({name:el.className,height:el.getBoundingClientRect().height,top:el.getBoundingClientRect().top,scroll:el.scrollHeight}));`));
    }
    assert.deepEqual(result.clipped, [], `${name} ${count} tools, smart=${smart}, chooser=${chooser}: ${JSON.stringify(result)}`);
    assert.ok(result.scrollHeight <= result.clientHeight && result.scrollWidth <= result.clientWidth, JSON.stringify(result));
  }

  for (const smart of [true, false]) {
    for (const count of [2, 5, 10]) {
      await driver.executeAsyncScript(`const done=arguments[arguments.length-1];const api=globalThis.browser??globalThis.chrome;
        api.storage.local.get('settings').then(({settings})=>api.storage.local.set({settings:{...settings,moduleCount:arguments[0],smartOrganize:arguments[1]}})).then(()=>done(true));`, count, smart);
      await driver.navigate().refresh();
      await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === arguments[0]', count), 5000);
      await assertLayout(count, smart);
      if (smart) {
        await driver.findElement({ id: 'customize-tools' }).click();
        await assertLayout(count, smart, true);
        await driver.findElement({ id: 'customize-tools' }).click();
        await writeFile(resolve(outputs, `VidTune-adaptive-${count}-${name}.png`), Buffer.from(await driver.findElement({ css: '.shell' }).takeScreenshot(), 'base64'));
      }
    }
  }
  for (const layout of [
    ['speed', 'volume', 'seekBackward', 'seekForward', 'pip'],
    ['speed', 'volume', 'mono', 'tabVolume', 'seekBackward']
  ]) {
    await driver.executeAsyncScript(`const done=arguments[arguments.length-1],layout=arguments[0];const api=globalThis.browser??globalThis.chrome;
      api.storage.local.get('settings').then(({settings})=>api.storage.local.set({settings:{...settings,moduleCount:5,smartOrganize:true,moduleLayouts:{...settings.moduleLayouts,5:layout}}})).then(()=>done(true));`, layout);
    await driver.navigate().refresh();
    await driver.wait(async () => await driver.executeScript('return !!document.querySelector(".quick-actions") && !!document.querySelector(".audio-workspace")'), 5000);
    await assertLayout(5, true);
  }
  // Use the actual chooser to replace a small tool with a larger workspace.
  await driver.executeAsyncScript(`const done=arguments[arguments.length-1];const api=globalThis.browser??globalThis.chrome;
    api.storage.local.get('settings').then(({settings})=>api.storage.local.set({settings:{...settings,moduleCount:2,smartOrganize:true,moduleLayouts:{...settings.moduleLayouts,2:['mono','volume']}}})).then(()=>done(true));`);
  await driver.navigate().refresh();
  await driver.wait(async () => await driver.executeScript('return !!document.getElementById("mono-toggle") && !!document.querySelector(".smart-two")'), 5000);
  const smallHeight = await driver.executeScript('return document.querySelector(".shell").offsetHeight');
  await driver.findElement({ id: 'customize-tools' }).click();
  await driver.executeScript('const select=document.querySelector(\'.choice-select[data-index="0"]\');select.value="speed";select.dispatchEvent(new Event("change",{bubbles:true}));');
  await driver.wait(async () => await driver.executeScript('return !!document.getElementById("speed-value") && !document.getElementById("mono-toggle")'), 5000);
  await driver.findElement({ id: 'customize-tools' }).click();
  await assertLayout(2, true);
  const largeHeight = await driver.executeScript('return document.querySelector(".shell").offsetHeight');
  assert.ok(largeHeight > smallHeight + 50, 'A larger tool must grow the panel rather than clip its controls');
  await driver.findElement({ id: 'customize-tools' }).click();
  await driver.executeScript('const select=document.querySelector(\'.choice-select[data-index="0"]\');select.value="mono";select.dispatchEvent(new Event("change",{bubbles:true}));');
  await driver.wait(async () => await driver.executeScript('return !!document.getElementById("mono-toggle") && !document.getElementById("speed-value")'), 5000);
  await driver.findElement({ id: 'customize-tools' }).click();
  await assertLayout(2, true);
  assert.ok((await driver.executeScript('return document.querySelector(".shell").offsetHeight')) < largeHeight - 50, 'Removing a large tool must reclaim the empty space');
  assert.equal(await driver.executeScript('return document.querySelectorAll("#pin-controls").length'), 0);

  const targetId = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];import('./src/browser.js').then(m=>m.activeTab()).then(tab=>done(tab.id));`);
  for (const volume of [0.61, 1]) {
    const scoped = await driver.executeAsyncScript(`const done=arguments[arguments.length-1],tabId=arguments[0],volume=arguments[1];const api=globalThis.browser??globalThis.chrome;
      (async()=>{await api.runtime.sendMessage({type:'SET_VOLUME_SCOPE',tabId,enabled:true,volume});const {sendToVideo}=await import('./src/browser.js');return sendToVideo(tabId,{type:'SYNC_VOLUME_SCOPE'});})().then(done,e=>done({error:String(e)}));`, targetId, volume);
    assert.equal(scoped.volume, volume);
    await driver.switchTo().window(source);
    await driver.get(`http://127.0.0.1:${server.address().port}/next?volume=${volume}`);
    await driver.wait(async () => await driver.executeScript('return window.siteInitialized === true && Math.abs(document.querySelector("video").volume-arguments[0])<0.0001', volume), 5000, 'The tab volume must survive a new video and the player restoring its own default');
    await driver.switchTo().window(popup);
    const scope = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];(globalThis.browser??globalThis.chrome).runtime.sendMessage({type:'GET_VOLUME_SCOPE',tabId:arguments[0]}).then(done);`, targetId);
    assert.equal(scope.active, true);
    assert.equal(scope.volume, volume);
  }
  console.log(`${name} popup passed: automatic version, all layouts and choosers fit, larger tools expand the panel, smaller tools reclaim space, no Pin, and tab-only volume survives video navigation including 100%.`);
} catch (error) {
  if (driver) {
    for (const handle of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(handle);
      console.log('Popup diagnostic:', await driver.getCurrentUrl(), await driver.executeScript('return document.body.innerText'));
      if ((await driver.getCurrentUrl()).includes('-extension://')) {
        console.log('Extension windows:', await driver.executeAsyncScript(`const done=arguments[arguments.length-1];(globalThis.browser??globalThis.chrome).windows.getAll({populate:true}).then(done);`));
      }
    }
  }
  throw error;
} finally {
  if (driver) await driver.quit();
  await new Promise(done => server.close(done));
}
