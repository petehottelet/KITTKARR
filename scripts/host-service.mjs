import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdir, rename, rm, access} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostMode} from '../assistant/host-mode.mjs';
import {readConfiguration} from './setup-config.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const label = 'com.carthing.kitt';
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const hash = value => createHash('sha256').update(value).digest('hex');
async function optional(file) { try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function atomic(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, value, {flag: 'wx', mode: 0o600}); await rename(temporary, file); }
  finally { await rm(temporary, {force: true}); }
}

export function hostPlist({root, node = process.execPath, deploy = false}) {
  const executable = path.join(root, '.kitt-state/KITT.app/Contents/MacOS/KITT');
  const searchPath = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  // Hardware mode and device selection are loaded from .env on every start.
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string><key>KITT_DEPLOY_UI</key><string>${deploy ? '1' : '0'}</string></dict>
<key>ProcessType</key><string>Interactive</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(root, '.kitt-state/host.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(root, '.kitt-state/host-error.log'))}</string></dict></plist>`;
}

export async function buildHostHelpers({root = project, run = exec} = {}) {
  try { await run('/usr/bin/xcrun', ['--find', 'swiftc'], {timeout: 5000}); }
  catch { throw Error('Install Apple command-line tools with xcode-select --install, then run npm run host:install again.'); }
  try {
    await run(process.execPath, [path.join(root, 'scripts/build-mac-host-v1.mjs')], {timeout: 120000});
    await run(process.execPath, [path.join(root, 'scripts/build-mac-player-v1.mjs')], {timeout: 120000});
  } catch { throw Error('The Mac helpers could not build. Check Apple command-line tools, then retry host:install.'); }
}

export async function installHost({root = project, home = os.homedir(), platform = process.platform, uid = () => process.getuid(), run = exec, env = process.env, deploy, build = true} = {}) {
  if (platform !== 'darwin') throw Error('The KITT host service requires macOS.');
  const config = (await readConfiguration(root, env)).env;
  hostMode(config);
  const agent = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  const state = path.join(root, '.kitt-state');
  const manifestFile = path.join(state, 'host-service.json');
  const previous = await optional(agent);
  if (previous && !previous.includes(`<key>WorkingDirectory</key><string>${xml(root)}</string>`)) throw Error('A KITT service from another installation already exists. Remove it from that installation before continuing.');
  if (build) await buildHostHelpers({root, run});
  else { await access(path.join(state, 'KITT.app/Contents/MacOS/KITT')); await access(path.join(state, 'mac-player-v1')); }
  await mkdir(state, {recursive: true, mode: 0o700});
  await mkdir(path.dirname(agent), {recursive: true});
  const oldManifest = await optional(manifestFile);
  let manifest;
  try { manifest = oldManifest ? JSON.parse(oldManifest) : {version: 1, previous}; }
  catch { throw Error('The service installation record is unreadable. Restore it before reinstalling.'); }
  if (manifest.version !== 1) throw Error('The service installation record is unsupported.');
  const plist = hostPlist({root, deploy: deploy ?? Boolean(await optional(path.join(state, 'install-v1.json')))});
  const domain = `gui/${uid()}`;
  // Back up before replacing; only this checkout's service may be restarted.
  await atomic(manifestFile, JSON.stringify({...manifest, installed: false, pending: true}));
  let registered = false;
  try {
    if (previous) await run('/bin/launchctl', ['bootout', `${domain}/${label}`], {timeout: 10000}).catch(() => {});
    await atomic(agent, plist);
    await run('/bin/launchctl', ['bootstrap', domain, agent], {timeout: 15000});
    registered = true;
    await atomic(manifestFile, JSON.stringify({...manifest, installed: true, pending: false, hash: hash(plist)}));
  } catch {
    if (registered) await run('/bin/launchctl', ['bootout', `${domain}/${label}`], {timeout: 10000}).catch(() => {});
    if (previous) {
      await atomic(agent, previous);
      await run('/bin/launchctl', ['bootstrap', domain, agent], {timeout: 15000}).catch(() => {});
    } else await rm(agent, {force: true});
    if (oldManifest) await atomic(manifestFile, oldManifest); else await rm(manifestFile, {force: true});
    throw Error('The KITT service could not start. The preceding service configuration was restored.');
  }
}

export async function uninstallHost({root = project, home = os.homedir(), platform = process.platform, uid = () => process.getuid(), run = exec} = {}) {
  if (platform !== 'darwin') throw Error('The KITT host service requires macOS.');
  const state = path.join(root, '.kitt-state');
  if (await optional(path.join(state, 'install-v1.json'))) throw Error('This installation also manages a Car Thing dashboard. Use npm run device:restore first.');
  const agent = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  const file = path.join(state, 'host-service.json');
  let manifest;
  try { manifest = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw Error('No managed host installation was found.'); }
  const current = await optional(agent);
  if (manifest.version !== 1 || !manifest.installed || !current || hash(current) !== manifest.hash) throw Error('The installed service has changed. It was preserved; uninstall it from its owning installation.');
  const domain = `gui/${uid()}`;
  await run('/bin/launchctl', ['bootout', `${domain}/${label}`], {timeout: 10000}).catch(() => {});
  if (manifest.previous) {
    await atomic(agent, manifest.previous);
    await run('/bin/launchctl', ['bootstrap', domain, agent], {timeout: 15000});
  } else await rm(agent);
  await atomic(file, JSON.stringify({...manifest, installed: false}));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'uninstall') { await uninstallHost(); console.log('KITT login service removed. Private settings and models were retained.'); }
    else if (!process.argv[2] || process.argv[2] === 'install') { await installHost(); console.log('KITT starts at login. Allow KITT microphone access if prompted, then run npm start to open it.'); }
    else throw Error('Use install or uninstall.');
  } catch (error) { console.error(error.code ? 'The service files could not be accessed. Nothing should be shared from private state.' : error.message); process.exitCode = 1; }
}
