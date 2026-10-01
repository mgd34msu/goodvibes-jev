import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { createAgentDocumentsTool, registerAgentDocumentsTool } from '../../tools/agent-documents-tool.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('goodvibes-agent-documents-tool');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const tool = createAgentDocumentsTool(shellPaths, artifactStore);
  const documents = AgentDocumentRegistry.fromShellPaths(shellPaths);
  return { root, shellPaths, artifactStore, tool, documents };
}

describe('agent_documents tool', () => {
  test('refuses document writes without explicit confirmation', async () => {
    const { tool, documents } = fixture();
    const result = await tool.execute({
      mode: 'create',
      title: 'Unconfirmed Draft',
      body: 'This should not be saved.',
      explicitUserRequest: 'Create a document draft.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('requires confirm:true');
    expect(documents.list()).toHaveLength(0);
  });

  test('creates, revises, lists, shows, reviews, and exports versioned drafts', async () => {
    const { artifactStore, tool } = fixture();
    const create = await tool.execute({
      mode: 'create',
      title: 'Launch Plan',
      body: 'Initial launch draft.',
      tags: ['launch', 'docs'],
      confirm: true,
      explicitUserRequest: 'Create a launch plan document draft.',
    });
    expect(create.success).toBe(true);
    expect(create.output).toContain('Created Agent document');
    expect(create.output).toContain('id launch-plan');

    const update = await tool.execute({
      mode: 'update',
      documentId: 'launch-plan',
      body: 'Initial launch draft.\n\nAdd rollout checklist.',
      changeSummary: 'Added rollout checklist.',
      confirm: true,
      explicitUserRequest: 'Revise the launch plan document draft.',
    });
    expect(update.success).toBe(true);
    expect(update.output).toContain('versions 2');

    const list = await tool.execute({ mode: 'list', query: 'rollout' });
    expect(list.success).toBe(true);
    expect(list.output).toContain('launch-plan');
    expect(list.output).toContain('versions 2');

    const show = await tool.execute({ mode: 'show', documentId: 'launch-plan', includeVersions: true });
    expect(show.success).toBe(true);
    expect(show.output).toContain('Add rollout checklist.');
    expect(show.output).toContain('v2');

    const sourceArtifact = await artifactStore.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'source-note.md',
      text: 'Source note body.',
      metadata: { purpose: 'source-note' },
    });
    const attached = await tool.execute({
      mode: 'attachArtifact',
      documentId: 'launch-plan',
      artifactId: sourceArtifact.id,
      attachmentLabel: 'Reviewed Source Note',
      attachmentNote: 'Keep this note available without changing the draft body.',
      confirm: true,
      explicitUserRequest: 'Attach the reviewed source note to the launch plan.',
    });
    expect(attached.success).toBe(true);
    expect(attached.output).toContain('Attached artifact to Agent document');
    expect(attached.output).toContain('attachment a1');
    expect(attached.output).toContain('attachments 1');
    expect(attached.output).toContain('versions 2');

    const attachedShow = await tool.execute({ mode: 'show', documentId: 'launch-plan', includeVersions: true });
    expect(attachedShow.success).toBe(true);
    expect(attachedShow.output).toContain('attachments 1');
    expect(attachedShow.output).toContain(`artifact ${sourceArtifact.id}`);
    expect(attachedShow.output).toContain('Keep this note available without changing the draft body.');

    const inserted = await tool.execute({
      mode: 'insertArtifact',
      documentId: 'launch-plan',
      artifactId: sourceArtifact.id,
      sectionTitle: 'Reviewed Source Note',
      confirm: true,
      explicitUserRequest: 'Insert the reviewed source note into the launch plan.',
    });
    expect(inserted.success).toBe(true);
    expect(inserted.output).toContain('Inserted artifact into Agent document');
    expect(inserted.output).toContain('versions 3');

    const insertedShow = await tool.execute({ mode: 'show', documentId: 'launch-plan', includeVersions: true });
    expect(insertedShow.success).toBe(true);
    expect(insertedShow.output).toContain('## Reviewed Source Note');
    expect(insertedShow.output).toContain(`Artifact ID: ${sourceArtifact.id}`);
    expect(insertedShow.output).toContain('Source note body.');

    const comment = await tool.execute({
      mode: 'comment',
      documentId: 'launch-plan',
      comment: 'Clarify the launch owner.',
      confirm: true,
      explicitUserRequest: 'Add a review comment to the launch plan.',
    });
    expect(comment.success).toBe(true);
    expect(comment.output).toContain('Added Agent document comment');
    expect(comment.output).toContain('comment c1');

    const commentedShow = await tool.execute({ mode: 'show', documentId: 'launch-plan', includeVersions: true });
    expect(commentedShow.success).toBe(true);
    expect(commentedShow.output).toContain('comments 1/1');
    expect(commentedShow.output).toContain('c1  open');
    expect(commentedShow.output).toContain('Clarify the launch owner.');

    const resolved = await tool.execute({
      mode: 'resolveComment',
      documentId: 'launch-plan',
      commentId: 'c1',
      confirm: true,
      explicitUserRequest: 'Resolve the launch plan review comment.',
    });
    expect(resolved.success).toBe(true);
    expect(resolved.output).toContain('Resolved Agent document comment');
    expect(resolved.output).toContain('open 0/1');

    const suggestion = await tool.execute({
      mode: 'suggest',
      documentId: 'launch-plan',
      body: 'Initial launch draft.\n\nAdd rollout checklist.\n\nOwner: Launch team.',
      changeSummary: 'Added a concrete owner.',
      suggestionRationale: 'The user asked for a clearer launch owner.',
      confirm: true,
      explicitUserRequest: 'Suggest a clearer launch plan draft.',
    });
    expect(suggestion.success).toBe(true);
    expect(suggestion.output).toContain('Added Agent document suggestion');
    expect(suggestion.output).toContain('suggestion s1');
    expect(suggestion.output).toContain('versions 3');

    const suggestedShow = await tool.execute({ mode: 'show', documentId: 'launch-plan', includeVersions: true });
    expect(suggestedShow.success).toBe(true);
    expect(suggestedShow.output).toContain('suggestions 1/1');
    expect(suggestedShow.output).toContain('s1  proposed');
    expect(suggestedShow.output).toContain('The user asked for a clearer launch owner.');

    const acceptedSuggestion = await tool.execute({
      mode: 'acceptSuggestion',
      documentId: 'launch-plan',
      suggestionId: 's1',
      confirm: true,
      explicitUserRequest: 'Accept the clearer launch plan suggestion.',
    });
    expect(acceptedSuggestion.success).toBe(true);
    expect(acceptedSuggestion.output).toContain('Accepted Agent document suggestion');
    expect(acceptedSuggestion.output).toContain('versions 4');

    const rejectCandidate = await tool.execute({
      mode: 'suggest',
      documentId: 'launch-plan',
      body: 'Rejected launch rewrite.',
      changeSummary: 'Alternative rewrite.',
      suggestionRationale: 'This alternative is not as useful.',
      confirm: true,
      explicitUserRequest: 'Propose an alternative launch plan rewrite.',
    });
    expect(rejectCandidate.success).toBe(true);
    expect(rejectCandidate.output).toContain('suggestion s2');

    const rejectedSuggestion = await tool.execute({
      mode: 'rejectSuggestion',
      documentId: 'launch-plan',
      suggestionId: 's2',
      confirm: true,
      explicitUserRequest: 'Reject the alternative launch plan rewrite.',
    });
    expect(rejectedSuggestion.success).toBe(true);
    expect(rejectedSuggestion.output).toContain('Rejected Agent document suggestion');
    expect(rejectedSuggestion.output).toContain('versions 4');

    const review = await tool.execute({
      mode: 'review',
      documentId: 'launch-plan',
      confirm: true,
      explicitUserRequest: 'Mark the launch plan reviewed.',
    });
    expect(review.success).toBe(true);
    expect(review.output).toContain('status reviewed');

    const exported = await tool.execute({
      mode: 'export',
      documentId: 'launch-plan',
      confirm: true,
      explicitUserRequest: 'Export the reviewed launch plan as an artifact.',
    });
    expect(exported.success).toBe(true);
    expect(exported.output).toContain('Exported Agent document');
    expect(exported.output).toContain('artifact artifact-');
    expect(exported.output).toContain('comments 0/1');
    expect(exported.output).toContain('suggestions 0/2');
    const artifact = artifactStore.list(5)[0];
    expect(artifact?.metadata).toMatchObject({
      purpose: 'agent-document-export',
      source: 'agent-documents',
      documentId: 'launch-plan',
      status: 'reviewed',
      attachmentIds: [sourceArtifact.id],
      commentCounts: {
        open: 0,
        resolved: 1,
        total: 1,
      },
      suggestionCounts: {
        proposed: 0,
        accepted: 1,
        rejected: 1,
        total: 2,
      },
      reviewSummary: {
        hasOpenComments: false,
        hasProposedSuggestions: false,
        exportedReviewAppendix: true,
      },
    });
    const exportedContent = await artifactStore.readContent(artifact?.id ?? '');
    const exportedMarkdown = exportedContent.buffer.toString('utf-8');
    expect(exportedMarkdown).toContain('## Review Comments');
    expect(exportedMarkdown).toContain('c1 [resolved] Clarify the launch owner.');
    expect(exportedMarkdown).toContain('## AI Suggestions');
    expect(exportedMarkdown).toContain('s1 [accepted] Added a concrete owner.');
    expect(exportedMarkdown).toContain('s2 [rejected] Alternative rewrite.');
    expect(exportedMarkdown).toContain('Rationale: The user asked for a clearer launch owner.');
    expect(exportedMarkdown).not.toContain('Rejected launch rewrite.');
  });

  test('inserts non-text artifacts as references without base64 content', async () => {
    const { artifactStore, tool } = fixture();
    await tool.execute({
      mode: 'create',
      title: 'Media Brief',
      body: 'Use generated media safely.',
      confirm: true,
      explicitUserRequest: 'Create a media brief document draft.',
    });
    const image = await artifactStore.create({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'generated.png',
      dataBase64: Buffer.from([137, 80, 78, 71]).toString('base64'),
      metadata: { purpose: 'agent-media-generation' },
    });

    const inserted = await tool.execute({
      mode: 'insertArtifact',
      documentId: 'media-brief',
      artifactId: image.id,
      confirm: true,
      explicitUserRequest: 'Insert the generated image reference into the media brief.',
    });

    expect(inserted.success).toBe(true);
    expect(inserted.output).toContain('safe artifact reference');
    const show = await tool.execute({ mode: 'show', documentId: 'media-brief' });
    expect(show.success).toBe(true);
    expect(show.output).toContain(`Artifact ID: ${image.id}`);
    expect(show.output).toContain('Content omitted for non-text artifact image/png');
    expect(show.output).not.toContain('iVBOR');
  });

  test('registers in the model tool registry', () => {
    const { shellPaths, artifactStore } = fixture();
    const registry = new ToolRegistry();
    registerAgentDocumentsTool(registry, shellPaths, artifactStore);
    expect(registry.getToolDefinitions().some((definition) => definition.name === 'agent_documents')).toBe(true);
  });
});
