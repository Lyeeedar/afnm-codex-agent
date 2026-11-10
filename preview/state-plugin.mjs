import {readFileSync} from 'node:fs';
export function previewStateTools() {
  const id='\0agent-preview-state';
  return {
    name:'agent-preview-state',enforce:'pre',
    resolveId(source){if(source==='/@agent-state')return id;if(source==='/@agent-migration')return '\0agent-preview-migration';},
    load(source){if(source===id)return readFileSync(new URL('./state.mjs',import.meta.url),'utf8');if(source==='\0agent-preview-migration')return readFileSync(new URL('./migration.mjs',import.meta.url),'utf8');},
    transform(code,path){
      const normalized=path.replaceAll('\\','/');
      if(normalized.endsWith('/MainMenuScreen.tsx')) {
        const marker='export const MainMenuScreen: React.FC<MainMenuScreenProps> = (props) => {';
        if(!code.includes(marker))throw new Error('Main menu readiness adapter changed');
        const readyMarker='  if (!menuReady) return null;';
        const ready=code.includes(readyMarker)?'menuReady && savesLoaded':'true';
        const hook=`\nuseEffect(() => {
          if (window.__agentPreview) window.__agentPreview.menuReady = ${ready};
          return () => { if (window.__agentPreview) window.__agentPreview.menuReady = false; };
        }, [${ready}]);\n`;
        return {code:code.includes(readyMarker)?code.replace(readyMarker,hook+readyMarker):code.replace(marker,marker+hook),map:null};
      }
      if(normalized.endsWith('/src/screens/cultivation/BreakthroughMigrationGate.tsx')) {
        const marker='  if (!stage) return children;';
        if(!code.includes(marker))throw new Error('Breakthrough migration adapter changed');
        return {code:`import { preparePreviewSave } from '/@agent-migration';\n`+code.replace(marker,`  useEffect(() => {
          const preview = window.__agentPreview;
          if (!stage || !preview || preview.migrating || preview.migrationError) return;
          preview.migrating = true;
          preparePreviewSave(window.gameStore).then(choices => {
            preview.migrationChoices = [...(preview.migrationChoices ?? []), ...choices];
          }).catch(error => { preview.migrationError = error.message; }).finally(() => { preview.migrating = false; });
        }, [stage]);
${marker}`),map:null};
      }
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
