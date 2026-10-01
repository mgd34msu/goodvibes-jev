import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// These exact stream rules differ between Bun and Node. Strip types only so
// the real Node stream implementation exercises the same production adapter.
test('plugin stream ownership preserves native Node byte and iterator behavior', () => {
  const node = Bun.which('node');
  if (!node) throw new Error('The native Node compatibility fixture requires Node on PATH');
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-node-streams-'));
  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'node' });
    for (const name of ['owned-capabilities', 'in-flight']) {
      const source = readFileSync(new URL(`../sdk/src/platform/plugins/${name}.ts`, import.meta.url), 'utf8');
      writeFileSync(join(root, `${name}.mjs`), transpiler.transformSync(source));
    }
    writeFileSync(join(root, 'probe.mjs'), `
import assert from 'node:assert/strict';
import {createOwnedPluginCapabilities} from './owned-capabilities.mjs';
import {PluginInFlightTracker} from './in-flight.mjs';
assert.equal(process.versions.bun,undefined,'This compatibility proof must execute in native Node');
assert.ok(process.versions.node);
function gate(){let release;const promise=new Promise(resolve=>{release=resolve});return {release,promise}}
function owner(){const tracker=new PluginInFlightTracker();return {tracker,owned:createOwnedPluginCapabilities(call=>tracker.track('fixture',call)),close:()=>tracker.close('fixture')}}
const request=new Request('http://127.0.0.1/fixture');
const channel=handleInbound=>({id:'fixture',surface:'webhook',displayName:'Fixture',capabilities:[],handleInbound});
let proofs=0;
{
 const fx=owner();let pulls=0;
 const result=await fx.owned.channel(channel(async()=>new Response(new ReadableStream({pull(controller){
   if(pulls++===0)controller.enqueue(new Uint8Array());
   else {controller.enqueue(Buffer.from('abc'));controller.close()}
 }},{highWaterMark:0})))).handleInbound(request);
 assert.equal(pulls,0);assert.equal(await result.text(),'abc');assert.equal(pulls,2);await fx.close();proofs++;
}
{
 const fx=owner();
 const result=await fx.owned.channel(channel(async()=>new Response(new ReadableStream({type:'bytes',pull(controller){controller.enqueue(new Uint8Array([4,5]));controller.close()}})))).handleInbound(request);
 const reader=result.body.getReader({mode:'byob'});
 const first=await reader.read(new Uint8Array(8));assert.deepEqual([...first.value],[4,5]);
 assert.equal((await reader.read(new Uint8Array(8))).done,true);reader.releaseLock();await fx.close();proofs++;
}
{
 const fx=owner();const pulling=gate(),pullHold=gate(),cancelling=gate(),cancelHold=gate();
 const result=await fx.owned.channel(channel(async()=>new Response(new ReadableStream({async pull(){pulling.release();await pullHold.promise},async cancel(){cancelling.release();await cancelHold.promise}},{highWaterMark:0})))).handleInbound(request);
 const reader=result.body.getReader();const read=reader.read();await pulling.promise;
 let closed=false;const closing=fx.close().then(()=>{closed=true});const cancel=reader.cancel();
 try {await cancelling.promise;await read;await new Promise(setImmediate);assert.equal(closed,false);assert.equal(fx.tracker.inFlight('fixture'),1)}
 finally {cancelHold.release();pullHold.release();await cancel;await closing;reader.releaseLock()}proofs++;
}
{
 const fx=owner();const hold=gate(),entered=gate();let closed=false;
 const source={id:'fixture',label:'Fixture',capabilities:['tts-stream'],synthesizeStream(){return {providerId:'fixture',mimeType:'audio/wav',format:'wav',metadata:{},chunks:(async function*(){try{yield {data:new Uint8Array([1]),sequence:0}}finally{entered.release();await hold.promise}})()}}};
 const stream=await fx.owned.voice(source).synthesizeStream({text:''});const iterator=stream.chunks[Symbol.asyncIterator]();
 assert.equal((await iterator.next()).value.sequence,0);const closing=fx.close().then(()=>{closed=true});const returned=iterator.return();
 try {await entered.promise;assert.equal(closed,false)}finally{hold.release();await returned;await closing}proofs++;
}
console.log(JSON.stringify({proofs}));
`);
    const result = spawnSync(node, [join(root, 'probe.mjs')], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({ proofs: 4 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);
