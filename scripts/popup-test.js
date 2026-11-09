import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Builder, Key } from 'selenium-webdriver';
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
    const presetBox=presets.getBoundingClientRect();
    const slider=document.getElementById('volume-slider').getBoundingClientRect();
    return {
      versionBesideName:version.left>=name.right&&version.top<name.bottom&&version.bottom>name.top,
      shortcutsBesideSpeed:!!legend.closest('.speed-workspace .section-heading'),
      presetsBesideVolume:!!presets.closest('.audio-workspace .section-heading'),
      presetsBeforeOutput:presetBox.right<=volumeOutput.left,
      presetsCentered:Math.abs((presetBox.left+presetBox.right-slider.left-slider.right)/2)<1,
      presetsAlignedWithOutput:Math.abs((presetBox.top+presetBox.bottom-volumeOutput.top-volumeOutput.bottom)/2)<1
    };`);
  assert.deepEqual(positions, { versionBesideName: true, shortcutsBesideSpeed: true, presetsBesideVolume: true, presetsBeforeOutput: true, presetsCentered: true, presetsAlignedWithOutput: true });
  const slowerShortcut = await driver.findElement({css:'[data-shortcut="decrease"]'});
  await driver.switchTo().newWindow('tab');
  const optionsWindow = await driver.getWindowHandle();
  await driver.get(`${extensionUrl}/options.html`);
  await driver.wait(async()=>await driver.executeScript('return !!document.querySelector("#key-decrease option[value=KeyX]")'), 5000);
  await driver.executeScript('const field=document.getElementById("key-decrease");field.value="KeyX";field.dispatchEvent(new Event("change",{bubbles:true}));');
  await driver.switchTo().window(popup);
  await driver.wait(async()=>await slowerShortcut.getAttribute('textContent') === 'X Slower', 5000);
  await slowerShortcut.click();
  await slowerShortcut.sendKeys('z');
  await driver.wait(async()=>await slowerShortcut.getAttribute('textContent') === 'Z Slower', 5000);
  await driver.switchTo().window(optionsWindow);
  await driver.wait(async()=>await driver.executeScript('return document.getElementById("key-decrease").value === "KeyZ"'), 5000);
  await driver.close();
  await driver.switchTo().window(popup);
  const fasterShortcut = await driver.findElement({css:'[data-shortcut="increase"]'});
  await fasterShortcut.click();
  await fasterShortcut.sendKeys('z');
  assert.equal(await fasterShortcut.getAttribute('aria-pressed'), 'true', 'A duplicate must not replace another shortcut');
  await fasterShortcut.sendKeys(Key.ESCAPE);
  await driver.findElement({css:'.reset-shortcuts'}).click();
  await driver.wait(async()=>await slowerShortcut.getAttribute('textContent') === 'A Slower', 5000);
  assert.deepEqual(await driver.executeAsyncScript('const done=arguments[arguments.length-1];(globalThis.browser??globalThis.chrome).storage.local.get("settings").then(({settings})=>done([settings.shortcuts.decrease,settings.shortcuts.increase,settings.shortcuts.reset]));'), ['KeyA','KeyD','KeyQ']);
  assert.equal(await driver.executeScript('return document.querySelector(".speed-workspace").getBoundingClientRect().top < document.querySelector(".audio-workspace").getBoundingClientRect().top'), true);
  assert.deepEqual(await driver.executeScript('return [...document.querySelectorAll("#tool-count option")].map(option=>option.textContent)'), ['Basic', 'Advanced']);
  assert.deepEqual(await driver.executeScript('return [...document.querySelectorAll(".speed-presets [data-speed]")].map(button=>Number(button.dataset.speed))'), [0.25, 0.5, 1, 1.5, 2]);
  await driver.findElement({css:'[data-action="OPEN_CUSTOM_SPEED"]'}).click();
  const customInput = await driver.findElement({id:'smart-custom-speed'});
  await customInput.clear();
  await customInput.sendKeys('17', Key.ENTER);
  assert.equal(await customInput.isDisplayed(), true, 'Invalid custom speeds must remain editable');
  await customInput.clear();
  await customInput.sendKeys('1.25', Key.ENTER);
  await driver.wait(async()=>await driver.executeScript('return document.getElementById("speed-value").textContent === "1.25×"'), 5000);
  await driver.findElement({css:'[data-action="OPEN_CUSTOM_SPEED"]'}).click();
  await customInput.sendKeys(Key.ESCAPE);
  assert.equal(await customInput.isDisplayed(), false);

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
    for (const count of [2, 5]) {
      await driver.executeAsyncScript(`const done=arguments[arguments.length-1];const api=globalThis.browser??globalThis.chrome;
        api.storage.local.get('settings').then(({settings})=>api.storage.local.set({settings:{...settings,moduleCount:arguments[0],smartOrganize:arguments[1]}})).then(()=>done(true));`, count, smart);
      await driver.navigate().refresh();
      await driver.wait(async () => await driver.executeScript('return document.querySelectorAll(".module-row").length === arguments[0]', count), 5000);
      await assertLayout(count, smart);
      await driver.switchTo().window(source);
      await driver.wait(async()=>await driver.executeScript('return !!document.getElementById("vidtune-speed-indicator") === arguments[0]', count === 5), 5000, 'Basic must release the video overlay; Advanced restores it');
      await driver.switchTo().window(popup);
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
  await driver.findElement({ id: 'customize-tools' }).click();
  await driver.findElement({ css: '.reset-tools' }).click();
  await driver.wait(async()=>await driver.executeScript('return !!document.getElementById("speed-value") && !document.getElementById("mono-toggle")'), 5000);
  assert.deepEqual(await driver.executeScript('return [...document.querySelectorAll(".choice-select")].map(select=>select.value)'), ['speed', 'volume']);
  await driver.findElement({ id: 'customize-tools' }).click();
  assert.equal(await driver.executeScript('return document.querySelectorAll("#pin-controls").length'), 0);

  const targetId = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];import('./src/browser.js').then(m=>m.activeTab()).then(tab=>done(tab.id));`);
  for (const volume of [0.61, 1]) {
    const scoped = await driver.executeAsyncScript(`const done=arguments[arguments.length-1],tabId=arguments[0],volume=arguments[1];const api=globalThis.browser??globalThis.chrome;
      (async()=>{await api.runtime.sendMessage({type:'SET_VOLUME_SCOPE',tabId,enabled:true,volume,speed:1.75});const {sendToVideo}=await import('./src/browser.js');await sendToVideo(tabId,{type:'SYNC_VOLUME_SCOPE'});return sendToVideo(tabId,{type:'SET_SPEED',speed:2.25});})().then(done,e=>done({error:String(e)}));`, targetId, volume);
    assert.equal(scoped.volume, volume);
    await driver.switchTo().window(source);
    await driver.get(`http://127.0.0.1:${server.address().port}/next?volume=${volume}`);
    await driver.wait(async () => await driver.executeScript('return window.siteInitialized === true && Math.abs(document.querySelector("video").volume-arguments[0])<0.0001 && document.querySelector("video").playbackRate === 2.25', volume), 5000, 'The tab speed and volume must survive a new video and the player restoring its own default');
    await driver.switchTo().window(popup);
    const scope = await driver.executeAsyncScript(`const done=arguments[arguments.length-1];(globalThis.browser??globalThis.chrome).runtime.sendMessage({type:'GET_VOLUME_SCOPE',tabId:arguments[0]}).then(done);`, targetId);
    assert.equal(scope.active, true);
    assert.equal(scope.volume, volume);
    assert.equal(scope.speed, 2.25);
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
