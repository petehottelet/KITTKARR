import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {connectSidePulse, SidePulseVoice, speechProgram, idleSweepProgram, thinkingProgram, diagnoseSidePulse, previewSidePulse} from '../assistant/sidepulse-v1.mjs';

const clip = (now = 1000) => ({id: 'test-clip', startedAt: now, updatedAt: now, positionMs: 0, stepMs: 25, durationMs: 2000, levels: Array(80).fill(0.4)});
const target = path.resolve('example-device', 'LED.txt');
test('read-only diagnostics explain disabled, missing, unsupported and multiple devices without exposing targets', async () => {
  const fake = daemon();
  assert.equal((await diagnoseSidePulse(fake.options)).code, 'ready');
  fake.state.outputs_enabled = false; assert.equal((await diagnoseSidePulse(fake.options)).code, 'output-disabled');
  fake.state.outputs_enabled = true; fake.state.devices.push({...fake.state.devices[0]}); assert.equal((await diagnoseSidePulse(fake.options)).code, 'multiple-devices');
  fake.state.devices = [{model: 'SidePulse Dot', connection: 'drive', target}]; assert.equal((await diagnoseSidePulse(fake.options)).code, 'unsupported-device');
  fake.state.devices = []; assert.equal((await diagnoseSidePulse(fake.options)).code, 'disconnected');
  const unavailable = await diagnoseSidePulse({command: async () => { throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); }});
  assert.equal(unavailable.code, 'service-unavailable'); assert(!JSON.stringify(unavailable).includes('EXAMPLE_PRIVATE_DIAGNOSTIC')); assert.equal(fake.writes.length, 0);
});

test('standalone LED demonstration restores the preceding display and respects an output disable during testing', async () => {
  const fake = daemon();
  await previewSidePulse({connect: () => connectSidePulse(fake.options), wait: async () => {}});
  assert.equal(fake.writes.at(-1).program, 'brightness 123\n#0000ff'); assert.equal(fake.writes.at(-1).hold_seconds, 0);
  await previewSidePulse({connect: () => connectSidePulse(fake.options), wait: async () => { fake.state.outputs_enabled = false; }});
  assert.equal(fake.writes.at(-1).program, 'off');
});
function daemon() {
  const state = {outputs_enabled: true, devices: [{model: 'SidePulse Pro', connection: 'drive', target}]};
  const writes = [];
  const options = {inspect: async () => {}, read: async () => 'brightness 123\n#0000ff', command: async command => {
    if (command.type === 'get_state') return state;
    writes.push(command);
    return {ok: true};
  }};
  return {state, writes, options};
}
function bounded(window) {
  assert(window.duration > 0 && window.duration <= 1200);
  assert(Buffer.byteLength(window.program) <= 512);
  assert(window.program.endsWith('\noff'));
}
function frameColors(line) {
  const base = /^(#[0-9a-f]{6})/.exec(line)?.[1] || '#000000';
  const colors = Array(8).fill(base);
  for (const match of line.matchAll(/(\d):(#\w{6})/g)) colors[Number(match[1])] = match[2];
  return colors;
}

test('speech illuminates mirrored center pairs, follows silence, and bounds every program', () => {
  const speech = clip();
  const first = frameColors(speechProgram(speech, 0).program.split('\n')[1]);
  assert.deepEqual(first.slice(0, 4), first.slice(4).reverse());
  assert.equal(first.filter(color => color !== '#000000').length, 2);
  assert.equal(frameColors(speechProgram(speech, 300).program.split('\n')[1]).filter(color => color !== '#000000').length, 8);
  const silence = {...speech, levels: Array(80).fill(0)};
  assert.deepEqual(frameColors(speechProgram(silence, 300).program.split('\n')[1]), Array(8).fill('#000000'));
  for (let position = 0; position < speech.durationMs;) {
    const window = speechProgram(speech, position, 123);
    bounded(window);
    assert(window.program.startsWith('brightness 123\n'));
    position += window.duration;
    assert(position <= speech.durationMs);
  }
  assert.equal(speechProgram(speech, 2000), null);
  assert.equal(speechProgram(speech, NaN), null);
});

test('idle bounces at strip ends and thinking changes bounded partial masks', () => {
  const sweep = idleSweepProgram(840);
  bounded(sweep);
  assert.deepEqual([...sweep.program.matchAll(/(\d):#ff0000/g)].map(match => Number(match[1])), [7,6,5,4,3,2,1,0]);
  const thinking = thinkingProgram(123, () => 0.5);
  bounded(thinking);
  const frames = thinking.program.split('\n').slice(1, -1);
  frames.forEach((frame, index) => {
    const lit = [...frame.matchAll(/\d:#ff0000/g)];
    assert(lit.length > 0 && lit.length < 8);
    if (index) assert.notEqual(frame, frames[index - 1]);
  });
});

test('disabling companion output during a session clears ownership without visible restoration', async () => {
  const fake = daemon();
  let now = 1000;
  const lights = new SidePulseVoice({enabled: true, now: () => now, connect: () => connectSidePulse(fake.options)});
  await lights.update(clip(), {hold: true});
  assert.equal(lights.status().mode, 'speech');
  fake.state.outputs_enabled = false;
  now += 1000;
  await lights.update(clip(now), {hold: true});
  assert.deepEqual(fake.writes.at(-1), {type: 'write_led', target, program: 'off', hold_seconds: 0});
  assert.equal(lights.status().mode, 'output-disabled');
  await lights.update(null);
  assert.equal(fake.writes.length, 2);
});

test('release also checks the output toggle before restoring a saved display', async () => {
  const fake = daemon();
  const lights = new SidePulseVoice({enabled: true, connect: () => connectSidePulse(fake.options)});
  await lights.update(null, {idle: true});
  fake.state.outputs_enabled = false;
  await lights.update(null);
  assert.equal(fake.writes.at(-1).program, 'off');
  assert.equal(fake.writes.at(-1).hold_seconds, 0);
});

test('discovery and every write reject ambiguous, replaced, missing and oversized device files', async () => {
  const fake = daemon();
  fake.state.devices.push({...fake.state.devices[0]});
  assert.equal(await connectSidePulse(fake.options), null);
  fake.state.devices.pop();
  const connection = await connectSidePulse(fake.options);
  fake.state.devices[0].target = path.resolve('different-device', 'LED.txt');
  await assert.rejects(connection.write('off', 0));
  assert.equal(fake.writes.length, 0);
  await assert.rejects(connectSidePulse({...fake.options, inspect: async () => { throw Error('missing'); }}));
  await assert.rejects(connectSidePulse({...fake.options, read: async () => 'a'.repeat(513)}));
});

test('stop during discovery never lights the device', async () => {
  let resolveConnection;
  const writes = [];
  const lights = new SidePulseVoice({enabled: true, connect: () => new Promise(resolve => { resolveConnection = resolve; })});
  const pending = lights.update(null, {idle: true});
  await new Promise(resolve => setImmediate(resolve));
  lights.update(null);
  resolveConnection({previous: 'off', brightness: 100, write: async (...args) => { writes.push(args); }});
  await pending;
  assert.equal(writes.length, 0);
  assert.equal(lights.status().mode, 'released');
});

test('serialized writes coalesce to the newest state and restore brightness on final stop', async () => {
  let releaseWrite, calls = 0, active = 0, maxActive = 0;
  const writes = [];
  const lights = new SidePulseVoice({enabled: true, now: () => 1000, connect: async () => ({previous: 'brightness 123\n#0000ff', brightness: 123, write: async (program, hold) => {
    active++; maxActive = Math.max(maxActive, active); calls++; writes.push({program, hold});
    if (calls === 1) await new Promise(resolve => { releaseWrite = resolve; });
    active--;
  }})});
  const first = lights.update(clip());
  await new Promise(resolve => setImmediate(resolve));
  lights.update(null, {thinking: true});
  lights.update(null, {idle: true});
  lights.update(null);
  releaseWrite();
  await first;
  assert.equal(maxActive, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], {program: 'brightness 123\n#0000ff', hold: 0});
});

test('optional hardware failures redact diagnostics and recover after a bounded retry', async () => {
  let now = 1000, connections = 0;
  const lights = new SidePulseVoice({enabled: true, now: () => now, connect: async () => {
    connections++;
    if (connections === 1) throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC');
    return {brightness: 99, previous: 'off', write: async () => true};
  }});
  await lights.update(null, {idle: true});
  assert(!JSON.stringify(lights.status()).includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
  await lights.update(null, {idle: true});
  assert.equal(connections, 1);
  now += 2000;
  await lights.update(null, {idle: true});
  assert.equal(lights.status().mode, 'idle');
  const disabled = new SidePulseVoice({enabled: false, connect: () => assert.fail('must opt in')});
  await disabled.update(clip());
  assert.equal(disabled.status().mode, 'disabled');
});
