// Revision 1. Small first speech section with one section of bounded look-ahead.
export function speechChunks(text) {
  let remaining=text.trim().slice(0,16000);const chunks=[];
  const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
  while(remaining){
    const limit=chunks.length?350:200;
    if(remaining.length<=limit){chunks.push(remaining);break;}
    let end=0;
    for(const {segment,index} of segmenter.segment(remaining)){
      const candidate=index+segment.length;
      if(candidate>limit)break;
      end=candidate;
      if(!chunks.length&&end>=40)break;
    }
    if(!end){end=remaining.lastIndexOf(' ',limit);if(end<1)end=limit;}
    chunks.push(remaining.slice(0,end).trim());remaining=remaining.slice(end).trim();
  }
  return chunks;
}

export async function playSpeechStream(chunks, {prepare, play, signal, abort}) {
  const iterator = chunks[Symbol.asyncIterator]?.() || chunks[Symbol.iterator]();
  const jobs = new Set();
  const next = () => {
    const job = (async () => {
      signal.throwIfAborted();
      let onAbort;
      const interrupted = new Promise((_, reject) => { onAbort = () => reject(signal.reason || Error('Speech stopped.')); signal.addEventListener('abort', onAbort, {once: true}); });
      let item;
      try { item = await Promise.race([iterator.next(), interrupted]); }
      finally { signal.removeEventListener('abort', onAbort); }
      signal.throwIfAborted();
      return item.done ? {done: true} : {value: await prepare(item.value)};
    })().catch(error => ({error}));
    jobs.add(job); job.finally(() => jobs.delete(job)); return job;
  };
  let current = next(), upcoming = next();
  try {
    while (true) {
      const result = await current; signal.throwIfAborted();
      if (result.error) throw result.error;
      if (result.done) break;
      await play(result.value); signal.throwIfAborted();
      current = upcoming; upcoming = next();
    }
  } finally {
    abort();
    void Promise.resolve(iterator.return?.()).catch(() => {});
    await Promise.allSettled(jobs);
  }
}

export async function playSpeechQueue(chunks,{prepare,play,signal,abort}) {
  const jobs=new Map();
  const start=index=>{
    if(index<chunks.length&&!jobs.has(index)&&!signal.aborted){
      // Attach rejection handling immediately, including for the prefetched section.
      jobs.set(index,Promise.resolve().then(()=>prepare(chunks[index],index)).then(value=>({value}),error=>({error})));
    }
  };
  try{
    signal.throwIfAborted();start(0);start(1);
    for(let index=0;index<chunks.length;index++){
      signal.throwIfAborted();const result=await jobs.get(index);signal.throwIfAborted();
      if(result.error)throw result.error;
      await play(result.value,index);signal.throwIfAborted();start(index+2);
    }
  }finally{
    // Finish or cancel every producer before the caller removes temporary files.
    abort();await Promise.allSettled(jobs.values());
  }
}
