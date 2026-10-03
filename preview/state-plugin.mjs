import {readFileSync} from 'node:fs';
export function previewStateTools() {
  const id='\0agent-preview-state';
  return {
    name:'agent-preview-state',enforce:'pre',
    resolveId(source){if(source==='/@agent-state')return id;},
    load(source){if(source===id)return readFileSync(new URL('./state.mjs',import.meta.url),'utf8');},
    transform(code,path){
      const normalized=path.replaceAll('\\','/');
      if(normalized.endsWith('/src/Game.tsx')) {
        const marker='const Game: React.FC = () => {';
        const imports='PropsWithChildren, lazy, Suspense, useContext';
        if(!code.includes(marker) || !code.includes(imports) || !code.includes('<AppRouter />'))throw new Error('Game router adapter changed');
        const wrapper=`const AgentPreviewRouter = () => {
          const [hidden, setHidden] = useState(false);
          const [epoch, setEpoch] = useState(0);
          useEffect(() => {
            if (!window.__agentPreview) return;
            window.__agentPreview.suspendRenderer = async () => {
              setHidden(true);
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            };
            window.__agentPreview.resumeRenderer = () => { setEpoch(value => value + 1); setHidden(false); };
            return () => { delete window.__agentPreview.suspendRenderer; delete window.__agentPreview.resumeRenderer; };
          }, []);
          return hidden ? null : <AppRouter key={epoch} />;
        };
        `;
        return {code:code.replace(imports,imports+', useEffect, useState').replace(marker,wrapper+marker).replace('<AppRouter />','<AgentPreviewRouter />'),map:null};
      }
      if(['/src/components/game/EventTrigger.tsx','/src/components/tutorial/TutorialTrigger.tsx'].some(suffix=>normalized.endsWith(suffix))) {
        const marker='useErrorHandlingEffect(() => {';
        if(!code.includes(marker))throw new Error('Trigger adapter changed');
        return {code:code.replace(marker,marker+'\n    if (window.__agentPreview?.pauseTriggers) return;'),map:null};
      }
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
