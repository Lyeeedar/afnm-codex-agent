import {mkdir,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';

export function attachmentLinks(text) {
  const found=new Map();
  for(const match of text.matchAll(/https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/[^\s<>"'\\)]+/g)) {
    const url=new URL(match[0]);
    let parts;try {parts=url.pathname.split('/').slice(1).map(decodeURIComponent);} catch {continue;}
    const [owner,name]=parts;
    if(!/^[\w.-]+$/.test(owner ?? '') || !/^[\w.-]+$/.test(name ?? '')) continue;
    if(url.hostname==='github.com' && parts[2]!=='blob') continue;
    const offset=url.hostname==='github.com'?3:2;
    const ref=parts[offset],path=parts.slice(offset+1).join('/');
    if(!ref || !path || path.split('/').some(p=>p==='..' || p==='.' || !p)) continue;
    if(!/\.(?:png|jpe?g|webp|gif|json|zip|txt|log|sav)$/i.test(path)) continue;
    const key=`${owner}/${name}/${ref}/${path}`;
    found.set(key,{url:url.href,repo:`${owner}/${name}`,ref,path});
  }
  return [...found.values()];
}

export async function downloadAttachments(text,{directory,getAPI,maxBytes=32*1024*1024,maxFiles=20}) {
  const links=attachmentLinks(text);
  if(links.length>maxFiles) throw new Error(`Task has ${links.length} attachments; limit is ${maxFiles}`);
  if(!links.length) return [];
  await mkdir(directory,{recursive:true});
  const manifest=[];
  for(const link of links) {
    const api=await getAPI(link.repo);
    const path=`/repos/${link.repo}/contents/${link.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(link.ref)}`;
    // Request the canonical GitHub endpoint, never send credentials to supplied
    // URLs or redirects. The raw media type returns the actual binary/save file.
    const response=await api.request(path,{headers:{Accept:'application/vnd.github.raw+json'},redirect:'error'});
    if(Number(response.headers.get('content-length'))>maxBytes) {await response.body?.cancel();throw new Error(`Attachment exceeds ${maxBytes} bytes: ${link.path}`);}
    const chunks=[];let size=0;
    for await(const chunk of response.body) {
      size+=chunk.length;
      if(size>maxBytes) throw new Error(`Attachment exceeds ${maxBytes} bytes: ${link.path}`);
      chunks.push(chunk);
    }
    const filename=`${createHash('sha256').update(link.url).digest('hex').slice(0,12)}-${basename(link.path).replace(/[^\w.-]/g,'_')}`;
    await writeFile(join(directory,filename),Buffer.concat(chunks),{flag:'wx'});
    manifest.push({...link,localPath:`/agent-input/${filename}`,bytes:size});
  }
  await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  return manifest;
}
