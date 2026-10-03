import {readdir,readFile,mkdir,copyFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
export async function collectScreenshots(source,destination) {
  const files=await readdir(source,{withFileTypes:true}).catch(()=>[]);let count=0,total=0;
  for(const file of files) {
    if(!file.isFile() || !/^[\w.-]+\.png$/.test(file.name))continue;
    if((await stat(join(source,file.name))).size>20*1024*1024)continue;
    const bytes=await readFile(join(source,file.name));
    if(!bytes.subarray(0,8).equals(png) || bytes.length>20*1024*1024 || total+bytes.length>40*1024*1024 || count>=8)continue;
    await mkdir(destination,{recursive:true});await copyFile(join(source,file.name),join(destination,file.name));count++;total+=bytes.length;
  }
  return count;
}
export async function publishScreenshotImages(directory,{api,repository,prNumber,runId,attempt}) {
  const root='/repos/'+repository;
  const files=(await readdir(directory,{withFileTypes:true})).filter(file=>file.isFile() && /^[\w.-]+\.png$/.test(file.name));
  if(!files.length)return {};
  const tree=[];
  for(const file of files) {
    const bytes=await readFile(join(directory,file.name));
    if(!bytes.subarray(0,8).equals(png))throw new Error('Invalid screenshot PNG: '+file.name);
    const blob=await api.json(root+'/git/blobs',{method:'POST',body:{content:bytes.toString('base64'),encoding:'base64'}});
    tree.push({path:'images/'+file.name,mode:'100644',type:'blob',sha:blob.sha});
  }
  const createdTree=await api.json(root+'/git/trees',{method:'POST',body:{tree}});
  // An independent evidence branch contains only PNGs: no game commits, source,
  // credentials or saves. Immutable commit URLs survive later agent turns.
  const commit=await api.json(root+'/git/commits',{method:'POST',body:{message:'Visual evidence for PR #'+prNumber,tree:createdTree.sha,parents:[]}});
  const ref='refs/heads/codex-evidence/pr-'+prNumber+'/run-'+runId+'-'+attempt;
  try {await api.json(root+'/git/refs',{method:'POST',body:{ref,sha:commit.sha}});}
  catch(error) {
    if(error.status!==422)throw error;
    const existing=await api.json(root+'/git/ref/heads/'+encodeURIComponent(ref.slice('refs/heads/'.length)));
    if(existing.object.sha!==commit.sha)throw error;
  }
  return Object.fromEntries(files.map(file=>[file.name,'../blob/'+commit.sha+'/images/'+file.name+'?raw=true']));
}
export const visualInstructions=`Visual validation is REQUIRED for every change with a UI component or player-visible result, including changes to gameplay, content, interactions, and fixes whose results appear in the game. Run the game, use the fast state setup tools or the supplied save to reach the affected state directly, exercise the changed behavior, inspect screenshots with your image-viewing tool, adjust the implementation, and recheck. Reuse the running preview across changes; do not play through progression when a scenario or checkpoint can reach the required state. Pure backend/tooling changes with no visible result do not require game screenshots. The cached executor includes Playwright and Chromium; do not install browsers or launch Docker.
AFNM: node /opt/agent-preview/start.mjs [--save /agent-input/the-save.json]. This prepares npm dependencies only if absent, starts Vite with Electron plugins disabled, and opens an isolated renderer using a browser adapter for version/settings/temporary saves. It does not test Steam, native dialogs or real filesystem behavior. Wait for startup to complete; inspect /workspace/.agent-preview/preview.log if needed.
Inspect: node /opt/agent-preview/control.mjs inspect
Screenshot: node /opt/agent-preview/control.mjs screenshot affected-screen.png (writes /agent-output/affected-screen.png; view this image).
Fast state setup: write a JSON scenario in /workspace/.agent-preview/scenario.json, then node /opt/agent-preview/control.mjs state apply /workspace/.agent-preview/scenario.json. Example: {"base":"fresh","realm":"coreFormation","location":"Shen Henda City","screen":"library","money":100000}. Fresh uses the game's authored progression helpers (bodyForging through coreFormation), creates a temporary character and skips early tutorials. For higher realms use an actual report save or checkpoint; a realm label alone is not a valid late-game build. Use base: current to preserve the loaded report state. Add location (exact name), flags (numeric values), items [{name,stacks}], combat {enemy}, crafting {recipe}, or event (a real GameEvent). Fresh scenarios pause automatic story/tutorial triggers so they cannot hijack the requested screen; use pauseTriggers: false when testing actual triggers, or pauseTriggers: true to stabilize a current save. Current state keeps active activities unless clearActivities: true is explicit. Setup fails rather than claiming the requested screen when prerequisites or another active activity select a different screen.
Discover names: node /opt/agent-preview/control.mjs state catalog locations "Sect" (also screens, realms, items, recipes, enemies, techniques; results capped at 50). Inspect selected state: node /opt/agent-preview/control.mjs state inspect player.player.realm,inventory.money. Checkpoint: node /opt/agent-preview/control.mjs state snapshot before-test; restore: node /opt/agent-preview/control.mjs state restore /workspace/.agent-preview/checkpoints/before-test.json (or a /agent-input save). Checkpoints are private workspace files, not screenshot artifacts. For unusual states, scenario patch maps exact dot paths to replacement values (arrays replace rather than merge); operations [{module:"/src/store/slices/screenSlice.ts",export:"navigate",args:["map"]}] call the game's real action creators/thunks. Read the relevant initializer before using these; do not invent incomplete state. Every setup is committed atomically and the running preview is reused.
Interact: write an async Playwright script in /workspace/.agent-preview/actions.mjs, then node /opt/agent-preview/control.mjs run /workspace/.agent-preview/actions.mjs. The script has page, browser, fs and outputDirectory variables. Example: await page.getByRole('button',{name:'Settings',exact:true}).click(); return await page.getByRole('dialog').innerText(); The same page/server persist between commands, so Vite can update after code edits. A supplied save appears as Continue in the main menu; click it to load the actual reported state. Do not fabricate a screenshot or claim a screen you did not inspect. Before finishing any UI-affecting task, capture screenshots of the final implemented result as PNGs in /agent-output, covering each materially different affected screen or state (up to eight screenshots total). Screenshot the affected result, not just the main menu or an unrelated screen. For interactive behavior, exercise the relevant interaction before taking the result screenshot. View the captured images and confirm the result renders correctly; an initial or stale screenshot is not final evidence. Include a Visual validation section in your final report naming the scenarios exercised and screenshot filenames. Do not embed Markdown images or links using /agent-output, /workspace, or sandbox: paths: those paths are not reachable from GitHub. The controller publishes the PNGs on a private evidence branch and embeds them directly in the PR, with workflow artifacts as a backup. If preview startup, required state setup, or rendering is blocked, state the concrete blocker and what remains unverified in the final report; do not claim visual validation succeeded or silently omit screenshots.`;
