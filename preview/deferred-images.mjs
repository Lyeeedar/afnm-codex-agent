import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';

// Eager thumbnail globs should resolve URLs at startup, not resize every image.
// Keep Vite/imagetools responsible for the actual pixels when an image is used.
export function deferredPreviewImages(root=process.cwd()) {
  const sources=new Map();
  return {
    name:'preview-deferred-images',enforce:'post',
    transform(code,id) {
      if(!/\.[cm]?[jt]sx?$/.test(id.split('?')[0]))return null;
      const result=code.replace(/\bimport\s+(?:([\w$]+)|\{\s*default\s+as\s+([\w$]+)\s*\})\s+from\s*(['"])([^'"\n]+)\3\s*;?/g,(original,binding,named,quote,specifier)=>{
        const [path,query]=specifier.split('?');
        if(!/\.(png|jpe?g|webp|avif)$/i.test(path) || !query)return original;
        const params=new URLSearchParams(query);
        if(!params.has('w') && !params.has('h'))return original;
        // Metadata, srcsets and multiple outputs are not single image URLs.
        if([...params].some(([key,value])=>!['w','h','fit','format','quality'].includes(key) || value.includes(';')))return original;
        let absolute;
        if(path.startsWith('.'))absolute=resolve(dirname(id.split('?')[0]),path);
        else if(path.startsWith('/src/'))absolute=resolve(root,path.slice(1));
        else if(path.startsWith('@/'))absolute=resolve(root,'src',path.slice(2));
        else return original;
        const source='/@fs/'+absolute.replaceAll('\\','/')+'?'+query;
        const key=createHash('sha256').update(source).digest('hex');
        sources.set(key,source);
        return `const ${binding ?? named}=${JSON.stringify('/@agent-image/'+key)};`;
      });
      return result===code?null:{code:result,map:null};
    },
    configureServer(server) {
      server.middlewares.use(async(request,response,next)=>{
        if(!request.url?.startsWith('/@agent-image/'))return next();
        const source=sources.get(request.url.slice('/@agent-image/'.length));
        if(!source){response.statusCode=404;response.end('Unknown preview image');return;}
        try {
          const result=await server.transformRequest(source);
          const match=result?.code.match(/export default\s+("(?:\\.|[^"\\])*")\s*;/);
          const target=match?JSON.parse(match[1]):null;
          if(typeof target!=='string' || !target.startsWith('/@imagetools/'))throw new Error('Expected a single imagetools URL for '+source);
          response.statusCode=302;response.setHeader('Location',target);response.end();
        }catch(error){response.statusCode=500;response.end(error.message);}
      });
    },
  };
}
