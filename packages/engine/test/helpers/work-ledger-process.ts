import * as fs from 'node:fs';
import type { WorkLedgerCommand, WorkLedgerEvent, WorkLedgerResult, WorkLedgerSnapshot, WorkLedgerState } from '../../sdk/src/platform/workflow/work-ledger/types.js';

export interface WorkLedgerProcessInput {
  readonly dbPath: string;
  readonly projectId: string;
  readonly label: string;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly gatePath?: string;
  readonly command?: WorkLedgerCommand;
  readonly now?: number;
  readonly hold?: { readonly phase: 'before-rename' | 'after-rename' | 'after-directory-sync'; readonly markerPath: string };
}

export interface WorkLedgerProcessOutput {
  readonly pid: number;
  readonly result: WorkLedgerResult | null;
  readonly state: WorkLedgerState;
  readonly snapshot: WorkLedgerSnapshot;
  readonly history: readonly WorkLedgerEvent[];
}

// This fixture runs in its own Bun process. Files are the parent/child barrier,
// so both competing owners have opened their stores before either can submit.
const input = JSON.parse(process.argv[2]!) as WorkLedgerProcessInput;
if (input.hold) {
  const { mock } = await import('bun:test');
  const original = { ...fs };
  const hold = input.hold;
  function pauseAtPublication(from: fs.PathLike, to: fs.PathLike): void {
    original.writeFileSync(`${hold.markerPath}.tmp`, JSON.stringify({ pid: process.pid, phase: hold.phase, from: String(from), to: String(to) }));
    original.renameSync(`${hold.markerPath}.tmp`, hold.markerPath);
    // A synchronous pause keeps the actual lock owner inside the real write.
    // The parent sends SIGKILL; this is a process-crash test, not a power-loss
    // simulation. A ceiling prevents an abandoned fixture hanging forever.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    throw new Error('Parent did not kill publication fixture');
  }
  mock.module('node:fs', () => ({
    ...original,
    fsyncSync(fd: number): void {
      original.fsyncSync(fd);
      if (hold.phase === 'after-directory-sync' && original.fstatSync(fd).isDirectory()) pauseAtPublication(input.dbPath, input.dbPath);
    },
    renameSync(from: fs.PathLike, to: fs.PathLike): void {
      const targetWrite = String(to) === input.dbPath && String(from).startsWith(`${input.dbPath}.pending-`);
      if (targetWrite && hold.phase === 'before-rename') pauseAtPublication(from, to);
      original.renameSync(from, to);
      if (targetWrite && hold.phase === 'after-rename') pauseAtPublication(from, to);
    },
  }));
}

// Load production code after the child-local publication hook is installed.
const { KnowledgeStore } = await import('../../sdk/src/platform/knowledge/store.js');
const { createWorkLedger } = await import('../../sdk/src/platform/workflow/work-ledger/service.js');
const { workLedgerStateSchema } = await import('../../sdk/src/platform/workflow/work-ledger/types.js');
const store = new KnowledgeStore({ dbPath: input.dbPath });
const storage = await store.openWorkLedgerStorage(input.projectId);
let nextId = 0;
const ledger = createWorkLedger({
  projectId: input.projectId,
  storage,
  clock: { now: () => input.now ?? 100, newId: kind => `${input.label}-${kind}-${++nextId}` },
});
const actor = ledger.authority.issueActor({ projectId: input.projectId, actorId: 'coordinator', role: 'coordinator' });
let output: WorkLedgerProcessOutput;
try {
  const initial = await ledger.service.readSnapshot(actor);
  fs.writeFileSync(`${input.readyPath}.tmp`, JSON.stringify({ pid: process.pid, revision: initial.revision }));
  fs.renameSync(`${input.readyPath}.tmp`, input.readyPath);
  if (input.gatePath) {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(input.gatePath)) {
      if (Date.now() > deadline) throw new Error('Parent did not release command barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  output = {
    pid: process.pid,
    result: input.command ? await ledger.service.execute(input.command, actor) : null,
    state: workLedgerStateSchema.parse(await storage.read()),
    snapshot: await ledger.service.readSnapshot(actor),
    history: await ledger.service.history(0, actor),
  };
} finally {
  await ledger.service.close();
  await storage.close();
  await store.close();
}
fs.writeFileSync(input.resultPath, JSON.stringify(output));
