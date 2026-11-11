import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
// A preview-only optimization: plain URL asset imports need no JavaScript
// module per image/audio/font. Real assets are still served by Vite on demand.
export function previewAssetURLs(root=process.cwd()) {
  return {name:'preview-direct-asset-urls',enforce:'post',transform(code,id){
    if(!/\.[cm]?[jt]sx?$/.test(id.split('?')[0]))return null;
    const result=code.replace(/\bimport\s+(?:([\w$]+)|\{\s*default\s+as\s+([\w$]+)\s*\})\s+from\s*(['"])([^'"\n]+)\3\s*;?/g,(original,binding,named,quote,specifier)=>{
      if(!/\.(?:png|jpe?g|webp|gif|avif|svg|ogg|mp3|woff2?|otf|ttf|mp4|webm|ktx)(?:\?url)?$/.test(specifier))return original;
      const path=specifier.replace(/\?url$/,'');let absolute;
      if(path.startsWith('.'))absolute=resolve(dirname(id.split('?')[0]),path);
      else if(path.startsWith('@/'))absolute=resolve(root,'src',path.slice(2));
      else if(path.startsWith('/src/') || path.startsWith('/steam/'))absolute=resolve(root,path.slice(1));
      else return original;
      if(!existsSync(absolute))return original;
      const url='/@fs/'+absolute.replaceAll('\\','/').split('/').map(part=>encodeURIComponent(part).replace(/%3A/gi,':')).join('/');
      return `const ${binding ?? named}=${JSON.stringify(url)};`;
    });
    return result===code?null:{code:result,map:null};
  }};
}
