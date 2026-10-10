export function hostMode(env = process.env) {
  const mode = env.KITT_MODE || 'browser';
  if (!['browser', 'carthing'].includes(mode)) throw Error('KITT_MODE must be browser or carthing.');
  if (mode === 'carthing' && !/^[a-zA-Z0-9._:-]+$/.test(env.KITT_ADB_SERIAL || '')) throw Error('Set KITT_ADB_SERIAL to the device shown by adb devices.');
  return mode;
}
export class BrowserBridge {
  constructor({onChange = () => {}} = {}) { this.onChange = onChange; }
  start() { this.onChange({connected:true, mode:'browser'}); }
  stop() {}
}
