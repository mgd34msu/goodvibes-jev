import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { Question } from '@goodvibes-jev/judgment';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.ts';
import { inferArtifactKind } from '../sdk/src/platform/artifacts/types.ts';

async function withKind<T>(chosen: string, confidence: number, body: (asked: () => number) => Promise<T>): Promise<T> {
  const fake = fakePort((_name: string, question: Question) => choiceAnswer(question, chosen, confidence));
  const previous = installJudgmentPort(fake.port);
  try {
    return await body(() => fake.requests.length);
  } finally {
    installJudgmentPort(previous);
  }
}

describe('artifact kind', () => {
  test('image, audio and video come from the media type or the file name, and ask nothing', async () => {
    await withKind('document', 0.9, async (asked) => {
      expect(await inferArtifactKind('image/png', 'a.png')).toBe('image');
      expect(await inferArtifactKind('application/octet-stream', 'clip.mp4')).toBe('video');
      expect(await inferArtifactKind('audio/ogg')).toBe('audio');
      expect(asked()).toBe(0);
    });
  });

  test('registered documents, data and archives resolve locally', async () => {
    await withKind('file', 0.1, async asked => {
      expect(await inferArtifactKind('application/vnd.oasis.opendocument.text', 'minutes.odt')).toBe('document');
      expect(await inferArtifactKind('application/problem+json; charset=utf-8')).toBe('data');
      expect(await inferArtifactKind('application/octet-stream', 'source.zip')).toBe('archive');
      expect(await inferArtifactKind('application/x-unknown', 'thing.xyz')).toBe('file');
      expect(await inferArtifactKind('application/json', 'misleading.png')).toBe('data');
      expect(asked()).toBe(0);
    });
  });

  test('an unavailable judgment service cannot block storing an unknown file', async () => {
    const previous = installJudgmentPort(undefined);
    const rootDir = mkdtempSync(join(tmpdir(), 'artifact-local-'));
    try {
      const store = new ArtifactStore({ rootDir });
      const saved = await store.create({ dataBase64: Buffer.from('payload').toString('base64'), filename: 'thing.xyz' });
      expect(saved.kind).toBe('file');
      expect((await store.readContent(saved.id)).buffer.toString()).toBe('payload');
    } finally { installJudgmentPort(previous); rmSync(rootDir, { recursive: true, force: true }); }
  });
});

describe('remote artifact host check', () => {
  test('a public-only fetch refuses a loopback host', async () => {
    const store = new ArtifactStore({ rootDir: mkdtempSync(join(tmpdir(), 'artifact-host-')) });
    await expect(store.create({ uri: 'http://127.0.0.1:9/secret', fetchMode: 'public-only' })).rejects.toThrow(/blocked by SSRF policy/);
    await expect(store.create({ uri: 'http://localhost:9/secret' })).rejects.toThrow(/blocked by SSRF policy/);
  });
});
