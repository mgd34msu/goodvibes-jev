import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as endpoint from '../../runtime/client/operator-endpoint.ts';
import * as pairing from '@goodvibes-jev/engine/sdk/platform/pairing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { getSharedHostedSessionFeed, resetSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';
const guardedFetch=globalThis.fetch;
const attached=new Set<string>();const calls:string[]=[];let failDetach=false;let aborted=0;let streams=0;let output:string[]=[];
const record=(id:string)=>({id,workspaceRoot:'/synthetic/work',title:id,status:'idle',detachPolicy:'survive',effectiveDetachPolicy:'survive',attachedClients:attached.has(id)?['synthetic']:[],createdAt:1,updatedAt:1,turnCount:0,messageCount:0,restoredFromDisk:false,contractIds:[]});
const verbs={probe:()=>({available:false,reason:'synthetic'}),async invoke(method:string,input:{sessionId:string}){const id=input.sessionId;calls.push(`${method}:${id}`);if(method==='sessions.hosted.attach'){attached.add(id);return {session:record(id),history:[]};}if(method==='sessions.hosted.detach'){if(failDetach) throw new Error('synthetic refusal');attached.delete(id);return {session:record(id)};}throw new Error(`unexpected ${method}`);}};
mock.module('../../runtime/client/operator-endpoint.ts',()=>({...endpoint,createDaemonVerbCaller:()=>verbs,resolveControlPlaneBaseUrl:()=> 'http://synthetic.invalid',resolveDaemonStateDirectory:()=>'/synthetic/daemon'}));
mock.module('@goodvibes-jev/engine/sdk/platform/pairing',()=>({...pairing,getOrCreateCompanionToken:()=>({token:'synthetic-local-fixture'})}));
const {registerHostedRuntimeCommands}=await import('../../input/commands/hosted-runtime.ts');
let registry:CommandRegistry;
const context=():CommandContext=>({platform:{configManager:{}},workspace:{shellPaths:{homeDirectory:'/synthetic',workingDirectory:'/synthetic/work'}},print:(s:string)=>output.push(s),openAgents:()=>{}} as unknown as CommandContext);
const run=(...args:string[])=>registry.execute('hosted',args,context());
beforeEach(()=>{resetSharedHostedSessionFeed();attached.clear();calls.length=0;failDetach=false;aborted=0;streams=0;output=[];registry=new CommandRegistry();registerHostedRuntimeCommands(registry);globalThis.fetch=(async(input,init)=>{
 const url=String(input);if(url!=='http://synthetic.invalid/api/control-plane/events?domains=turn%2Ctools%2Csession'||init?.method!=='GET') return guardedFetch(input,init);
 streams++;return new Response(new ReadableStream<Uint8Array>({start(controller){init?.signal?.addEventListener('abort',()=>{aborted++;controller.close();},{once:true});}}),{headers:{'content-type':'text/event-stream'}});
}) as typeof fetch;});
afterEach(()=>{getSharedHostedSessionFeed().closeStream();globalThis.fetch=guardedFetch;resetSharedHostedSessionFeed();});
test('actual command + actual hosted/SSE stream: detach refusal must expose disconnected feed',async()=>{
 await run('attach','A');expect(streams).toBe(1);expect(getSharedHostedSessionFeed().getState().streaming).toBe(true);
 failDetach=true;await run('detach');await run('status');
 expect(aborted).toBe(1);expect(attached.has('A')).toBe(true);expect(getSharedHostedSessionFeed().getState().streaming).toBe(false);
 expect(output.at(-1)).toContain('no live stream'); expect(output.at(-1)).not.toContain('live event stream open');
 failDetach=false;await run('attach','A');expect(streams).toBe(2);expect(getSharedHostedSessionFeed().getState().streaming).toBe(true);
});
