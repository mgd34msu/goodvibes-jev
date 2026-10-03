import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { HostedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/hosted-sessions';
import type { DaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import * as endpoint from '../../runtime/client/operator-endpoint.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { getSharedHostedSessionFeed, resetSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';

const calls: string[] = [];
const attached = new Set<string>();
let failAttach: string | null = null;
let failDetach = new Set<string>();
let terminated = new Set<string>();
let killPolicy = new Set<string>();
let holdKill: Promise<void> | null = null;
let holdDetach: { id: string; wait: Promise<void> } | null = null;
let holdCreate: Promise<void> | null = null;
let holdAttach: { id: string; wait: Promise<void> } | null = null;
const record = (id: string): HostedSessionRecord => ({id,workspaceRoot:'/synthetic/work',title:id,status:terminated.has(id)?'terminated':'idle',detachPolicy:killPolicy.has(id)?'kill':'survive',effectiveDetachPolicy:killPolicy.has(id)?'kill':'survive',attachedClients:attached.has(id)?['synthetic']:[],createdAt:1,updatedAt:1,turnCount:0,messageCount:0,restoredFromDisk:false,contractIds:[]});
const verbs: DaemonVerbCaller = {probe:()=>({available:false,reason:'synthetic recording transport'}),async invoke<T>(method: string, input?: unknown): Promise<T> {
 if(method==='sessions.hosted.create') { calls.push('sessions.hosted.create:B'); if(holdCreate) await holdCreate; attached.add('B'); return {session:record('B')} as T; }
 const id = (input as {sessionId:string}).sessionId; calls.push(`${method}:${id}`);
 if(method==='sessions.hosted.attach') { if(holdAttach?.id===id) await holdAttach.wait; if(failAttach===id) throw new Error('synthetic attach refusal'); attached.add(id);return {session:record(id),history:[]} as T; }
 if(method==='sessions.hosted.kill') { if(holdKill) await holdKill; attached.delete(id); terminated.add(id); return {session:record(id)} as T; }
 if(method==='sessions.hosted.detach') { if(holdDetach?.id===id) await holdDetach.wait; if(failDetach.has(id)) throw new Error('synthetic detach refusal'); attached.delete(id); if(killPolicy.has(id)) terminated.add(id);return {session:record(id)} as T; }
 throw new Error(`unexpected synthetic verb ${method}`);
}};
mock.module('../../runtime/client/operator-endpoint.ts',()=>({...endpoint,createDaemonVerbCaller:()=>verbs,resolveControlPlaneBaseUrl:()=>null}));
const {registerHostedRuntimeCommands,resetHostedCommandState}=await import('../../input/commands/hosted-runtime.ts');
const {leaveHostedSessionOnExit}=await import('../../runtime/client/hosted-exit.ts');
let registry:CommandRegistry;let output:string[];
const context=():CommandContext=>({platform:{configManager:{}},workspace:{shellPaths:{homeDirectory:'/synthetic',workingDirectory:'/synthetic/work'}},print:(s:string)=>output.push(s),openAgents:()=>{}} as unknown as CommandContext);
const run=(...args:string[])=>registry.execute('hosted',args,context());
beforeEach(()=>{resetSharedHostedSessionFeed();resetHostedCommandState();calls.length=0;attached.clear();failAttach=null;failDetach.clear();holdCreate=null;holdAttach=null;holdKill=null;holdDetach=null;terminated.clear();killPolicy.clear();output=[];registry=new CommandRegistry();registerHostedRuntimeCommands(registry);});
afterEach(()=>resetSharedHostedSessionFeed());

test('successful A to B replacement releases A and final detach releases B without kill',async()=>{
 await run('attach','A');await run('attach','B');await run('detach');
 expect(calls).toEqual(['sessions.hosted.attach:A','sessions.hosted.attach:B','sessions.hosted.detach:A','sessions.hosted.detach:B']);
 expect([...attached]).toEqual([]);expect(getSharedHostedSessionFeed().getState().record).toBeNull();
});

test('failed new attach preserves old feed and attachment',async()=>{
 await run('attach','A');failAttach='B';await run('attach','B');
 expect([...attached]).toEqual(['A']);expect(getSharedHostedSessionFeed().getState().record?.id).toBe('A');expect(output.join('\n')).toContain('synthetic attach refusal');
});

test('failure releasing old attachment retains B for explicit cleanup and keeps A active',async()=>{
 await run('attach','A');failDetach.add('A');await run('attach','B');
 expect([...attached]).toEqual(['A','B']);expect(getSharedHostedSessionFeed().getState().record?.id).toBe('A');expect(calls).not.toContain('sessions.hosted.detach:B');expect(output.join(' ')).toContain('B remains owned pending cleanup');
});

test('shutdown while B attach is held drains both attachments without reopening the feed',async()=>{
 await run('attach','A');let release!:()=>void;holdAttach={id:'B',wait:new Promise<void>(resolve=>{release=resolve;})};
 const switching=run('attach','B');await new Promise(resolve=>setImmediate(resolve));
 const leaving=leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic',timeoutMs:1000});release();
 await switching;expect(await leaving).toBe('detached');expect([...attached]).toEqual([]);expect(getSharedHostedSessionFeed().getState().record).toBeNull();
});


test('reattaching the same session never detaches its own current attachment',async()=>{
 await run('attach','A');await run('attach','A');
 expect(calls).toEqual(['sessions.hosted.attach:A','sessions.hosted.attach:A']);expect([...attached]).toEqual(['A']);
 await run('detach');expect([...attached]).toEqual([]);
});

test('a queued explicit detach observes the replacement that actually completed',async()=>{
 await run('attach','A');let release!:()=>void;holdAttach={id:'B',wait:new Promise<void>(resolve=>{release=resolve;})};
 const switching=run('attach','B');await new Promise(resolve=>setImmediate(resolve));const detaching=run('detach');release();await Promise.all([switching,detaching]);
 expect([...attached]).toEqual([]);expect(calls).toEqual(['sessions.hosted.attach:A','sessions.hosted.attach:B','sessions.hosted.detach:A','sessions.hosted.detach:B']);
});

test('failed old detach keeps both receipts owned for a successful final exit retry',async()=>{
 await run('attach','A');failDetach.add('A');failDetach.add('B');await run('attach','B');
 expect([...attached]).toEqual(['A','B']);expect(output.join(' ')).toContain('pending cleanup');
 failDetach.clear();expect(await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'})).toBe('detached');
 expect([...attached]).toEqual([]);expect(calls.filter(c=>c.includes('kill'))).toEqual([]);
});

test('shutdown drains a first attachment that had no visible record when exit began',async()=>{
 let release!:()=>void;holdAttach={id:'B',wait:new Promise<void>(resolve=>{release=resolve;})};
 const attaching=run('attach','B');await new Promise(resolve=>setImmediate(resolve));
 const leaving=leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'});release();await attaching;
 expect(await leaving).toBe('detached');expect([...attached]).toEqual([]);expect(getSharedHostedSessionFeed().getState().record).toBeNull();
});

test('shutdown during new creation releases its implicit attachment without a late attach',async()=>{
 let release!:()=>void;holdCreate=new Promise<void>(resolve=>{release=resolve;});
 const creating=run('new');await new Promise(resolve=>setImmediate(resolve));
 const leaving=leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'});release();await creating;
 expect(await leaving).toBe('detached');expect(calls).toEqual(['sessions.hosted.create:B','sessions.hosted.detach:B']);expect([...attached]).toEqual([]);
 expect(getSharedHostedSessionFeed().getState().record).toBeNull();
});

test('a bounded exit timeout does not permit a late receipt to reopen the feed',async()=>{
 let release!:()=>void;holdAttach={id:'B',wait:new Promise<void>(resolve=>{release=resolve;})};
 const attaching=run('attach','B');await new Promise(resolve=>setImmediate(resolve));
 expect(await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic',timeoutMs:10})).toBe('failed');
 release();await attaching;await new Promise(resolve=>setImmediate(resolve));
 expect([...attached]).toEqual([]);expect(getSharedHostedSessionFeed().getState().record).toBeNull();
});


test('a pending failed switch bounds ownership and can retry the same B without detaching B',async()=>{
 await run('attach','A');failDetach.add('A');await run('attach','B');await run('attach','C');await run('new');
 expect([...attached]).toEqual(['A','B']);expect(calls).not.toContain('sessions.hosted.attach:C');expect(calls).not.toContain('sessions.hosted.create:B');
 failDetach.clear();await run('attach','B');expect([...attached]).toEqual(['B']);expect(getSharedHostedSessionFeed().getState().record?.id).toBe('B');
 expect(calls).not.toContain('sessions.hosted.detach:B');await run('detach');expect([...attached]).toEqual([]);
});


test('explicit detach during first admission releases its eventual receipt without showing a late feed',async()=>{
 let release!:()=>void;holdAttach={id:'B',wait:new Promise<void>(resolve=>{release=resolve;})};
 const attaching=run('attach','B');await new Promise(resolve=>setImmediate(resolve));const detaching=run('detach');release();
 await Promise.all([attaching,detaching]);expect([...attached]).toEqual([]);expect(getSharedHostedSessionFeed().getState().record).toBeNull();
 expect(output.join(' ')).not.toContain('[hosted] attached to');
 await run('attach','A');expect(getSharedHostedSessionFeed().getState().record?.id).toBe('A');
});

test('throwing old stream cleanup cannot strand ownership after A was detached',async()=>{
 await run('attach','A');getSharedHostedSessionFeed().bindStream(()=>{throw new Error('synthetic stream closer failure');});await run('attach','B');
 expect([...attached]).toEqual(['B']);expect(getSharedHostedSessionFeed().getState().record?.id).toBe('B');expect(output.join(' ')).toContain('previous stream cleanup failed');
 expect(await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'})).toBe('detached');expect([...attached]).toEqual([]);
});

test('already-terminated current session closes its local stream without a remote detach or kill',async()=>{
 await run('attach','A');const feed=getSharedHostedSessionFeed();feed.setRecord({...record('A'),status:'terminated'});let closed=0;feed.bindStream(()=>{closed++;});
 expect(await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'})).toBe('none');expect(closed).toBe(1);
 expect(calls).toEqual(['sessions.hosted.attach:A']);expect(feed.getState().record).toBeNull();
});


const {createHostedSessionsClient}=await import('../../runtime/client/hosted-sessions.ts');
const {replaceHostedAttachment,detachHostedAttachments}=await import('../../runtime/client/hosted-attachments.ts');
const {watchHostedSession}=await import('../../runtime/client/hosted-session-stream.ts');

test('review: refused detach must not claim its aborted real SSE stream is open',async()=>{
 const feed=getSharedHostedSessionFeed();const client=createHostedSessionsClient(verbs);let fetchAborted=false;
 await replaceHostedAttachment(feed,client,'A',async(attachment,signal)=>{
  const subscription=await watchHostedSession({baseUrl:'http://synthetic.invalid',sessionId:attachment.session.id,signal,onEvent:()=>{},fetchImpl:(async(_url,init)=>{
   const body=new ReadableStream<Uint8Array>({start(controller){init?.signal?.addEventListener('abort',()=>{fetchAborted=true;controller.close();},{once:true});}});
   return new Response(body,{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch});
  feed.bindStream(()=>subscription?.close());feed.setStreaming(subscription!==null);
 });
 expect(feed.getState().streaming).toBe(true);failDetach.add('A');
 await expect(detachHostedAttachments(feed,client)).rejects.toThrow('synthetic detach refusal');
 expect(fetchAborted).toBe(true);expect(feed.getState().record?.id).toBe('A');
 expect(feed.getState().streaming).toBe(false);
});

test('review: retrying exit after transient detach refusal must retry retained receipt',async()=>{
 await run('attach','A');failDetach.add('A');
 expect(await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'})).toBe('failed');
 failDetach.clear();const again=await leaveHostedSessionOnExit({configManager:context().platform.configManager,homeDirectory:'/synthetic'});
 expect(again).toBe('detached');expect([...attached]).toEqual([]);
});

test('review: explicit detach after retained mixed-policy receipt reports B termination',async()=>{
 await run('attach','A');killPolicy.add('B');failDetach.add('A');await run('attach','B');
 failDetach.clear();output=[];await run('detach');
 expect([...attached]).toEqual([]);expect([...terminated]).toEqual(['B']);
 expect(output.join(' ')).toContain('B');expect(output.join(' ')).toContain('ended');
});

test('review: kill A delayed across switch B must not clear B and allow three receipts',async()=>{
 await run('attach','A');let release!:()=>void;holdKill=new Promise<void>(resolve=>{release=resolve;});
 const killing=run('kill','A');await new Promise(resolve=>setImmediate(resolve));await run('attach','B');release();await killing;
 expect(getSharedHostedSessionFeed().getState().record?.id).toBe('B');
});
