import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordAgentCiArtifact, verifyAgentCiArtifact } from '../../../scripts/ci-artifact.ts';

const revision = 'a'.repeat(40);
test('the archive round trip preserves binary, library, provenance and executable mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ci-artifact-'));
  const source = join(dir, 'source');
  const restored = join(dir, 'restored');
  try {
    mkdirSync(join(source, 'dist/lib/sqlite-vec-linux-x64'), { recursive: true });
    mkdirSync(restored);
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64'), 'synthetic compiled artifact', { mode: 0o755 });
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun'), 'synthetic ordinary runtime', { mode: 0o755 });
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun.LICENSE.md'), 'synthetic runtime notices');
    writeFileSync(join(source, 'dist/goodvibes-agent-linux-x64.bun.json'), 'synthetic runtime provenance');
    writeFileSync(join(source, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native addon');
    recordAgentCiArtifact(source, revision);
    const archive = join(dir, 'artifact.tgz');
    expect(spawnSync('tar', ['-czf', archive, '-C', source, 'dist']).status).toBe(0);
    expect(spawnSync('tar', ['-xzf', archive, '-C', restored]).status).toBe(0);
    expect(() => verifyAgentCiArtifact(restored, revision)).not.toThrow();
    expect(() => verifyAgentCiArtifact(restored, 'b'.repeat(40))).toThrow(/manifest/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64'), 0o644);
    expect(() => verifyAgentCiArtifact(restored, revision)).toThrow(/executable/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64'), 0o755);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun'), 0o644);
    expect(() => verifyAgentCiArtifact(restored, revision)).toThrow(/executable/);
    chmodSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun'), 0o755);
    writeFileSync(join(restored, 'dist/goodvibes-agent-linux-x64.bun.LICENSE.md'), 'changed notice');
    expect(() => verifyAgentCiArtifact(restored, revision)).toThrow(/manifest/);
    writeFileSync(join(restored, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'changed addon');
    expect(() => verifyAgentCiArtifact(restored, revision)).toThrow(/manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
