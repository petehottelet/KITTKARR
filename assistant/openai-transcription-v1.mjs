// Revision 2. Supply English and proper-name context without prescribing a transcript.
export function transcriptionConfig(env=process.env){
  const apiKey=(env.OPENAI_API_KEY||'').trim();
  const provider=(env.KITT_TRANSCRIPTION_PROVIDER|| (apiKey?'openai':'local')).trim().toLowerCase();
  if(!['openai','local'].includes(provider))throw new Error('KITT_TRANSCRIPTION_PROVIDER must be openai or local.');
  return {provider,apiKey,model:(env.OPENAI_TRANSCRIPTION_MODEL||'gpt-transcribe').trim(),available:provider==='local'||Boolean(apiKey)};
}

export async function transcribeWithOpenAI(wav,{env=process.env,fetch=globalThis.fetch,signal,timeout=60000}={}){
  const config=transcriptionConfig(env);
  if(!config.apiKey)throw new Error('Add OPENAI_API_KEY to the private .env for voice input.');
  if(!Buffer.isBuffer(wav)||wav.length<44||wav.length>25*1024*1024)throw new Error('The voice recording is empty or too large.');
  const form=new FormData();form.append('file',new Blob([wav],{type:'audio/wav'}),'voice.wav');form.append('model',config.model);form.append('language','en');form.append('prompt','A voice conversation with KITT (pronounced kit), also addressed as computer. Other names may include Driver, Michael Knight, Devon Miles and Bonnie Barstow.');
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
  let response;
  try{response=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${config.apiKey}`},body:form,signal:requestSignal});}
  catch{if(signal?.aborted)throw new Error('Voice input stopped.');throw new Error('OpenAI voice input could not be reached. Check the internet connection and try again.');}
  if(!response.ok){
    if(response.status===401||response.status===403)throw new Error('OpenAI rejected the voice-input credentials. Check OPENAI_API_KEY and its permissions.');
    if(response.status===429)throw new Error('OpenAI voice input is rate-limited or has no available API quota. Check API billing, then retry.');
    if(response.status===404)throw new Error('The OpenAI transcription model is unavailable. Check OPENAI_TRANSCRIPTION_MODEL.');
    if(response.status===400||response.status===422)throw new Error('OpenAI could not transcribe this recording with the selected model.');
    throw new Error('OpenAI voice input is temporarily unavailable. Try again.');
  }
  let value;try{value=await response.json()}catch{throw new Error('OpenAI returned an unreadable transcript. Try again.');}
  const text=typeof value.text==='string'?value.text.trim():'';
  if(!text||/^\s*\[[\s\S]*\]\s*$/.test(text))throw new Error('No speech was recognized. Press the dial and try again.');
  return text;
}
