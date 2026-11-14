import {parseArgs} from 'node:util';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const {values} = parseArgs({options: {'model-dir': {type: 'string'}, 'reference-audio': {type: 'string'}, 'reference-text-file': {type: 'string'}, speaker: {type: 'string', default: 'ryan'}, help: {type: 'boolean'}}});
  if (values.help) {
    console.log('npm run voice:setup -- --model-dir .kitt-state/models/qwen3 --speaker ryan\nFor a Base model also supply --reference-audio and --reference-text-file.\nThis writes private configuration only. Download a compatible model separately.');
  } else {
    if (!values['model-dir']) throw Error('Supply --model-dir with an existing local Qwen3 model directory.');
    const model_path = path.resolve(values['model-dir']);
    if (!(await stat(model_path)).isDirectory()) throw Error('Choose an existing model directory.');
    const config = {model_path, model: 'qwen-local', voice: 'local', speaker: values.speaker};
    if (values['reference-audio'] || values['reference-text-file']) {
      if (!values['reference-audio'] || !values['reference-text-file']) throw Error('Supply both reference audio and its transcript file.');
      config.reference_audio = path.resolve(values['reference-audio']);
      if (!(await stat(config.reference_audio)).isFile()) throw Error('Choose an existing reference audio file.');
      config.reference_text = (await readFile(path.resolve(values['reference-text-file']), 'utf8')).trim();
      if (!config.reference_text || config.reference_text.length > 4000) throw Error('The reference transcript must contain 1–4,000 characters.');
    }
    await mkdir(path.join(root, '.kitt-state'), {recursive: true, mode: 0o700});
    await writeFile(path.join(root, '.kitt-state', 'local-voice.json'), JSON.stringify(config, null, 2), {flag: 'wx', mode: 0o600});
    console.log('Private local voice configuration created. Start npm run voice:local with the model environment selected, then set TTS_PROVIDER=local for the host.');
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Local voice configuration already exists; edit it privately to change voices.' : error.code ? 'A local model, reference file, or configuration directory could not be accessed.' : error.message);
  process.exitCode = 1;
}
