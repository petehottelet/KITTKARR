// Revision 1. Compile the native local mask helper using the installed macOS SDK.
import {mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'.kitt-state');
await mkdir(directory,{recursive:true,mode:0o700});
await promisify(execFile)('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',path.join(directory,'swift-module-cache'),path.join(root,'assistant/yautja-segmenter-v1.swift'),'-o',path.join(directory,'yautja-segmenter-v1')],{timeout:120000});
console.log('Built the local Yautja person-mask helper.');
