import {personaInstructions} from './persona-v1.mjs';
import {clockAnswer} from './clock-answer-v1.mjs';

// Optional chat-completions adapter. Voice output and voice input are configured separately.
export class ChatAssistant {
  constructor({fetch: fetchImpl = globalThis.fetch, env = process.env} = {}) {
    this.fetch = fetchImpl; this.env = env; this.model = env.CHAT_MODEL || ''; this.history = [];
  }
  async initialize() { return [{name: 'Configured chat service', available: Boolean(this.env.CHAT_ENDPOINT && this.model)}]; }
  async ask(text, {michaelMode = false} = {}) {
    const clock = clockAnswer(text, {michaelMode}); if (clock) return clock;
    if (!this.env.CHAT_ENDPOINT || !this.model) return 'Voice and display are ready. Configure a chat endpoint and model for conversation, or ask me the time.';
    const url = new URL(this.env.CHAT_ENDPOINT);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('Use an HTTPS chat endpoint, or HTTP on localhost, without embedded credentials.');
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(90000)]);
    let response;
    try {
      response = await this.fetch(url, {method:'POST', redirect:'error', signal,
        headers:{'Content-Type':'application/json', ...(this.env.CHAT_API_KEY ? {Authorization:`Bearer ${this.env.CHAT_API_KEY}`} : {})},
        body:JSON.stringify({model:this.model, messages:[{role:'system',content:`${personaInstructions(michaelMode)} Keep answers concise. You have no tools, live data, or connected accounts. Do not claim actions or reminders were performed.`},...this.history,{role:'user',content:text}]})});
    } catch { throw Error('The chat service could not be reached or the request stopped.'); }
    if (!response.ok) { await response.body?.cancel(); throw Error('The chat service rejected the request. Check its configuration.'); }
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw Error(); chunks.push(value); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const answer = data.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw Error();
      const bounded = answer.trim().slice(0,4000);
      this.history.push({role:'user',content:text},{role:'assistant',content:bounded}); this.history = this.history.slice(-8);
      return bounded;
    } catch { throw Error('The chat service returned an unreadable or oversized answer.'); }
    finally { await reader.cancel().catch(() => {}); }
  }
  cancel() { this.controller?.abort(); }
  close() { this.cancel(); this.history = []; }
}
