// Revision 1. Durable reminders are local to this app; saved before confirmation.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Reminders {
  constructor(directory, { now = Date.now } = {}) { this.file = path.join(directory, 'reminders-v1.json'); this.now = now; this.items = []; this.queue = Promise.resolve(); }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('Invalid reminder store.');
      this.items = data.items;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  list() { return this.items.filter(r => !r.dismissedAt).sort((a,b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)); }
  change(operation) {
    const next = this.queue.then(async () => {
      const before = structuredClone(this.items);
      try {
        const result = operation();
        await writeFile(`${this.file}.tmp`, JSON.stringify({ version: 1, items: this.items }), { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
        return result;
      } catch (error) { this.items = before; throw error; }
    });
    this.queue = next.catch(() => {}); return next;
  }
  async add({ text, dueAt, sourceUrl = null, requestId = null }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('Use a reminder between 1 and 500 characters.');
    if (typeof dueAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(dueAt)) throw new Error('The reminder time needs an explicit time zone.');
    const due = Date.parse(dueAt);
    if (!Number.isFinite(due) || due <= this.now() || due > this.now() + 366*86400000) throw new Error('Choose a future reminder time within one year.');
    if (sourceUrl && !/^https:\/\//.test(sourceUrl)) throw new Error('Use an HTTPS source link.');
    return this.change(() => {
      const existing = requestId && this.items.find(r => r.requestId === requestId);
      if (existing) return existing;
      if (this.list().length >= 100) throw new Error('Dismiss a reminder before adding more.');
      const reminder = { id: randomUUID(), text: text.trim(), dueAt: new Date(due).toISOString(), sourceUrl, requestId, createdAt: new Date(this.now()).toISOString(), announcedAt: null, dismissedAt: null };
      this.items.push(reminder); return reminder;
    });
  }
  async dismiss(id) { return this.change(() => { const r = this.items.find(r=>r.id===id); if (!r) throw new Error('Reminder not found.'); r.dismissedAt = new Date(this.now()).toISOString(); return r; }); }
  async claimDue() {
    return this.change(() => {
      const due = this.list().filter(r => !r.announcedAt && Date.parse(r.dueAt) <= this.now());
      for (const r of due) r.announcedAt = new Date(this.now()).toISOString();
      return due;
    });
  }
}

export const reminderTools = [
  { type: 'function', name: 'create_reminder', description: 'Save a spoken and on-screen reminder on Driver’s Car Thing. Use only when Driver asks for a reminder. Resolve relative times using the provided current time and the configured host time zone; ask when timing is ambiguous. Confirm only after this tool succeeds.', inputSchema: { type:'object', properties:{ text:{type:'string'}, dueAt:{type:'string',description:'ISO 8601 date/time with explicit UTC offset'}, sourceUrl:{type:['string','null']} },required:['text','dueAt'],additionalProperties:false } },
  { type: 'function', name: 'list_reminders', description:'Read outstanding local Car Thing reminders.', inputSchema:{type:'object',properties:{},additionalProperties:false} },
  { type: 'function', name: 'dismiss_reminder', description:'Dismiss a local reminder only when Driver asks to cancel or dismiss it.', inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false} }
];
