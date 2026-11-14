import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import ignore from 'ignore';

test('private reference directories are ignored at every depth and excluded from syntax checks', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const rules = ignore().add(await readFile(path.join(root, '.gitignore'), 'utf8'));
  for (const file of ['00_project_files/example.js', 'nested/00_project_files/example.js']) assert(rules.ignores(file));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kitt-private-check-'));
  try {
    for (const folder of ['00_project_files', 'nested/00_project_files']) {
      await mkdir(path.join(directory, folder), {recursive: true});
      await writeFile(path.join(directory, folder, 'invalid.js'), 'invalid JavaScript {');
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], {cwd: directory, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    await writeFile(path.join(directory, 'invalid.js'), 'invalid JavaScript {');
    const publicResult = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], {cwd: directory, encoding: 'utf8'});
    assert.notEqual(publicResult.status, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
