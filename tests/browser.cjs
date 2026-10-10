const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createDemoWav } = require('../signal.js');

(async () => {
  mkdirSync('output/qa', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (event) => { if (event.type() === 'error') errors.push(event.text()); });
  const speechRequests = [];
  await page.route('**/api/speech', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { available: true } });
      return;
    }
    speechRequests.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
    await route.fulfill({ contentType: 'audio/wav', body: Buffer.from(createDemoWav()) });
  });
  await page.goto('http://127.0.0.1:4173');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('[data-switch]').count(), 11);
  assert.equal(await page.locator('.led').count(), 60);
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.equal(await page.locator('#track-name').textContent(), 'Demo tones');
  assert.ok(await page.locator('#audio').evaluate((audio) => audio.currentSrc.startsWith('blob:')));
  assert.ok(await page.locator('#audio').evaluate((audio) => audio.duration === 10));
  assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
  const lit = () => page.locator('.led').evaluateAll((leds) => leds.filter((led) => Number(led.style.getPropertyValue('--intensity')) > 0).length);
  assert.equal(await lit(), 0);
  for (const button of await page.locator('[data-switch]').all()) {
    const initial = await button.getAttribute('aria-pressed');
    await button.click();
    assert.notEqual(await button.getAttribute('aria-pressed'), initial);
    await button.press('Space');
    assert.equal(await button.getAttribute('aria-pressed'), initial);
  }
  await page.locator('#audio-file').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
  assert.match(await page.locator('#feedback').textContent(), /Choose an audio file/);
  await page.locator('#demo').click();
  await page.waitForFunction(() => !document.querySelector('#audio').paused && document.querySelector('#audio').currentTime > .45);
  const playContrast = () => page.locator('#play').evaluate((button) => {
    const style = getComputedStyle(button);
    const luminance = (color) => {
      const values = color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  });
  assert.ok(await playContrast() >= 4.5, 'Play text must meet normal-text contrast');
  await page.locator('#play').hover();
  assert.ok(await playContrast() >= 4.5, 'Hovered Play text must meet normal-text contrast');
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.led')].filter((led) => Number(led.style.getPropertyValue('--intensity')) > 0).length > 26);
  // Sample the real rendered face, including its top and bottom edge. A rim,
  // inset bevel, or hollow gradient produces a measurable brightness dip.
  for (const edge of ['first', 'last']) {
    const litSegments = page.locator('.led[style*="--lit: 1"]');
    const segment = edge === 'first' ? litSegments.first() : litSegments.last();
    const pixels = await segment.screenshot();
    const rows = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      // Stay inside the face: the screenshot bounds round fractional CSS pixels.
      return [.25, .5, .75].map((fraction) => {
        const y = Math.floor(image.height * fraction);
        const pixel = context.getImageData(Math.floor(image.width / 2), y, 1, 1).data;
        return .2126 * pixel[0] + .7152 * pixel[1] + .0722 * pixel[2];
      });
    }, `data:image/png;base64,${pixels.toString('base64')}`);
    assert.ok(Math.max(...rows) - Math.min(...rows) < 5, `${edge} active LED must have a solid face at its top, center, and bottom`);
  }
  await page.screenshot({ path: 'output/qa/desktop.png', fullPage: true });
  const sampleCounts = [];
  for (let index = 0; index < 5; index++) { await page.waitForTimeout(160); sampleCounts.push(await lit()); }
  assert.ok(new Set(sampleCounts).size > 1, 'Audio must change the actual LED pattern');
  await page.locator('#play').click();
  assert.equal(await lit(), 0, 'Pause immediately clears the LEDs');
  assert.equal(await page.locator('#play').textContent(), 'Play');
  await page.locator('#loop').click();
  assert.equal(await page.locator('#audio').evaluate((audio) => audio.loop), true);
  await page.locator('#seek').fill('500');
  assert.ok(await page.locator('#audio').evaluate((audio) => Math.abs(audio.currentTime - audio.duration * .5) < .1));
  await page.locator('#volume').fill('0');
  assert.equal(await page.locator('#volume-value').textContent(), '0%');
  await page.locator('#play').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.led')].some((led) => Number(led.style.getPropertyValue('--intensity')) > 0));
  await page.locator('#stop').click();
  assert.equal(await lit(), 0);
  assert.equal(await page.locator('#elapsed').textContent(), '0:00');

  const recording = Buffer.from(createDemoWav());
  await page.locator('#audio-file').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid wave data') });
  await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('could not be read'));
  assert.equal(await page.locator('#play').isDisabled(), true);
  await page.locator('#audio-file').setInputFiles({ name: 'A local voice recording.wav', mimeType: 'audio/wav', buffer: recording });
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.equal(await page.locator('#duration').textContent(), '0:10');
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#audio').currentTime > .5);
  await page.locator('#audio-file').setInputFiles({ name: 'Replacement recording.wav', mimeType: 'audio/wav', buffer: recording });
  await page.waitForFunction(() => !document.querySelector('#play').disabled);
  assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
  assert.equal(await lit(), 0);

  await page.locator('#speech-text').fill('Systems ready.');
  await page.locator('#speech-text').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#track-name').textContent === 'Systems ready.' && !document.querySelector('#audio').paused);
  await page.waitForFunction(() => [...document.querySelectorAll('.led')].some((led) => Number(led.style.getPropertyValue('--intensity')) > 0));
  assert.deepEqual(speechRequests, [{ body: { text: 'Systems ready.' }, authorization: undefined }]);
  assert.match(await page.locator('#feedback').textContent(), /Speech generated/);
  await page.locator('#stop').click();

  await page.locator('#fullscreen').click();
  assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('panel-view')), true);
  await page.locator('#fullscreen').click();
  assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('panel-view')), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#volume').fill('0.7');
  await page.locator('#demo').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.led')].filter((led) => Number(led.style.getPropertyValue('--intensity')) > 0).length > 26);
  await page.screenshot({ path: 'output/qa/mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile must not overflow');
  await page.setViewportSize({ width: 320, height: 700 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow mobile must not overflow');
  await page.locator('#stop').click();
  await page.evaluate(() => localStorage.setItem('kitt-switches', '7'));
  await page.reload();
  await page.locator('[data-switch="air"]').click();
  assert.equal(await page.locator('[data-switch="air"]').getAttribute('aria-pressed'), 'false');
  await page.goto(pathToFileURL(path.resolve('index.html')).href);
  await page.locator('#demo').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.led')].some((led) => Number(led.style.getPropertyValue('--intensity')) > 0));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ result: 'pass', switches: 11, ledSegments: 60, audioPatternSamples: sampleCounts, browserErrors: errors.length, checks: ['generated demo tones', 'solid top and bottom LED faces', 'keyboard toggles', 'invalid files', 'demo audio drives LEDs', 'pause clears LEDs', 'seek', 'loop', 'mute preserves visualization', 'stop rewinds', 'local upload', 'source replacement', 'speech generation and playback with a stubbed provider', 'panel view', '390px and 320px layouts', 'direct file opening'] }));
  await browser.close();
})().catch((error) => { console.error(error.message, 'at test line', error.stack?.match(/browser.cjs:(\d+)/)?.[1] || 'unknown'); process.exit(1); });
