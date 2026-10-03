import {readFileSync} from 'node:fs';
export function previewStateTools() {
  const id='\0agent-preview-state';
  return {
    name:'agent-preview-state',enforce:'pre',
    resolveId(source){if(source==='/@agent-state')return id;},
    load(source){if(source===id)return readFileSync(new URL('./state.mjs',import.meta.url),'utf8');},
    transform(code,path){
      if(!path.replaceAll('\\','/').endsWith('/src/components/contexts/saves/SaveRouter.tsx'))return null;
      const marker='const reduxState = useSaveReducer(saveName);';
      if(!code.includes(marker))throw new Error('SaveRouter changed; preview state loader needs an adapter update');
      return {code:code.replace(marker,`useEffect(() => {
        if (window.__agentPreview) window.__agentPreview.loadSave = setSaveName;
        return () => { if (window.__agentPreview) delete window.__agentPreview.loadSave; };
      }, []);
      ${marker}`),map:null};
    },
  };
}
