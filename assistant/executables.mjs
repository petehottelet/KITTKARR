import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
export async function executableAvailable(command, env = process.env) {
  if (!command) return false;
  const candidates = path.isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [command] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const file of candidates) { try { await access(file, constants.X_OK); return true; } catch {} }
  return false;
}
