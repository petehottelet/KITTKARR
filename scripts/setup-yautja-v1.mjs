// Revision 2. Install the renderer and native local mask helper for live Yautja.
import {access} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),environment=path.join(root,'.kitt-state/yautja-venv'),python=path.join(environment,'bin/python');
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`${command} exited ${code}`)));});
if(!process.env.YAUTJA_PACKAGE)throw Error('Set YAUTJA_PACKAGE to a trusted local renderer package. See docs/OPTIONAL.md.');
try{await access(python)}catch{await run(process.env.YAUTJA_PYTHON||'python3',['-m','venv',environment])}
await run(python,['-m','pip','install','-r',path.join(root,'requirements-yautja-v1.txt')]);
await run(python,['-m','pip','install',process.env.YAUTJA_PACKAGE]);
await run(python,['-m','yautja','--version']);
await run(python,['-m','yautja','--doctor','--thermal','luminance']);
await run(process.execPath,[path.join(root,'scripts/build-yautja-segmenter-v1.mjs')]);
