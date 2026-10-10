// Revision 2. Verify playback timing is independent of device wall-clock adjustments.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const signal = require('../signal.js');

test('playback advances from the native position without consulting the device wall clock',()=>{
 const speech={positionMs:1400,updatedAt:1791327000000,startedAt:1791326998600};
 assert.equal(signal.speechPosition(speech,1791327000010,9000,9050),1460);
 // A new native sample reanchors cleanly, including a subsequent audio section.
 assert.equal(signal.speechPosition({...speech,positionMs:100,updatedAt:1791327005000},1791327005000,14000,14025),125);
 assert.equal(signal.speechPosition({startedAt:1791326998600},1791327000000,9000,9050),1450);
 assert.equal(signal.speechPosition(null,0,0,100),-1);
 assert.equal(signal.speechPosition({...speech,positionMs:-40},1791327000000,9000,9020),-20);
});

test('playback envelope interpolates between sample centers and stays dark outside speech',()=>{
 const speech={levels:[0,.2,0],stepMs:25,durationMs:75};
 assert.equal(signal.speechAmplitude(speech,-1),0);assert.equal(signal.speechAmplitude(speech,75),0);
 assert.equal(signal.speechAmplitude(speech,25),.1);assert.equal(signal.speechAmplitude(speech,37.5),.2);assert.equal(signal.speechAmplitude(speech,50),.1);
 let level=0;level=signal.smoothSpeechLevel(level,1,.05);assert(level>.9&&level<1);
 level=signal.smoothSpeechLevel(level,0,.1);assert(level>.1&&level<.25);
 for(let i=0;i<30;i++)level=signal.smoothSpeechLevel(level,0,1/60);assert.equal(level,0);
});

test('silence and the noise floor do not illuminate LEDs', () => {
  assert.equal(signal.rms(new Float32Array(2048)), 0);
  assert.equal(signal.rms([]), 0);
  assert.equal(signal.amplitudeToLevel(0), 0);
  assert.equal(signal.amplitudeToLevel(.002, 3), 0);
  for (let index = 0; index < 20; index++) assert.equal(signal.segmentIntensity(0, index), 0);
});

test('a louder audio signal expands the display and sensitivity increases its response', () => {
  const quiet = signal.amplitudeToLevel(.015);
  const speech = signal.amplitudeToLevel(.08);
  const loud = signal.amplitudeToLevel(.4);
  assert.ok(quiet > 0 && quiet < speech && speech < loud);
  assert.ok(signal.amplitudeToLevel(.015, 2) > quiet);
  assert.equal(signal.amplitudeToLevel(1, 3), 1);
  const count = (level) => Array.from({ length: 20 }, (_, index) => signal.segmentIntensity(level, index)).filter((n) => n > 0).length;
  assert.ok(count(quiet) < count(loud));
});

test('segments illuminate symmetrically from the center, with shorter side columns', () => {
  for (const level of [.15, .4, .8, 1]) {
    for (let index = 0; index < 20; index++) {
      assert.equal(signal.segmentIntensity(level, index), signal.segmentIntensity(level, 19 - index));
      assert.ok(signal.segmentIntensity(level * .76, index) <= signal.segmentIntensity(level, index));
    }
    assert.ok(signal.segmentIntensity(level, 9) >= signal.segmentIntensity(level, 0));
  }
});

test('envelope rises quickly, releases smoothly, and fully settles after silence', () => {
  const attack = signal.smoothLevel(0, 1, .05);
  const release = signal.smoothLevel(1, 0, .05);
  assert.ok(attack > .8);
  assert.ok(release > .5 && release < 1);
  let level = 1;
  for (let index = 0; index < 100; index++) level = signal.smoothLevel(level, 0, 1 / 60);
  assert.equal(level, 0);
});

test('backlighting is brightest at the center and fades symmetrically to red tips', () => {
  const luminance = (color) => {
    const [r, g, b] = color.match(/\d+/g).map(Number).map((value) => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  for (const level of [.35, .6, 1]) {
    const center = luminance(signal.segmentColor(level, 9));
    let previous = 0;
    for (let index = 0; index < 10; index++) {
      const color = signal.segmentColor(level, index);
      assert.equal(color, signal.segmentColor(level, 19 - index));
      const brightness = luminance(color);
      assert.ok(brightness >= previous, 'Brightness must increase toward the center');
      previous = brightness;
    }
    assert.ok(center > luminance(signal.segmentColor(level, 0)) * 2);
    assert.ok(luminance(signal.segmentColor(level, 5)) >= luminance(signal.segmentColor(level * .76, 5)));
  }
});

test('demo is a valid ten-second PCM WAV containing sound and silent pauses', () => {
  const wav = signal.createDemoWav();
  const bytes = Buffer.from(wav);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(24), 22050);
  assert.equal(bytes.readUInt32LE(40), 22050 * 10 * 2);
  const samples = new Int16Array(wav, 44);
  assert.equal(signal.rms(samples.slice(0, 3000)), 0);
  assert.ok(signal.rms(samples.slice(11025, 22050)) > 1000);
  assert.equal(signal.rms(samples.slice(48510, 52920)), 0);
});

test('time formatting handles an unloaded source and hour-long recordings', () => {
  assert.equal(signal.formatTime(NaN), '0:00');
  assert.equal(signal.formatTime(Infinity), '0:00');
  assert.equal(signal.formatTime(-1), '0:00');
  assert.equal(signal.formatTime(65.9), '1:05');
  assert.equal(signal.formatTime(3661), '61:01');
});
