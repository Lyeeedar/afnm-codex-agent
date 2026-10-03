// Renderer-only adapter for isolated browser previews. It never accesses real saves,
// Steam, native dialogs or credentials; those desktop integrations need Electron tests.
export function installPreviewBridge({version,saveData=null}) {
  let persisted=[];
  try {persisted=JSON.parse(window.sessionStorage?.getItem('agent-preview-saves') ?? '[]');}catch{}
  const saves=new Map(persisted);
  if(saveData && !saves.has('agent-preview-report'))saves.set('agent-preview-report',saveData);
  const persist=()=>{window.sessionStorage?.setItem('agent-preview-saves',JSON.stringify([...saves]));};
  window.__agentPreview={setSave:(name,data)=>{JSON.parse(data);saves.set(name,data);persist();}};
  const cache=new Map();let sticky=null,fullscreen=false,resolution='1440x1000';
  window.app={
    getVersion:async()=>version,getIsDev:async()=>false,getDevOverride:async()=>false,
    openDevTools:async()=>{},toggleDevTools:async()=>{},
    getFullscreen:async()=>fullscreen,setFullscreen:async value=>{fullscreen=value;},
    getResolution:async()=>resolution,setResolution:async value=>{resolution=value;},
    setDiscordActivity:async()=>false,
  };
  window.electronAPI={invoke:async channel=>channel==='steam:workshop:getSubscribedItems'?[]:false};
  window.myFS={
    readStickyState:async()=>sticky,writeStickyState:async value=>{sticky=value;return true;},
    readMods:async()=>[],readGlobalModFlags:async()=>({}),writeGlobalModFlag:async()=>true,
    cleanupUnusedModFolders:async()=>{},readFighterImports:async()=>[],
    readCacheFile:async name=>cache.get(name)??null,writeCacheFile:async(name,data)=>{cache.set(name,data);return true;},
    listSaves:async()=>[...saves.keys()].map(name=>({name})),
    readSave:async name=>saves.get(name)??null,
    writeSave:async(name,data)=>{saves.set(name,data);persist();return true;},
    deleteSave:async name=>{const deleted=saves.delete(name);persist();return deleted;},
    discoverSaveBackupFolders:async()=>[],discoverSaveBackups:async()=>[],
    backupFolderExists:async()=>false,writeSaveBackup:async()=>true,
    fileExists:async()=>false,readCurrentLog:async()=>'',
    writeError:async error=>{console.error('Preview renderer error:',error);return true;},
  };
}
