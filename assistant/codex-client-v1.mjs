// Revision 4. Keep speech and optional external-bridge credentials out of the Codex process.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexClient extends EventEmitter {
  constructor({ command = process.env.KITT_CODEX_COMMAND || 'codex', args = [], apps = true, cwd = process.cwd(), spawnProcess = spawn } = {}) {
    super();
    this.command = command; this.args = args; this.apps = apps; this.cwd = cwd; this.spawnProcess = spawnProcess;
    this.sequence = 0; this.pending = new Map(); this.child = null; this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.open().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }
  async open() {
    const env={...process.env};
    for(const key of Object.keys(env))if(key.startsWith('TTS_')||key.startsWith('CHAT_')||key.startsWith('KITT_GROKBOT_')||key==='OPENAI_API_KEY'||key==='OPENAI_TRANSCRIPTION_MODEL')delete env[key];
    const child = this.spawnProcess(this.command, ['app-server', this.apps ? '--enable' : '--disable', 'apps', '--listen', 'stdio://', ...this.args], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr.on('data', () => {}); // Provider diagnostics can contain private context.
    child.on('error', () => this.fail(new Error('Codex could not start. Check KITT_CODEX_COMMAND.')));
    child.on('exit', () => { if (this.child === child) this.fail(new Error('The Codex connection closed. Try again.')); });
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else if (this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer); this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || 'Codex request failed.'));
        else resolve(message.result);
      }
    });
    await this.request('initialize', { clientInfo: { name: 'kitt_carthing', title: 'K.I.T.T. Car Thing', version: '2.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear(); this.child = null; this.starting = null; this.emit('disconnected', error);
  }
  close() { const child = this.child; this.fail(new Error('Codex closed.')); child?.kill(); }
}
