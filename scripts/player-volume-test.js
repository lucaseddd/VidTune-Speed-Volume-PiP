// Exercise real media events while the extension's audio boost is active.
export async function checkPlayerVolume(driver, control, page, popup, selector) {
  const initial = await control({ type: 'GET_STATE' });
  for (const volume of [0.25, 0, 0.6, 1]) {
    await driver.switchTo().window(page);
    await driver.executeScript(`const video=document.querySelector(arguments[0]);
      video.volume=arguments[1];video.pause();return video.play();`, selector, volume);
    await driver.switchTo().window(popup);
    const state = await control({ type: 'SET_SPEED', speed: initial.speed === 1.5 ? 1.6 : 1.5 });
    if (state.volume !== initial.volume || state.boostUnavailable) throw new Error('Player adjustment lost boost');
    await driver.switchTo().window(page);
    const actual = await driver.executeAsyncScript(`const video=document.querySelector(arguments[0]);
      const done=arguments[arguments.length-1];setTimeout(()=>done(video.volume),100);`, selector);
    if (Math.abs(actual - volume) > 0.00001) throw new Error(`Player volume jumped from ${volume} to ${actual}`);
    await driver.switchTo().window(popup);
    await control({ type: 'SET_SPEED', speed: initial.speed });
  }
  await driver.switchTo().window(page);
  await driver.executeScript('document.querySelector(arguments[0]).muted=true', selector);
  await driver.switchTo().window(popup);
  if ((await control({ type: 'GET_STATE' })).volume !== 0) throw new Error('Player mute was ignored');
  await driver.switchTo().window(page);
  await driver.executeScript('document.querySelector(arguments[0]).muted=false', selector);
  await driver.switchTo().window(popup);
  if ((await control({ type: 'GET_STATE' })).volume !== initial.volume) throw new Error('Player unmute lost boost');
  console.log('Player volume passed: native adjustments, pause/resume, speed changes, mute/unmute with boost active.');
}
