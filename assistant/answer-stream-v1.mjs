import {spokenAnswer} from './spoken-answer-v1.mjs';

export class AnswerSpeechStream {
  constructor(emit) { this.emit = emit; this.sent = ''; this.count = 0; }
  update(raw, {final = false, citations = []} = {}) {
    if (typeof raw !== 'string' || raw.length > 16000) throw Error('The spoken answer exceeded its size limit.');
    // Hold markup until completion: citations and split links can arrive after their text.
    const boundary = raw.search(/[\[\uE200`#]|https?:/i);
    const safe = !final && boundary >= 0 ? raw.slice(0, boundary) : raw;
    const clean = spokenAnswer(safe, {citations}).text.replace(/\s+/g, ' ').trim();
    if (!clean.startsWith(this.sent)) throw Error('The answer changed after speech started.');
    let rest = clean.slice(this.sent.length).trimStart();
    while (rest) {
      const limit = this.count ? 350 : 200;
      let end = 0;
      for (const match of rest.matchAll(/[.!?]["”’']*(?=\s+\S)/g)) {
        const candidate = match.index + match[0].length;
        if (candidate > limit) break;
        if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc)|\b[A-Z])\.$/i.test(rest.slice(0, candidate))) continue;
        end = candidate; break;
      }
      if (!end && rest.length > limit) end = rest.lastIndexOf(' ', limit);
      if (!end && final) end = Math.min(rest.length, limit);
      if (!end) return;
      const phrase = rest.slice(0, end).trim();
      this.emit(phrase); this.count++;
      this.sent = (this.sent + ' ' + phrase).trim();
      rest = rest.slice(end).trimStart();
    }
  }
}

export class SpeechTextQueue {
  constructor() { this.items = []; this.size = 0; this.waiters = []; this.closed = false; }
  push(text) {
    if (this.closed) throw this.error || Error('Speech stopped.');
    if (this.size + text.length > 16000) throw Error('Speech preparation fell behind.');
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({value: text, done: false});
    else { this.items.push(text); this.size += text.length; }
  }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter.resolve({done: true}); }
  cancel(error = Error('Speech stopped.')) { this.error = error; this.items = []; this.size = 0; this.closed = true; for (const waiter of this.waiters.splice(0)) waiter.reject(error); }
  next() {
    if (this.error) return Promise.reject(this.error);
    if (this.items.length) { const value = this.items.shift(); this.size -= value.length; return Promise.resolve({value, done: false}); }
    if (this.closed) return Promise.resolve({done: true});
    return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
  }
  return() { this.cancel(); return Promise.resolve({done: true}); }
  [Symbol.asyncIterator]() { return this; }
}
