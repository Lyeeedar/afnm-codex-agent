import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {monitorPreviewProcess} from '../preview/startup.mjs';

test('Vite signal exits and spawn failures are reported immediately',()=>{
  for(const [event,args,expected] of [['exit',[null,'SIGKILL'],/signal SIGKILL/],['exit',[1,null],/code 1/],['error',[new Error('ENOENT')],/ENOENT/]]) {
    const child=new EventEmitter();const failures=[];monitorPreviewProcess(child,details=>failures.push(details));
    child.emit(event,...args);assert.equal(failures.length,1);assert.match(failures[0].message,expected);
  }
});
test('intentional Vite shutdown does not replace an earlier startup failure',()=>{
  const child=new EventEmitter();const failures=[];const stop=monitorPreviewProcess(child,details=>failures.push(details));
  stop();child.emit('exit',null,'SIGTERM');assert.deepEqual(failures,[]);
});

test('Vite failure diagnostics retain a bounded stderr tail including heap failures',()=>{
  const child=new EventEmitter();child.stderr=new EventEmitter();const failures=[];
  monitorPreviewProcess(child,details=>failures.push(details));
  child.stderr.emit('data',Buffer.from('x'.repeat(10000)));
  child.stderr.emit('data',Buffer.from('FATAL ERROR: JavaScript heap out of memory'));
  child.emit('exit',null,'SIGABRT');
  assert.equal(failures[0].stderr.length,8192);
  assert.match(failures[0].stderr,/heap out of memory$/);
});
