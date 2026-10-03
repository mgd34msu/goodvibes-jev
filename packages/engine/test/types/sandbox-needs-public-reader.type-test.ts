import {
  decideSandboxedExec,
  readCommandNeeds,
  type CommandNeeds,
  type SandboxPolicyDecision,
} from '@goodvibes-jev/engine/sdk/platform/runtime/permissions/sandbox-policy';

async function publicSandboxPolicy(command: string, workspace?: string): Promise<SandboxPolicyDecision> {
  const needs: CommandNeeds = await readCommandNeeds(command, workspace);
  return decideSandboxedExec({
    command, needs, sandboxActive: true, egressAllowlist: [], baseEffectWhenNotSandboxed: 'ask',
  });
}

void publicSandboxPolicy;
