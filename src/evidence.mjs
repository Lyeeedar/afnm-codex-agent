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
export const visualInstructions=`Visual validation is available on demand. For UI/layout/visual changes, run the game, inspect screenshots with your image-viewing tool, adjust the implementation, and recheck the affected screen. Start only when useful; reuse the running preview across changes. The cached executor includes Playwright and Chromium; do not install browsers or launch Docker.
AFNM: node /opt/agent-preview/start.mjs [--save /agent-input/the-save.json]. This prepares npm dependencies only if absent, starts Vite with Electron plugins disabled, and opens an isolated renderer using a browser adapter for version/settings/temporary saves. It does not test Steam, native dialogs or real filesystem behavior. Wait for startup to complete; inspect /workspace/.agent-preview/preview.log if needed.
Inspect: node /opt/agent-preview/control.mjs inspect
Screenshot: node /opt/agent-preview/control.mjs screenshot affected-screen.png (writes /agent-output/affected-screen.png; view this image).
Interact: write an async Playwright script in /workspace/.agent-preview/actions.mjs, then node /opt/agent-preview/control.mjs run /workspace/.agent-preview/actions.mjs. The script has page, browser, fs and outputDirectory variables. Example: await page.getByRole('button',{name:'Settings',exact:true}).click(); return await page.getByRole('dialog').innerText(); The same page/server persist between commands, so Vite can update after code edits. A supplied save appears as Continue in the main menu; click it to load the actual reported state. Do not fabricate a screenshot or claim a screen you did not inspect. Capture final screenshots as PNGs in /agent-output; the controller attaches up to eight screenshots as a workflow artifact linked from the PR.`;
