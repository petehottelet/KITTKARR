import path from 'node:path';
export function validateBackup(manifest, root, home) {
  const base = path.resolve(root,'.kitt-state/backups');
  const relative = typeof manifest.backup === 'string' ? path.relative(base,path.resolve(manifest.backup)) : '..';
  if (manifest.version !== 1 || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      manifest.collector !== path.join(home,'Library/Application Support/CarThingCollector') ||
      manifest.agent !== path.join(home,'Library/LaunchAgents/com.carthing.kitt.plist') ||
      !/^[a-zA-Z0-9._:-]+$/.test(manifest.serial || '')) throw Error('Unknown install backup.');
  return manifest;
}
