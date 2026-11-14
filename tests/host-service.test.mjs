import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installHost, uninstallHost, hostPlist} from '../scripts/host-service.mjs';
import {saveHardware} from '../scripts/setup-config.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kitt-host-service-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const home = path.join(root, 'example-home');
  const agent = path.join(home, 'Library/LaunchAgents/com.carthing.kitt.plist');
  await mkdir(path.dirname(agent), {recursive: true});
  await saveHardware(root, 'sidepulse');
  const calls = [];
  const options = {root, home, env: {}, platform: 'darwin', uid: () => 501, run: async (command, args) => { calls.push({command, args}); }};
  return {root, agent, calls, options};
}

test('standalone service installs without ADB and hardware remains configurable on restart', async t => {
  const f = await fixture(t); await installHost(f.options);
  const plist = await readFile(f.agent, 'utf8');
  assert(plist.includes('KITT.app')); assert(plist.includes('<key>RunAtLoad</key><true/>'));
  assert(!plist.includes('KITT_MODE')); assert(!plist.includes('KITT_ADB_SERIAL')); assert(!plist.includes('TTS_API_KEY'));
  assert(!f.calls.some(call => call.command === 'adb'));
  assert(f.calls.some(call => call.args[0] === 'bootstrap'));
  await uninstallHost(f.options); await assert.rejects(access(f.agent));
  assert.equal((await readFile(path.join(f.root, '.env'), 'utf8')).includes('KITT_SIDEPULSE=1'), true);
});

test('service installation preserves another checkout and leaves it running', async t => {
  const f = await fixture(t), previous = hostPlist({root: path.join(f.root, 'different-project')});
  await writeFile(f.agent, previous);
  await assert.rejects(installHost(f.options), /another installation/);
  assert.equal(await readFile(f.agent, 'utf8'), previous); assert.equal(f.calls.length, 0);
});

test('failed service registration restores the prior file and service', async t => {
  const f = await fixture(t), previous = hostPlist({root: f.root, deploy: true}); await writeFile(f.agent, previous);
  let starts = 0;
  const run = async (command, args) => { f.calls.push({command, args}); if (args[0] === 'bootstrap' && ++starts === 1) throw Error('EXAMPLE_PRIVATE_DIAGNOSTIC'); };
  await assert.rejects(installHost({...f.options, run}), error => error.message.includes('restored') && !error.message.includes('EXAMPLE_PRIVATE_DIAGNOSTIC'));
  assert.equal(await readFile(f.agent, 'utf8'), previous); assert.equal(starts, 2);
});

test('reinstall retains the first backup; uninstall refuses changed services and active dashboard ownership', async t => {
  const f = await fixture(t), previous = hostPlist({root: f.root, deploy: true}); await writeFile(f.agent, previous);
  await installHost(f.options); await installHost(f.options);
  const manifest = JSON.parse(await readFile(path.join(f.root, '.kitt-state/host-service.json'), 'utf8')); assert.equal(manifest.previous, previous);
  const installed = await readFile(f.agent, 'utf8'); await writeFile(f.agent, installed + '\n<!-- changed -->');
  await assert.rejects(uninstallHost(f.options), /has changed/);
  await writeFile(f.agent, installed); await writeFile(path.join(f.root, '.kitt-state/install-v1.json'), '{}');
  await assert.rejects(uninstallHost(f.options), /device:restore/);
  await rm(path.join(f.root, '.kitt-state/install-v1.json'));
  await uninstallHost(f.options); assert.equal(await readFile(f.agent, 'utf8'), previous);
});
