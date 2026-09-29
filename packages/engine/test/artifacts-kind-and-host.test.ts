/**
 * The artifact store's kind reading and its remote host check.
 *
 * Image, audio and video come from the media type's top-level registration
 * (code); every other kind is the `engine.artifacts.kind` reading, recorded
 * only when it reaches act. A public-only fetch refuses a loopback host.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
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

  test('any other type is the reading, recorded when it acts', async () => {
    await withKind('document', 0.9, async (asked) => {
      expect(await inferArtifactKind('application/vnd.oasis.opendocument.text', 'minutes.odt')).toBe('document');
      expect(asked()).toBe(1);
    });
  });

  test('a reading that does not reach act records file', async () => {
    await withKind('archive', 0.4, async () => {
      expect(await inferArtifactKind('application/x-unknown', 'thing.xyz')).toBe('file');
    });
  });
});

describe('remote artifact host check', () => {
  test('a public-only fetch refuses a loopback host', async () => {
    const store = new ArtifactStore({ rootDir: mkdtempSync(join(tmpdir(), 'artifact-host-')) });
    await expect(store.create({ uri: 'http://127.0.0.1:9/secret', fetchMode: 'public-only' })).rejects.toThrow(/blocked by SSRF policy/);
    await expect(store.create({ uri: 'http://localhost:9/secret' })).rejects.toThrow(/blocked by SSRF policy/);
  });
});
