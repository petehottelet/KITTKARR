import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createKittServer} from '../assistant/kitt-server-v1.mjs';
import {controlHeadless, formatHeadlessStatus} from '../scripts/kitt-control-v1.mjs';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kitt-headless-'));
  const calls = {captureStops: 0, playbackStops: 0, cancellations: 0, leds: []};
  const microphones = {mode: 'auto'};
  const audio = {initialize: async () => {}, check: async () => ({transcription: true}),
    stopPlayback() { calls.playbackStops++; }, stopCapture: async () => { calls.captureStops++; },
    startCapture: async () => {}, speak: async () => {}, close: async () => {}};
  const assistant = {initialize: async () => [], ask: async () => 'Example reply', cancel: async () => { calls.cancellations++; }, close() {}};
  const bridge = {start() { this.onChange({connected: false}); }, stop() {}};
  const wake = {running: false, check: async () => true,
    async start() { this.running = true; this.onState(true); },
    async stop() { this.running = false; this.onState?.(false); }};
  const sidePulse = {status: () => ({enabled: true, mode: 'test'}), async update(speech, options) { calls.leds.push({speech, options}); }};
  const app = await createKittServer({port: 0, directory, audio, assistant, bridge, wake, sidePulse, microphones, inputMonitor: null, thinkingTone: null, ...overrides});
  t.after(async () => { try { await app.close(); } finally { await rm(directory, {recursive: true, force: true}); } });
  await app.start();
  const base = `http://127.0.0.1:${app.port}`;
  const post = (route, body, headers = {}) => fetch(base + '/api/' + route, {method: 'POST', headers: {Origin: base, 'Content-Type': 'application/json', 'X-KITT-Intent': '1', ...headers}, body: JSON.stringify(body)});
  return {app, base, post, calls, wake, microphones, bridge, directory};
}

test('headless starts explicitly without USB or screen, pauses, resumes and restores the screen route', async t => {
  const {app, post, microphones, calls, wake, bridge} = await fixture(t);
  assert.deepEqual(app.state().headless, {enabled: false, paused: false});
  assert.equal(wake.running, false);
  assert.equal((await post('headless', {enabled: true})).status, 200);
  assert.equal(app.state().wake.active, true);
  assert.equal(app.state().wake.screenActive, false);
  assert.equal(microphones.mode, 'mac');
  assert(calls.leds.some(call => call.options?.idle));
  bridge.onChange({connected: true}); bridge.onChange({connected: false});
  assert.equal(wake.running, true);
  await post('headless', {enabled: true, paused: true});
  assert.equal(app.state().headless.paused, true);
  assert.equal(wake.running, false);
  assert(calls.captureStops > 0 && calls.playbackStops > 0 && calls.cancellations > 0);
  assert.deepEqual(calls.leds.at(-1).options, {hold: true, idle: false, thinking: false});
  await post('headless', {enabled: true, paused: false});
  assert.equal(wake.running, true);
  await post('headless', {enabled: false});
  assert.equal(microphones.mode, 'auto');
  assert.equal(wake.running, false);
  assert.equal(app.state().headless.enabled, false);
  assert.equal(calls.leds.at(-1).options.hold, false);
});

test('browser leases cannot resume paused headless capture; P4 can explicitly resume it', async t => {
  const {app, post, wake, bridge} = await fixture(t);
  await post('headless', {enabled: true, paused: true});
  bridge.onChange({connected: true});
  await post('wake', {clientId: 'test-screen', active: true});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(app.state().headless.paused, true);
  assert.equal(wake.running, false);
  assert.equal((await post('listen/start', {})).status, 400);
  await post('listening', {enabled: true});
  assert.equal(app.state().headless.paused, false);
  assert.equal(wake.running, true);
  await post('listening', {enabled: false});
  assert.equal(app.state().headless.paused, true);
});

test('headless mutations require the existing origin protection and strict booleans', async t => {
  const {app, post} = await fixture(t);
  assert.equal((await post('headless', {enabled: true}, {Origin: 'https://example.com'})).status, 403);
  for (const body of [{}, {enabled: 'true'}, {enabled: true, paused: 1}, {enabled: false, paused: true}]) {
    assert.equal((await post('headless', body)).status, 400);
  }
  assert.equal(app.state().headless.enabled, false);
});

test('pause revokes a pending wake start and headless operations serialize', async t => {
  let finishStart, starts = 0;
  const wake = {running: false, check: async () => true,
    async start() { starts++; await new Promise(resolve => { finishStart = resolve; }); },
    async stop() { finishStart?.(); finishStart = null; this.running = false; this.onState?.(false); }};
  const {app, post} = await fixture(t, {wake});
  assert.equal((await post('headless', {enabled: true})).status, 200);
  assert.equal(starts, 1);
  const paused = await post('headless', {enabled: true, paused: true});
  assert.equal(paused.status, 200);
  assert.equal(app.state().headless.paused, true);
  assert.equal(wake.running, false);
  await post('headless', {enabled: false});
  assert.equal(app.state().headless.enabled, false);
});

test('pause cancels an in-flight answer so late results never speak', async t => {
  let answer, spoken = 0;
  const audio = {initialize: async () => {}, check: async () => ({}), stopPlayback() {}, stopCapture: async () => {}, close: async () => {}, speak: async () => { spoken++; }};
  const assistant = {initialize: async () => [], ask: () => new Promise(resolve => { answer = resolve; }), cancel: async () => {}, close() {}};
  const {post, calls} = await fixture(t, {audio, assistant});
  await post('headless', {enabled: true});
  await post('ask', {text: 'Example request'});
  assert(calls.leds.some(call => call.options?.thinking));
  await post('headless', {enabled: true, paused: true});
  answer('Obsolete answer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spoken, 0);
});

test('terminal controls use the configured local port and stop releases LED ownership', async t => {
  const {app} = await fixture(t);
  const options = {port: app.port};
  await assert.rejects(controlHeadless('pause', options), /Use run first/);
  assert.equal((await controlHeadless('start', options)).headless.enabled, true);
  assert.equal((await controlHeadless('pause', options)).headless.paused, true);
  assert.equal((await controlHeadless('resume', options)).headless.paused, false);
  assert.equal((await controlHeadless('stop', options)).headless.enabled, false);
  assert.match(formatHeadlessStatus(await controlHeadless('status', options)), /KITT headless: stopped/);
  await assert.rejects(controlHeadless('unknown', options));
  await assert.rejects(controlHeadless('run', {port: 0}));
  await assert.rejects(controlHeadless('run', {fetch: async () => { throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); }}), error => !error.message.includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
});

test('slow optional LED output never delays starting or pausing the microphone', async t => {
  const sidePulse = {status: () => ({enabled: true, mode: 'pending'}), update: (_speech, options) => options ? new Promise(() => {}) : Promise.resolve()};
  const {post, wake} = await fixture(t, {sidePulse});
  assert.equal((await post('headless', {enabled: true})).status, 200);
  assert.equal(wake.running, true);
  assert.equal((await post('headless', {enabled: true, paused: true})).status, 200);
  assert.equal(wake.running, false);
});

test('headless sessions preserve a disabled screen listening preference', async t => {
  const {app, post, bridge} = await fixture(t);
  bridge.onChange({connected: true});
  await post('wake', {clientId: 'test-screen', active: true});
  await post('listening', {enabled: false});
  await post('headless', {enabled: true});
  assert.equal(app.state().wake.enabled, true);
  await post('headless', {enabled: false});
  assert.equal(app.state().wake.enabled, false);
  assert.equal(app.state().wake.active, false);
});

test('shutdown releases LED ownership and closes HTTP even if audio teardown fails', async t => {
  const audio = {initialize: async () => {}, check: async () => ({}), stopPlayback() {}, stopCapture: async () => {}, close: async () => { throw Error('Example shutdown failure'); }};
  const {app, post, calls} = await fixture(t, {audio});
  await post('headless', {enabled: true});
  await assert.rejects(app.close(), /Example shutdown failure/);
  assert.deepEqual(calls.leds.at(-1), {speech: null, options: undefined});
  assert.equal(app.server.listening, false);
});
