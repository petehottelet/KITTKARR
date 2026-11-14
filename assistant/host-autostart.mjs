import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
export async function startInstalledHost({platform = process.platform, uid = () => process.getuid(), home = os.homedir(), run = exec, exists = access} = {}) {
  if (platform !== 'darwin') throw Error('Host auto-start requires macOS. Start the host on your Mac.');
  const domain = `gui/${uid()}`, label = 'com.carthing.kitt';
  const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    try { await run('/bin/launchctl', ['print', `${domain}/${label}`], {timeout: 5000}); }
    catch {
      try { await exists(plist); } catch { throw Error('not-installed'); }
      await run('/bin/launchctl', ['bootstrap', domain, plist], {timeout: 10000});
    }
    // No -k: never terminate an existing host or its active conversation.
    await run('/bin/launchctl', ['kickstart', `${domain}/${label}`], {timeout: 10000});
  } catch { throw Error('The installed KITT host could not start. Install it with npm run host:install, or run npm start manually.'); }
}
