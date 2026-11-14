// Bounded SSE parsing shared by compatible chat and Responses services.
export async function* sseData(response, signal, maxBytes = 2 * 1024 * 1024) {
  if (!response.body) throw Error('The answer stream is empty.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) buffer += decoder.decode();
      else {
        bytes += value.byteLength;
        if (bytes > maxBytes) throw Error('The answer stream exceeded its size limit.');
        buffer += decoder.decode(value, {stream: true});
      }
      if (done && buffer.trim()) buffer += '\n\n';
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
  } finally { signal?.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
}
