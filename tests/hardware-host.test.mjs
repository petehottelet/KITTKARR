import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createKittServer} from '../assistant/kitt-server-v1.mjs';
import {SidePulseVoice} from '../assistant/sidepulse-v1.mjs';

test('Car Thing, SidePulse and both share one host while LED testing is independent of voice setup', async t => {
  const prior = process.env.KITT_MODE; process.env.KITT_MODE = 'browser';
  t.after(() => { if (prior === undefined) delete process.env.KITT_MODE; else process.env.KITT_MODE = prior; });
  for (const [carThing, leds] of [[true,false],[false,true],[true,true]]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'kitt-hardware-host-'));
    const writes = []; let ready = true;
    const sidePulse = new SidePulseVoice({enabled: leds, probe: async () => ({ready, message: ready ? 'SidePulse Pro ready.' : 'Enable device output.'}), connect: async () => ({brightness: 100, previous: 'off', write: async program => { writes.push(program); return true; }})});
    const audio = {initialize: async () => {}, check: async () => ({transcription: false}), stopPlayback() {}, stopCapture: async () => {}, close: async () => {}, speak: async () => {}};
    const wake = {running: false, check: async () => false, stop: async () => {}};
    const assistant = {initialize: async () => [], close() {}, cancel: async () => {}, ask: () => assert.fail('No AI needed')};
    const bridge = carThing ? {start() { this.onChange({connected: true}); }, stop() {}} : undefined;
    const app = await createKittServer({port: 0, directory, audio, wake, assistant, bridge, sidePulse, inputMonitor: null, thinkingTone: null});
    try {
      await app.start(); const origin = `http://127.0.0.1:${app.port}`;
      const post = (action, overrides = {}) => fetch(origin + '/api/' + action, {method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json', 'X-KITT-Intent': '1', ...overrides}, body: '{}'});
      assert.deepEqual(app.state().hardware, {carThing, sidePulse: leds});
      assert.equal((await post('sidepulse/test', {Origin: 'https://example.com'})).status, 403);
      assert.equal((await post('sidepulse/test')).status, leds ? 200 : 400);
      if (leds) {
        await new Promise(resolve => setTimeout(resolve, 25)); assert(writes.some(program => program.includes('#ff0000')));
        assert.equal(app.state().sidePulse.testing, true); assert.equal(app.state().phase, 'idle');
        await post('cancel'); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(app.state().sidePulse.testing, false); assert.equal(writes.at(-1), 'off');
        ready = false; assert.equal((await post('sidepulse/test')).status, 400); assert.equal(app.state().sidePulse.testing, false);
      } else assert.equal(writes.length, 0);
    } finally { await app.close(); await rm(directory, {recursive: true, force: true}); }
  }
});
