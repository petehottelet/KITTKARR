// Voice services are explicitly configured on the host; no vendor is selected by default.
export const maxCharacters = 1000;
export class SpeechError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function speechConfig(env = process.env) {
  const provider = (env.TTS_PROVIDER || 'system').trim();
  if (!['system', 'openai-compatible', 'http'].includes(provider)) throw new SpeechError(500, 'Choose system, openai-compatible, or http for TTS_PROVIDER.');
  const endpoint = (env.TTS_ENDPOINT || '').trim();
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new SpeechError(500, 'TTS_ENDPOINT must be an absolute URL.'); }
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new SpeechError(500, 'Use a speech endpoint without credentials, query parameters, or fragments.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new SpeechError(500, 'Remote speech endpoints require HTTPS.');
  }
  return {provider, endpoint, apiKey: (env.TTS_API_KEY || '').trim(), voiceId: (env.TTS_VOICE || '').trim(), modelId: (env.TTS_MODEL || '').trim(), available: provider !== 'system' && Boolean(endpoint)};
}
export function voiceSettings(env = process.env) {
  let settings;
  try { settings = JSON.parse(env.TTS_OPTIONS || '{}'); } catch { throw new SpeechError(500, 'TTS_OPTIONS must be a JSON object.'); }
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new SpeechError(500, 'TTS_OPTIONS must be a JSON object.');
  return settings;
}
export function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new SpeechError(400, 'Type something for the voice to say.');
  if (text.length > maxCharacters) throw new SpeechError(400, `Keep the text under ${maxCharacters} characters.`);
  return text.trim();
}
export async function providerError(response) {
  await response.body?.cancel().catch(() => {});
  return new SpeechError(response.status === 429 ? 503 : 502,
    [401, 403].includes(response.status) ? 'The voice service rejected its credentials.' : 'The voice service could not generate speech.');
}
export async function streamSpeech(text, {env = process.env, fetch = globalThis.fetch, timeout = 55000, signal} = {}) {
  const config = speechConfig(env), input = validateText(text);
  if (!config.available) throw new SpeechError(503, 'Configure TTS_PROVIDER and TTS_ENDPOINT to use an HTTP voice service.');
  const options = voiceSettings(env);
  const body = config.provider === 'openai-compatible'
    ? {...options, input, ...(config.modelId ? {model: config.modelId} : {}), ...(config.voiceId ? {voice: config.voiceId} : {}), response_format: 'mp3'}
    : {...options, text: input, ...(config.modelId ? {model: config.modelId} : {}), ...(config.voiceId ? {voice: config.voiceId} : {})};
  let response;
  try {
    response = await fetch(config.endpoint, {
      method: 'POST', redirect: 'error',
      headers: {'Content-Type': 'application/json', Accept: 'audio/mpeg, audio/wav', ...(config.apiKey ? {Authorization: `Bearer ${config.apiKey}`} : {})},
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
    });
  } catch {
    throw new SpeechError(signal?.aborted ? 499 : 504, signal?.aborted ? 'Speech generation stopped.' : 'The voice service could not be reached.');
  }
  if (!response.ok) throw await providerError(response);
  if (!response.body || !/^audio\/(mpeg|mp3|wav|x-wav|wave)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel().catch(() => {});
    throw new SpeechError(502, 'The voice service must return MP3 or WAV audio directly.');
  }
  const reader = response.body.getReader(); let bytes = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const {done, value} = await reader.read();
        if (done) { if (!bytes) throw new Error(); controller.close(); return; }
        bytes += value.byteLength;
        if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
        controller.enqueue(value);
      } catch { controller.error(new SpeechError(502, 'Voice audio was interrupted or exceeded the size limit.')); }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  stream.contentType = /wav|wave/i.test(response.headers.get('content-type')) ? 'audio/wav' : 'audio/mpeg';
  return stream;
}
export function isTrustedRequest(headers, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return hosts.includes(headers.host) && headers['sec-fetch-site'] !== 'cross-site' &&
    hosts.some(host => headers.origin === `http://${host}`) && /^application\/json\b/i.test(headers['content-type'] || '');
}
