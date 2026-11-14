import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existingHost} from '../scripts/start-host.mjs';
import {hostPlist} from '../scripts/host-service.mjs';

const root = 'example-project';
const env = {KITT_MODE: 'browser', KITT_SIDEPULSE: '1'};
const response = () => Response.json({version: 1, hardware: {carThing: false, sidePulse: true}});
const offline = () => { throw Error('offline', {cause: {code: 'ECONNREFUSED'}}); };
test('starting again reuses a compatible host without launching a second process', async () => {
  assert.equal(await existingHost(root, env, {request: response, read: () => assert.fail(), start: () => assert.fail()}), 'http://127.0.0.1:4180');
  await assert.rejects(existingHost(root, {...env, KITT_MODE: 'carthing'}, {request: response, start: () => assert.fail()}), /Hardware settings changed/);
  await assert.rejects(existingHost(root, env, {request: async () => Response.json({unrelated: true}), start: () => assert.fail()}), /occupied/);
});
test('an offline installed host starts once; an absent service allows a foreground host', async () => {
  let starts = 0, requests = 0;
  assert.equal(await existingHost(root, env, {request: async () => { if (requests++ < 2) return offline(); return response(); }, read: async () => hostPlist({root}), start: async () => { starts++; }, wait: async () => {}}), 'http://127.0.0.1:4180');
  assert.equal(starts, 1);
  assert.equal(await existingHost(root, env, {request: offline, read: async () => { throw Object.assign(Error(), {code: 'ENOENT'}); }, start: () => assert.fail()}), null);
  await assert.rejects(existingHost(root, env, {request: offline, read: async () => hostPlist({root: 'another-project'}), start: () => assert.fail()}), /another installation/);
});
