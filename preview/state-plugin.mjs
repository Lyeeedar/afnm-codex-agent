import {readFileSync} from 'node:fs';
export function previewStateTools() {
  const id='\0agent-preview-state';
  return {name:'agent-preview-state',resolveId(source){if(source==='/@agent-state')return id;},load(source){if(source===id)return readFileSync(new URL('./state.mjs',import.meta.url),'utf8');}};
}
