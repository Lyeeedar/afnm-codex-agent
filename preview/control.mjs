import {readFile} from 'node:fs/promises';
const [command='inspect',argument]=process.argv.slice(2);
const body=command==='run'?{code:await readFile(argument,'utf8')}:command==='screenshot'?{name:argument || 'preview.png'}:null;
const response=await fetch(`http://127.0.0.1:4174/${command}`,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});
const result=await response.json();console.log(JSON.stringify(result,null,2));
if(!response.ok)process.exitCode=1;
