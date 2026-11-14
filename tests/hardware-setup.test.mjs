import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {parseEnv} from 'node:util';
import {saveHardware, selectedHardware} from '../scripts/setup-config.mjs';
import {runSetup} from '../scripts/setup.mjs';
import {findCarThings, checkHardware} from '../scripts/hardware-check.mjs';
import {testLeds} from '../scripts/sidepulse-test.mjs';

async function workspace(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'kitt-setup-')); t.after(() => rm(root, {recursive: true, force: true})); return root; }

test('all hardware choices round-trip, including switching both to SidePulse without losing provider settings', async t => {
  const root = await workspace(t);
  const original = '# Existing preferences\nCHAT_MODEL="example model"\nTTS_PROVIDER=http\nTTS_OPTIONS=\'{\n"speed": 1.1\n}\'\n# Keep this comment\n';
  await writeFile(path.join(root, '.env'), original);
  for (const [choice, mode, leds, input] of [['carthing','carthing','0','auto'],['both','carthing','1','auto'],['sidepulse','browser','1','mac'],['browser','browser','0','mac']]) {
    const env = await saveHardware(root, choice, 'EXAMPLE_DEVICE');
    assert.equal(selectedHardware(env), choice); assert.equal(env.KITT_MODE, mode); assert.equal(env.KITT_SIDEPULSE, leds); assert.equal(env.KITT_INPUT_SOURCE, input);
    assert.equal(env.TTS_PROVIDER, 'http'); assert.equal(env.CHAT_MODEL, 'example model'); assert.equal(JSON.parse(env.TTS_OPTIONS).speed, 1.1);
    const source = await readFile(path.join(root, '.env'), 'utf8'); assert(source.startsWith(original)); assert.deepEqual(parseEnv(source), env);
    await saveHardware(root, choice, 'EXAMPLE_DEVICE'); assert.equal(await readFile(path.join(root, '.env'), 'utf8'), source, 'Unchanged setup does not append duplicates');
  }
  await assert.rejects(saveHardware(root, 'both', 'bad\nSERIAL'), /authorized/);
});

test('SidePulse setup works without ADB or a Car Thing and offers the standalone host service', async t => {
  const root = await workspace(t), logs = []; let registrations = 0;
  await runSetup({directory: root, platform: 'darwin', choice: 'sidepulse', question: async () => 'yes', log: text => logs.push(text), discover: () => assert.fail('No ADB'), execute: () => assert.fail('No dashboard install'), check: async ({env}) => { assert.equal(env.KITT_MODE, 'browser'); return [{name: 'SidePulse', ok: true, message: 'Ready'}]; }, register: async ({env}) => { registrations++; assert.equal(env.KITT_SIDEPULSE, '1'); }});
  assert.equal(registrations, 1); assert(logs.some(text => text.includes('Test LEDs')));
});

test('both setup enables both outputs and installs the dashboard once', async t => {
  const root = await workspace(t), calls = [];
  const result = await runSetup({directory: root, platform: 'darwin', choice: 'both', question: async () => 'y', log() {}, discover: async () => ['EXAMPLE_DEVICE'], check: async () => [{name: 'SidePulse', ok: false, message: 'Connect later.'}], register: () => assert.fail('Device installer owns host registration'), execute: async (_command, args) => calls.push(args)});
  assert.equal(result.env.KITT_MODE, 'carthing'); assert.equal(result.env.KITT_SIDEPULSE, '1');
  assert.equal(calls.filter(args => args[0].endsWith('install-device-v1.mjs')).length, 1);
  assert(calls.some(args => args.includes('--noEmit')));
});

test('setup saves a recoverable disconnected SidePulse selection without installing or invoking providers', async t => {
  const root = await workspace(t), logs = [];
  const result = await runSetup({directory: root, platform: 'darwin', choice: 'sidepulse', install: false, log: text => logs.push(text), question: () => assert.fail('No installation prompt'), discover: () => assert.fail(), register: () => assert.fail(), check: async () => [{name: 'SidePulse', ok: false, message: 'Connect the device.'}]});
  assert.equal(result.env.KITT_SIDEPULSE, '1'); assert(logs.some(text => text.includes('Connect the device.')));
});

test('Car Thing discovery filters unrelated devices and hardware checks use only selected integrations', async () => {
  const run = async (_command, args) => {
    if (args[0] === 'devices') return {stdout: 'List of devices attached\nEXAMPLE_PHONE\tdevice\nEXAMPLE_DEVICE\tdevice\nEXAMPLE_LOCKED\tunauthorized\n'};
    if (args[1] === 'EXAMPLE_PHONE') throw Error('not compatible');
    return {stdout: 'KITT_DEVICE_OK'};
  };
  assert.deepEqual(await findCarThings({env: {}, run}), ['EXAMPLE_DEVICE']);
  let probes = 0;
  const checks = await checkHardware({env: {KITT_MODE: 'browser', KITT_SIDEPULSE: '1'}, run: async (_command, args) => { assert.equal(args[0], '-version'); }, sidePulse: async () => { probes++; return {ready: true, message: 'Ready'}; }, exists: () => assert.fail('No collector needed')});
  assert.equal(probes, 1); assert(checks.every(item => item.ok));
  await checkHardware({env: {KITT_MODE: 'carthing', KITT_ADB_SERIAL: 'EXAMPLE_DEVICE'}, run, exists: async () => {}, sidePulse: () => assert.fail('No LEDs selected')});
});

test('LED tests use the running host and only fall back to direct testing when its connection is refused', async () => {
  const env = {KITT_SIDEPULSE: '1'}; let previews = 0;
  const deps = {probe: async () => ({ready: true}), preview: async () => { previews++; }};
  await testLeds(env, {...deps, request: async (_url, options) => { assert.equal(options.headers['X-KITT-Intent'], '1'); return new Response('{}'); }});
  assert.equal(previews, 0);
  await testLeds(env, {...deps, request: async () => { throw Error('offline', {cause: {code: 'ECONNREFUSED'}}); }});
  assert.equal(previews, 1);
  await assert.rejects(testLeds(env, {...deps, request: async () => new Response('{}', {status: 403})}), /could not test/);
  await assert.rejects(testLeds(env, {...deps, request: async () => { throw Error('timeout'); }}), /did not answer/);
  assert.equal(previews, 1);
});
