import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentDocumentRegistry, documentStorePath, renderAgentDocumentMarkdown } from '../../agent/document-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function registry(): AgentDocumentRegistry {
  const root = makeProjectTempDir('goodvibes-agent-documents');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return AgentDocumentRegistry.fromShellPaths(shellPaths);
}

describe('AgentDocumentRegistry', () => {
  test('creates versioned project-scoped document drafts', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Launch Plan',
      body: 'Initial markdown draft.',
      tags: ['docs', 'launch'],
    });

    expect(created.id).toBe('launch-plan');
    expect(created.status).toBe('draft');
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]?.summary).toBe('Initial draft.');
    expect(documents.get('Launch Plan')?.id).toBe(created.id);
  });

  test('updates drafts by appending a new version without losing history', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Runbook',
      body: 'Step one.',
    });
    const updated = documents.update(created.id, {
      body: 'Step one.\n\nStep two.',
      tags: ['runbook'],
      summary: 'Added the second step.',
    });

    expect(updated.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
    expect(updated.versions[1]?.summary).toBe('Added the second step.');
    expect(updated.body).toContain('Step two.');
    expect(documents.search('Step two')[0]?.id).toBe(created.id);
  });

  test('renders markdown export metadata for the latest version', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Brief',
      body: 'Reviewed body.',
      tags: ['brief'],
    });
    const reviewed = documents.markReviewed(created.id);
    const markdown = renderAgentDocumentMarkdown(reviewed);

    expect(reviewed.status).toBe('reviewed');
    expect(markdown).toContain('# Brief');
    expect(markdown).toContain('Version: v2');
    expect(markdown).toContain('Status: reviewed');
    expect(markdown).toContain('Reviewed body.');
  });

  test('adds and resolves review comments without changing versions', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Reviewable Draft',
      body: 'Body under review.',
    });
    const commented = documents.addComment(created.id, { body: 'Tighten the opening.' });

    expect(commented.comments).toHaveLength(1);
    expect(commented.comments[0]?.id).toBe('c1');
    expect(commented.comments[0]?.status).toBe('open');
    expect(commented.versions).toHaveLength(1);
    expect(documents.search('opening')[0]?.id).toBe(created.id);

    const resolved = documents.resolveComment(created.id, 'c1');
    expect(resolved.comments[0]?.status).toBe('resolved');
    expect(resolved.comments[0]?.resolvedAt).toBeString();
    expect(resolved.versions).toHaveLength(1);
    const markdown = renderAgentDocumentMarkdown(resolved);
    expect(markdown).toContain('Comments: 0 open / 1 total');
    expect(markdown).toContain('## Review Comments');
    expect(markdown).toContain('c1 [resolved] Tighten the opening.');
  });

  test('attaches artifacts without changing document body versions', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Attachment Draft',
      body: 'Body with external evidence.',
    });
    const attached = documents.attachArtifact(created.id, {
      artifactId: 'artifact-123',
      label: 'Reviewed chart',
      note: 'Use this chart as supporting evidence.',
      filename: 'chart.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 2048,
    });

    expect(attached.attachments).toHaveLength(1);
    expect(attached.attachments[0]?.id).toBe('a1');
    expect(attached.attachments[0]?.artifactId).toBe('artifact-123');
    expect(attached.versions).toHaveLength(1);
    expect(attached.body).toBe(created.body);
    expect(documents.search('chart.png')[0]?.id).toBe(created.id);

    const markdown = renderAgentDocumentMarkdown(attached);
    expect(markdown).toContain('Attachments: 1');
    expect(markdown).toContain('## Attached Artifacts');
    expect(markdown).toContain('a1: Reviewed chart (artifact-123, chart.png / image/png / image)');
  });

  test('corrupt store throws plain-language error', () => {
    const root = makeProjectTempDir('goodvibes-agent-documents-corrupt');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const storePath = documentStorePath(shellPaths);
    const documents = AgentDocumentRegistry.fromShellPaths(shellPaths);
    // seed a record so the store file exists
    documents.create({ title: 'Init Doc', body: 'Body.' });
    // corrupt it
    writeFileSync(storePath, '{corrupt json', 'utf-8');
    expect(() => documents.list()).toThrow('Could not read Agent document store');
  });

  test('stores accepts and rejects AI suggestions through explicit review', () => {
    const documents = registry();
    const created = documents.create({
      title: 'Suggestion Draft',
      body: 'Original body.',
      tags: ['draft'],
    });
    const suggested = documents.suggestUpdate(created.id, {
      body: 'Suggested replacement body.',
      tags: ['draft', 'accepted'],
      summary: 'Rewrite for clarity.',
      rationale: 'The replacement is more direct for the user.',
    });

    expect(suggested.suggestions).toHaveLength(1);
    expect(suggested.suggestions[0]?.id).toBe('s1');
    expect(suggested.suggestions[0]?.status).toBe('proposed');
    expect(suggested.body).toBe('Original body.');
    expect(suggested.versions).toHaveLength(1);
    expect(documents.search('more direct')[0]?.id).toBe(created.id);
    const suggestedMarkdown = renderAgentDocumentMarkdown(suggested);
    expect(suggestedMarkdown).toContain('Suggestions: 1 proposed / 1 total');
    expect(suggestedMarkdown).toContain('## AI Suggestions');
    expect(suggestedMarkdown).toContain('s1 [proposed] Rewrite for clarity.');
    expect(suggestedMarkdown).toContain('Rationale: The replacement is more direct for the user.');
    expect(suggestedMarkdown).not.toContain('Suggested replacement body.');

    const accepted = documents.acceptSuggestion(created.id, 's1');
    expect(accepted.body).toBe('Suggested replacement body.');
    expect(accepted.tags).toEqual(['draft', 'accepted']);
    expect(accepted.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
    expect(accepted.versions[1]?.summary).toBe('Rewrite for clarity.');
    expect(accepted.suggestions[0]?.status).toBe('accepted');
    const acceptedMarkdown = renderAgentDocumentMarkdown(accepted);
    expect(acceptedMarkdown).toContain('Suggestions: 0 proposed / 1 total');
    expect(acceptedMarkdown).toContain('s1 [accepted] Rewrite for clarity.');

    const second = documents.suggestUpdate(created.id, {
      body: 'Rejected replacement body.',
      summary: 'Alternative rewrite.',
      rationale: 'This rewrite is intentionally not used.',
    });
    const rejected = documents.rejectSuggestion(created.id, 's2');
    expect(second.suggestions[1]?.status).toBe('proposed');
    expect(rejected.suggestions[1]?.status).toBe('rejected');
    expect(rejected.body).toBe('Suggested replacement body.');
    expect(rejected.versions).toHaveLength(2);
  });
});
