import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { classifyProviderSetup } from '../../cli/provider-classification.ts';

const previous = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(previous));

test('actual remote API setup overrides a provider id formerly assumed local', async () => {
  const fixture = fakePort(name => noulAnswer(name === 'api_key' ? .99 : .01));
  installJudgmentPort(fixture.port);
  const result = await classifyProviderSetup({ providerId: 'ollama', runtime: {
    auth: { mode: 'api-key', configured: true, detail: 'Remote cloud API bills per token.' }, policy: { local: false },
  } });
  expect(result.setupClass).toBe('api-key');
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.context?.battery).toBe('providers.setup-presentation');
  expect(JSON.parse(String(fixture.requests[0]?.state)).provider.local).toBe(false);
});

test('anonymous access and listed models do not establish free hosted access', async () => {
  const fixture = fakePort(() => noulAnswer(.01));
  installJudgmentPort(fixture.port);
  const result = await classifyProviderSetup({ providerId: 'example-free', runtime: {
    auth: { mode: 'anonymous', configured: true }, models: { models: ['one', 'two', 'three'] },
  } });
  expect(result.setupClass).toBe('unknown');
});

test('legacy provider names without runtime facts make no setup promise or reading', async () => {
  const fixture = fakePort(() => { throw new Error('Provider id alone must not request a semantic guess'); });
  installJudgmentPort(fixture.port);
  for (const providerId of ['synthetic', 'openai-subscriber', 'amazon-bedrock']) {
    expect((await classifyProviderSetup({ providerId })).setupClass).toBe('unknown');
  }
  expect(fixture.requests).toHaveLength(0);
});

test("actual CLI waits for provider facts and shares one reading across each provider's model rows", () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-provider-facts-'));
  const source = `
import { mock } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { parseGoodVibesCli } from '@goodvibes-jev/engine/terminal-shell';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
const facts = {
 gateway: { auth: { mode: 'anonymous', configured: true }, setup: { description: 'Operator-managed gateway with independently billed upstreams.' } },
 subscription: { auth: { mode: 'oauth', configured: true }, setup: { description: 'Stored subscription session.' } }, missing: {},
};
const models = Object.keys(facts).flatMap(provider => ['one','two'].map(id => ({provider,id,registryKey:provider+':'+id,displayName:id,selectable:true,contextWindow:2048})));
const providers = Object.fromEntries(Object.keys(facts).map(name => [name,{name,models:['one','two'],describeRuntime:async()=>facts[name]}]));
let closed=0;
const providerRegistry = {
 listProviders:()=>Object.values(providers), getRegistered:id=>providers[id], describeRuntime:async id=>facts[id],
 getCurrentModel:()=>models[0], listModels:()=>models, getSelectableModels:()=>models,
 resolveModelPricing:()=>({status:'unpriced'}),getContextWindowForModel:()=>2048,getKnownContextWindowForModel:()=>2048,
 initModelLimits(){},initCatalog(){},ready:async()=>{},stopWatching(){},
};
const actualRuntime=await import('./src/runtime/services.ts');
mock.module('./src/runtime/services.ts',()=>({...actualRuntime,createRuntimeServices:()=>({providerRegistry,benchmarkStore:{initBenchmarks(){}},async close(){closed++;}})}));
const {handleGoodVibesCliCommand}=await import('./src/cli/management.ts');
const configManager=new ConfigManager({surfaceRoot:'agent',workingDir:process.env.HOME,homeDir:process.env.HOME});
const runtime=args=>({cli:parseGoodVibesCli(args,'goodvibes-agent'),configManager,workingDirectory:process.env.HOME,homeDirectory:process.env.HOME});
const names=new Set(['api_key','cloud_account','local_runtime','no_key_free','self_hosted','subscription']);
const fixture=fakePort((name,question,state)=>{
 if(!names.has(name)||question.type!=='noul'||typeof state!=='string')throw new Error('Unexpected provider setup reading');
 const provider=JSON.parse(state).provider;
 if(!Object.hasOwn(facts,provider.id))throw new Error('Unexpected provider setup facts');
 return noulAnswer(name==='self_hosted'&&provider.id==='gateway'||name==='subscription'&&provider.id==='subscription' ? .99 : .01);
});
let release;const wait=new Promise(r=>{release=r;});
installJudgmentPort({...fixture.port,async ask(request){await wait;return fixture.port.ask(request);}});
const printed=[];console.log=text=>{printed.push(text);};
const listing=handleGoodVibesCliCommand(runtime(['providers','list','--json']));
await new Promise(r=>setTimeout(r,0));if(printed.length)throw new Error('Provider list published before reading completed');
release();if((await listing).exitCode!==0)throw new Error('Provider listing failed');
const providerRows=JSON.parse(printed.pop());fixture.requests.length=0;
if((await handleGoodVibesCliCommand(runtime(['models','list','--json']))).exitCode!==0)throw new Error('Model listing failed');
const modelRows=JSON.parse(printed.pop());
process.stdout.write(JSON.stringify({providerRows,modelRows,reads:fixture.requests.map(r=>JSON.parse(String(r.state)).provider.id),closed}));
`;
  try {
    const child = Bun.spawnSync([process.execPath, '--eval', source], {
      cwd: resolve(import.meta.dir, '../../..'),
      env: { ...process.env, HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: join(home, 'daemon') },
      stdout: 'pipe', stderr: 'pipe', timeout: 15000,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const output = JSON.parse(child.stdout.toString());
    expect(output.providerRows.map((row: { setupClass: string }) => row.setupClass)).toEqual(['self-hosted', 'subscription', 'unknown']);
    expect(output.modelRows.map((row: { setupClass: string }) => row.setupClass)).toEqual(['self-hosted', 'self-hosted', 'subscription', 'subscription', 'unknown', 'unknown']);
    expect(output.reads.sort()).toEqual(['gateway', 'missing', 'subscription']);
    expect(output.closed).toBe(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
