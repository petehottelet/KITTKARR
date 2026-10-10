import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseByteRange } from './media-range.mjs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SpeechError, isTrustedRequest, speechConfig, streamSpeech, voiceSettings } from './speech.mjs';
import { isSignedIn, loginConfig, signInHeaders } from './auth.cjs';

const root = fileURLToPath(new URL('.', import.meta.url));
// Optional local settings, such as the voice service key and voice. Variables already set in the shell take precedence.
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* No .env file. */ }
const port = Number(process.env.PORT || 4173);
// The local preview asks for a sign-in only when KITT_LOGIN_USERNAME and KITT_LOGIN_PASSWORD are set.
const login = loginConfig();
const types = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg' };
const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'signal.js', 'assets/icon.png', 'assets/fonts/michroma.ttf']);
const maxBodyBytes = 16 * 1024;

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new SpeechError(413, 'Keep the text shorter.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SpeechError(400, 'The request could not be read.'); }
}

async function handleSpeech(request, response) {
  if (request.method === 'GET') { sendJson(response, 200, { available: speechConfig().available }); return; }
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Method not allowed.' }); return; }
  if (!isTrustedRequest(request.headers, port)) { sendJson(response, 403, { error: 'Speech generation is only available from this local preview.' }); return; }
  try {
    const { text } = await readJson(request);
    const audio = await streamSpeech(text);
    // Forward audio as it arrives so playback can start before generation finishes.
    response.writeHead(200, { 'Content-Type': audio.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    await pipeline(Readable.fromWeb(audio), response);
  } catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    const status = error instanceof SpeechError ? error.status : 500;
    const message = error instanceof SpeechError ? error.message : 'Speech could not be generated.';
    if (status >= 500) console.error(`Speech generation failed: ${message}`);
    sendJson(response, status, { error: message });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (login && !isSignedIn(request.headers.authorization, login)) {
      response.writeHead(401, signInHeaders);
      response.end('Sign in to use K.I.T.T.');
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/api/speech') { await handleSpeech(request, response); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!publicFiles.has(relative) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }
    const body = await readFile(path.join(root, relative));
    const headers = { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Length': body.length };
    const range = request.method === 'GET' ? parseByteRange(request.headers.range, body.length) : undefined;
    if (range === null) {
      response.writeHead(416, { 'Content-Range': `bytes */${body.length}`, 'Content-Length': 0 });
      response.end();
      return;
    }
    if (range) {
      const slice = body.subarray(range.start, range.end + 1);
      response.writeHead(206, { ...headers, 'Content-Length': slice.length, 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}` });
      response.end(slice);
      return;
    }
    response.writeHead(200, headers);
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
  }
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? 'The preview port is already in use. Set PORT to a different port and try again.' : 'The local preview could not start.');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`K.I.T.T. is ready at http://127.0.0.1:${port}`);
  if (login) console.log('Sign-in is on.');
  console.log(speechConfig().available ? 'voice service speech generation is on.' : 'voice service speech generation is off. Set TTS_PROVIDER and TTS_ENDPOINT in .env to turn it on.');
  try { voiceSettings(); } catch (error) { console.error(error.message); }
});
