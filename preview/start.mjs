import {spawn} from 'node:child_process';
import {mkdir,open} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const directory='/workspace/.agent-preview';
const [flag,savePath]=process.argv.slice(2);
if(flag && flag!=='--save')throw new Error('Usage: node /opt/agent-preview/start.mjs [--save /agent-input/save.json]');
let existing=false;
try {existing=(await fetch('http://127.0.0.1:4174/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
if(existing && savePath) throw new Error('Preview already started; import a different save through the running page or stop before restarting.');
if(!existing) {
  await mkdir(directory,{recursive:true});
  const log=await open(directory+'/preview.log','a');
  const worker=spawn(process.execPath,[new URL('./worker.mjs',import.meta.url).pathname,...(savePath?[savePath]:[])],{detached:true,stdio:['ignore',log.fd,log.fd]});worker.unref();await log.close();
}
const started=Date.now();
while(Date.now()-started<480000) {
  try {
    const response=await fetch('http://127.0.0.1:4174/health',{signal:AbortSignal.timeout(2000)});
    const status=await response.json();
    if(status.error)throw Object.assign(new Error(status.error),{fatal:true});
    if(status.ready){console.log(JSON.stringify(status,null,2));process.exit(0);}
  } catch(error){if(error.fatal)throw error;}
  await delay(500);
}
throw new Error('Preview startup timed out; inspect /workspace/.agent-preview/preview.log');
