import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {installPreviewBridge} from './bridge.mjs';
import {stateCommand} from './state-control.mjs';
import {createPreviewTransfer} from './transfer.mjs';
import {startupTimeout} from './startup.mjs';
const workspace='/workspace',outputDirectory='/agent-output';
const started=Date.now(),deadline=started+startupTimeout(),status={ready:false,phase:'dependencies'},errors=[];
const remaining=()=>{const ms=deadline-Date.now();if(ms<=0)throw new Error('Preview startup timed out during '+status.phase);return ms;};
let browser,page,vite,queue=Promise.resolve();
const pendingImages=new Set();
const screenshot=async(name='preview.png')=>{
  if(!/^[\w.-]+\.png$/.test(name))throw new Error('Screenshot name must be a plain PNG filename');
  await page.waitForFunction(()=>{
    const preview=window.__agentPreview;
    if(preview?.migrationError)throw new Error(preview.migrationError);
    return !preview?.migrating && (window.hasRedux ? typeof preview?.suspendRenderer==='function' : preview?.menuReady===true);
  },undefined,{timeout:60000});
  // Deferred thumbnails now start loading when rendered. Do not capture before
  // their image responses arrive, including CSS background artwork.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const imageDeadline=Date.now()+60000;
  while(pendingImages.size){if(Date.now()>imageDeadline)throw new Error('Preview images did not finish loading');await delay(100);}
  const path=outputDirectory+'/'+name;await page.screenshot({path,animations:'disabled'});return {path};
};
const server=createServer((request,response)=>{
  queue=queue.then(async()=>{
    response.setHeader('content-type','application/json');
    try {
      if(request.url==='/health'){response.end(JSON.stringify(status));return;}
      if(!status.ready)throw new Error(status.error || 'Preview is starting');
      let text='';for await(const chunk of request){text+=chunk;if(text.length>65536)throw new Error('Preview command exceeds 64 KiB');}
      const body=text?JSON.parse(text):{};let result;
      if(request.url==='/inspect')result={url:page.url(),text:(await page.locator('body').innerText()).slice(0,12000),buttons:await page.getByRole('button').allTextContents(),migration:await page.evaluate(()=>({choices:window.__agentPreview?.migrationChoices ?? [],pending:!!window.__agentPreview?.migrating,error:window.__agentPreview?.migrationError})),errors};
      else if(request.url==='/screenshot')result=await screenshot(body.name);
      else if(request.url==='/state')result=await stateCommand(page,body);
      else if(request.url==='/run') {
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        result=await new AsyncFunction('page','browser','fs','outputDirectory',body.code)(page,browser,fs,outputDirectory);
      } else throw new Error('Unknown preview command');
      response.end(JSON.stringify({result:result??null}));
    }catch(error){response.statusCode=500;response.end(JSON.stringify({error:error.message}));}
  }).catch(error=>console.error(error));
});
server.listen(4174,'127.0.0.1');
try {
  await fs.mkdir(workspace+'/.agent-preview',{recursive:true});await fs.mkdir(outputDirectory,{recursive:true});
  try{await fs.access(workspace+'/node_modules/vite/bin/vite.js');}
  catch{await promisify(execFile)('npm',['install','--package-lock=false','--no-audit','--no-fund'],{cwd:workspace,env:{...process.env,ELECTRON_SKIP_BINARY_DOWNLOAD:'1'},maxBuffer:16*1024*1024});}
  await fs.writeFile(workspace+'/.agent-preview/vite.config.mts',`import original from '../vite.config.mts';
import {previewConfig} from '/opt/agent-preview/config.mjs';
export default environment => previewConfig(original,environment);`);
  vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','.agent-preview/vite.config.mts'],{cwd:workspace,env:{...process.env,NODE_ENV:'development',ELECTRON_SKIP_BINARY_DOWNLOAD:'1'},stdio:'inherit'});
  status.phase='vite';
  while(true){if(vite.exitCode!==null)throw new Error('Vite exited with code '+vite.exitCode);try{if((await fetch('http://127.0.0.1:4173',{signal:AbortSignal.timeout(2000)})).ok)break;}catch{}if(Date.now()>deadline)throw new Error('Vite did not become ready');await delay(250);}
  const {chromium}=await import('/usr/local/lib/node_modules/playwright/index.mjs');
  browser=await chromium.launch({headless:true,chromiumSandbox:false,args:['--disable-dev-shm-usage','--disable-features=LocalNetworkAccessChecks']});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  // Serve the large development module graph through Node rather than exhausting
  // Chromium's concurrent network loaders. Preserve Vite responses and live reload.
  const transfer=createPreviewTransfer({onRetry:({url,attempt,code})=>console.warn(`Preview transfer retry ${attempt}: ${code} ${url}`)});
  await page.route('http://127.0.0.1:4173/**',async route=>{
    if(route.request().method()!=='GET')return route.continue();
    const image=route.request().resourceType()==='image';
    if(image)pendingImages.add(route);
    try {
      await route.fulfill(await transfer(route.request().url()));
    }catch(error){console.error('Preview transfer failed:',error.message);await route.abort().catch(()=>{});}
    finally{if(image)pendingImages.delete(route);}
  });
  page.on('pageerror',error=>{console.error('PAGE ERROR:',error.stack);errors.push(error.message);if(errors.length>30)errors.shift();});
  page.on('console',message=>{if(message.type()==='error')console.error('BROWSER ERROR:',message.text());});
  page.on('requestfailed',request=>console.error('REQUEST FAILED:',request.url(),request.failure()?.errorText));
  const {version}=JSON.parse(await fs.readFile(workspace+'/package.json','utf8'));
  const saveData=process.argv[2]?await fs.readFile(process.argv[2],'utf8'):null;
  if(saveData)JSON.parse(saveData);
  await page.addInitScript(installPreviewBridge,{version,saveData});
  status.phase='navigation';
  await page.goto('http://127.0.0.1:4173',{waitUntil:'domcontentloaded',timeout:remaining()});
  // The bridge seeds analytics as declined before the game mounts.
  status.phase='module graph and main menu';
  await page.waitForFunction(()=>window.__agentPreview?.menuReady===true,undefined,{timeout:remaining()});
  status.phase='ready';status.ready=true;status.startedSeconds=Number(((Date.now()-started)/1000).toFixed(2));
}catch(error){status.error=error.message;console.error(error);if(page){console.error('PAGE TEXT:',await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:outputDirectory+'/startup-failure.png',timeout:15000}).catch(()=>{});}if(vite)vite.kill('SIGTERM');if(browser)await browser.close();}
const stop=async()=>{if(vite)vite.kill('SIGTERM');if(browser)await browser.close();server.close();process.exit(0);};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
