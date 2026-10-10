// Revision 1. Build the audio-clock helper separately from the microphone-authorized application.
import {mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'.kitt-state');
await mkdir(directory,{recursive:true,mode:0o700});
await promisify(execFile)('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',path.join(directory,'swift-module-cache'),path.join(root,'assistant/mac-player-v1.swift'),'-o',path.join(directory,'mac-player-v1')],{timeout:120000});
console.log('Built the KITT audio-clock player.');
