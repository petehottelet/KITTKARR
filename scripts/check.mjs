import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const excluded = new Set(['.git','node_modules','.kitt-state','dist','output','.venv']);
async function walk(dir) {
  for (const item of await readdir(dir,{withFileTypes:true})) {
    if (excluded.has(item.name)) continue;
    const file = `${dir}/${item.name}`;
    if (item.isDirectory()) await walk(file);
    else if (/\.(mjs|cjs|js)$/.test(item.name)) {
      const result = spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
      if (result.status) process.exit(result.status);
    }
  }
}
await walk('.');
console.log('JavaScript syntax checks passed.');
