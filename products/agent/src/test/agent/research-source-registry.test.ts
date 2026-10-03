import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentResearchSourceRegistry, researchSourceReportLine, researchSourceStorePath } from '../../agent/research-source-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeRegistry(): { readonly root: string; readonly registry: AgentResearchSourceRegistry; readonly cleanup: () => void } {
  const root = makeProjectTempDir('goodvibes-agent-research-sources');
  const shellPaths = {
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
  };
  return {
    root,
    registry: AgentResearchSourceRegistry.fromShellPaths(shellPaths),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('AgentResearchSourceRegistry', () => {
  test('stores project-local source candidates with redacted URLs and report lines', () => {
    const fixture = makeRegistry();
    try {
      const source = fixture.registry.create({
        question: 'Which local model route should we try first?',
        title: 'Ollama docs',
        url: 'https://example.test/ollama?token=secret-token',
        publisher: 'Ollama',
        summary: 'Official setup docs for the simple local route.',
        evidence: 'The setup path is short.',
        tags: ['research', 'local'],
      });

      expect(source.id).toBe('ollama-docs');
      expect(source.status).toBe('candidate');
      expect(source.credibility).toBe('unreviewed');
      expect(source.url).toContain('token=%3Credacted%3E');
      expect(source.url).not.toContain('secret-token');
      expect(researchSourceReportLine(source)).toContain('Ollama docs');
      expect(researchSourceStorePath({
        resolveProjectPath: (...parts: string[]) => join(fixture.root, '.goodvibes', ...parts),
      })).toContain(join('.goodvibes', 'agent', 'research', 'sources.json'));
    } finally {
      fixture.cleanup();
    }
  });

  test('reviews, rejects, marks used, searches, and deletes sources', () => {
    const fixture = makeRegistry();
    try {
      const source = fixture.registry.create({
        question: 'What should the report cite?',
        title: 'Primary source',
        url: 'https://example.test/source',
        summary: 'Primary source summary.',
      });
      const reviewed = fixture.registry.review(source.id, {
        credibility: 'high',
        score: 93,
        note: 'Primary source and current.',
      });
      expect(reviewed.status).toBe('reviewed');
      expect(reviewed.credibility).toBe('high');
      expect(reviewed.score).toBe(93);
      expect(fixture.registry.snapshot().reviewed).toHaveLength(1);
      expect(fixture.registry.search('primary')).toHaveLength(1);

      const used = fixture.registry.markUsed(source.id, { reportArtifactId: 'artifact-1' });
      expect(used.status).toBe('used');
      expect(used.usedInReportArtifactId).toBe('artifact-1');

      const rejected = fixture.registry.reject(source.id, 'Superseded by a newer source.');
      expect(rejected.status).toBe('rejected');
      expect(rejected.note).toContain('Superseded');

      const deleted = fixture.registry.delete(source.id);
      expect(deleted.id).toBe(source.id);
      expect(fixture.registry.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt store throws plain-language error', () => {
    const fixture = makeRegistry();
    try {
      fixture.registry.create({
        question: 'Seed question',
        title: 'Seed source',
        summary: 'Seeded so the store file exists.',
      });
      writeFileSync(researchSourceStorePath({ resolveProjectPath: (...parts: string[]) => join(fixture.root, '.goodvibes', ...parts) }), '{corrupt json', 'utf-8');
      expect(() => fixture.registry.list()).toThrow('Could not read Agent research source store');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects duplicate source URLs', () => {
    const fixture = makeRegistry();
    try {
      fixture.registry.create({
        question: 'Duplicate check',
        title: 'Source one',
        url: 'https://example.test/source',
        summary: 'First source.',
      });
      expect(() => fixture.registry.create({
        question: 'Duplicate check',
        title: 'Source two',
        url: 'https://example.test/source',
        summary: 'Second source.',
      })).toThrow('already exists');
    } finally {
      fixture.cleanup();
    }
  });
});
