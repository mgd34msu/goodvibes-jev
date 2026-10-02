import * as fs from 'node:fs';
import { mock } from 'bun:test';

export interface WorkLedgerAncestryInput {
  readonly dbPath: string;
  readonly failDirectory: string;
  readonly lateCloseFailure: boolean;
}
const input = JSON.parse(process.argv[2]!) as WorkLedgerAncestryInput;
const native = { ...fs };
const paths = new Map<number, string>();
let failures = 2;
const events: { operation: string; path: string | undefined }[] = [];
mock.module('node:fs', () => ({
  ...native,
  openSync(...args: Parameters<typeof fs.openSync>) {
    const fd = native.openSync(...args); paths.set(fd, String(args[0])); return fd;
  },
  fsyncSync(fd: number) {
    const path = paths.get(fd); events.push({ operation: 'fsync', path });
    if (path === input.failDirectory && failures > 0) { failures--; throw new Error('Injected ancestor durability failure'); }
    native.fsyncSync(fd);
  },
  closeSync(fd: number) {
    const path = paths.get(fd); native.closeSync(fd); paths.delete(fd);
    if (input.lateCloseFailure && path === input.failDirectory) throw new Error('Injected post-sync directory close failure');
  },
}));

const { KnowledgeStore } = await import('../../sdk/src/platform/knowledge/store.js');
const { createWorkLedger } = await import('../../sdk/src/platform/workflow/work-ledger/service.js');
const command = { type: 'create', requestId: 'durable', expectedRevision: 0, title: 'Durable', goal: 'Persist every ancestor', criteria: ['Ancestry durable'] };
const attempts: string[] = [];
let owner: InstanceType<typeof KnowledgeStore> | undefined;
let ledger: ReturnType<typeof createWorkLedger> | undefined;
let actor: ReturnType<ReturnType<typeof createWorkLedger>['authority']['issueActor']> | undefined;
for (let index = 0; index < 3; index++) {
  if (index === 2) failures = 0;
  events.push({ operation: `attempt-${index}`, path: undefined });
  owner = new KnowledgeStore({ dbPath: input.dbPath });
  try {
    const storage = await owner.openWorkLedgerStorage('project');
    ledger = createWorkLedger({ projectId: 'project', storage, clock: { now: () => 1, newId: kind => `${kind}-1` } });
    actor = ledger.authority.issueActor({ projectId: 'project', actorId: 'coordinator', role: 'coordinator' });
    const result = await ledger.service.execute(command, actor);
    attempts.push(result.kind === 'accepted' ? result.replayed ? 'replayed' : 'accepted' : result.kind);
  } catch { attempts.push('failed'); }
  if (index < 2) { await ledger?.service.close(); await owner.close(); ledger = undefined; }
}
if (!ledger || !actor || !owner) throw new Error('Final healthy acquisition failed');
const bytes = native.readFileSync(input.dbPath);
failures = 1;
const uncertainReplay = await ledger.service.execute(command, actor);
const replay = await ledger.service.execute(command, actor);
const history = await ledger.service.history(0, actor);
const unchanged = bytes.equals(native.readFileSync(input.dbPath));
await ledger.service.close(); await owner.close();
console.log(JSON.stringify({ attempts, uncertainReplay, replay, historyLength: history.length, unchanged, events }));
