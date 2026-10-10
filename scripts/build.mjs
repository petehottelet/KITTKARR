
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeFiles = ['index.html', 'styles.css', 'app.js', 'signal.js', 'assets/icon.svg', 'assets/fonts/michroma.ttf', 'assets/fonts/OFL.txt'];
for (const file of runtimeFiles) {
  const destination = path.join(root, 'dist', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, file), destination);
}
console.log(`Built ${runtimeFiles.length} application assets.`);
