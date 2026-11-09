import { Builder } from 'selenium-webdriver';
import edge from 'selenium-webdriver/edge.js';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const folder = resolve('presentation/screenshots');
await mkdir(folder, { recursive: true });
await mkdir('work', { recursive: true });
const server = createServer((_request, response) => response.end('<!doctype html><title>Video preview</title><video controls width="640" height="360"></video>'));
await new Promise(done => server.listen(0, '127.0.0.1', done));
const options = new edge.Options().addArguments('--headless=new', '--no-first-run', `--load-extension=${resolve('dist-chromium')}`);
options.set('ms:edgeOptions', { ...options.get('ms:edgeOptions'), enableExtensionTargets: true });
const driver = await new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(options).build();
try {
  await driver.get(`http://127.0.0.1:${server.address().port}/`);
  const targets = await driver.sendAndGetDevToolsCommand('Target.getTargets', {});
  const parsed = new URL(targets.targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/src/background.js')).url);
  const root = `${parsed.protocol}//${parsed.host}`;
  await driver.switchTo().newWindow('tab');
  await driver.get(`${root}/popup.html`);
  await driver.wait(async () => await driver.executeScript('return !!document.getElementById("speed-value")'), 5000);
  await driver.executeAsyncScript('const done=arguments[arguments.length-1];import("./src/settings.js").then(async m=>{await chrome.storage.local.set({settings:m.DEFAULT_SETTINGS});done();});');
  for (const [count, name] of [[2, 'basic'], [5, 'advanced']]) {
    await driver.executeAsyncScript('const done=arguments[arguments.length-1];chrome.storage.local.get("settings").then(({settings})=>chrome.storage.local.set({settings:{...settings,moduleCount:arguments[0]}})).then(done);', count);
    await driver.navigate().refresh();
    await driver.wait(async () => await driver.executeScript('return document.getElementById("status").textContent === "Ready"'), 5000);
    await writeFile(resolve(folder, `${name}.png`), Buffer.from(await driver.findElement({css:'.shell'}).takeScreenshot(), 'base64'));
  }
  await driver.findElement({id:'customize-tools'}).click();
  await writeFile(resolve(folder, 'choose-tools.png'), Buffer.from(await driver.findElement({css:'.shell'}).takeScreenshot(), 'base64'));
  await driver.get(`${root}/options.html`);
  await driver.wait(async () => await driver.executeScript('return document.querySelectorAll("#key-decrease option").length>1'), 5000);
  for (const [selector, name] of [['section[aria-labelledby="shortcuts-title"]','shortcuts'],['section[aria-labelledby="site-title"]','site-settings']]) {
    await writeFile(resolve(folder, `${name}.png`), Buffer.from(await driver.findElement({css:selector}).takeScreenshot(), 'base64'));
  }
  const data = async name => `data:image/png;base64,${(await readFile(resolve(folder, `${name}.png`))).toString('base64')}`;
  const advanced = await data('advanced'), basic = await data('basic'), chooser = await data('choose-tools');
  const scenes = [
    ['01-video-control', `<div class="copy"><div class="eyebrow">VIDTUNE · VIDEO CONTROLS</div><h1>Your video.<br>Your pace.</h1><p>Speed up. Turn it up.<br>Keep it simple.</p><div class="chips"><span>0.1×–16× speed</span><span>Up to 300% volume</span><span>Picture-in-Picture</span></div><small>Compact controls. No analytics.</small></div><img class="hero" src="${advanced}">`],
    ['02-basic-advanced', `<div class="top"><div class="eyebrow">ONE EXTENSION. YOUR WAY.</div><h1>Less clutter. More control.</h1></div><div class="pair"><div><h2>Basic</h2><p>Speed + volume. Fewer background visuals.</p><img src="${basic}"></div><div><h2>Advanced</h2><p>Audio mono, PiP and independent tab settings.</p><img src="${advanced}"></div></div>`],
    ['03-make-it-yours', `<div class="copy"><div class="eyebrow">BUILT AROUND YOU</div><h1>Make every<br>tab yours.</h1><p>Keep speed and volume in one tab.<br>Change shortcut keys with a click.<br>Choose your tools. Reset anytime.</p><div class="chips"><span>Custom shortcuts</span><span>Site preferences</span></div><small>Your preferences stay in your browser.</small></div><img class="hero" src="${chooser}">`]
  ];
  for (const [name, body] of scenes) {
    const html = `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font-family:Segoe UI,Arial,sans-serif;color:#eff5ff;background:#0b1120}#stage{width:1280px;height:800px;position:relative;overflow:hidden;background:radial-gradient(ellipse at 85% 25%,#23427080,transparent 60%),#0b1120;padding:68px 80px}.eyebrow{font-size:15px;letter-spacing:3px;font-weight:600;color:#91baff}h1{font-size:64px;font-weight:650;letter-spacing:-2.8px;line-height:1.06;margin:24px 0}p{font-size:23px;line-height:1.55;color:#b9c9df}.copy{position:absolute;left:80px;top:120px;max-width:610px}.chips{display:flex;flex-wrap:wrap;gap:10px;max-width:510px;margin-top:26px}.chips span{padding:10px 15px;border:1px solid #334e72;border-radius:24px;font-size:16px;color:#c9ddfb}small{display:block;font-size:17px;color:#8ca1bf;margin-top:30px}.hero{position:absolute;right:105px;top:155px;width:384px;border:1px solid #31445f;border-radius:20px;box-shadow:0 30px 80px #0006}.top h1{font-size:48px;margin:16px 0}.pair{display:flex;gap:85px;justify-content:center;margin-top:25px}.pair>div{width:420px;text-align:center}.pair h2{font-size:24px;margin:0 0 4px}.pair p{font-size:16px;margin:0 0 18px}.pair img{width:320px;border:1px solid #31445f;border-radius:16px;box-shadow:0 20px 50px #0004}</style><div id="stage">${body}</div>`;
    const file = resolve(`work/${name}.html`);
    await writeFile(file, html);
    await driver.get(pathToFileURL(file).href);
    await driver.sendAndGetDevToolsCommand('Emulation.setDeviceMetricsOverride', {width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await writeFile(resolve('presentation',`${name}.png`), Buffer.from(await driver.findElement({css:'#stage'}).takeScreenshot(), 'base64'));
  }
  console.log('Captured current UI and three 1280 × 800 presentation images.');
} finally { await driver.quit(); await new Promise(done => server.close(done)); }
