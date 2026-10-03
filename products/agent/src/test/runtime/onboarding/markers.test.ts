import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  getOnboardingCheckMarkerPath,
  getOnboardingCompletionMarkerPath,
  readOnboardingCheckMarkers,
  readOnboardingCompletionMarker,
  writeOnboardingCheckMarker,
  writeOnboardingCompletionMarker,
} from '../../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

function createShellPaths() {
  const root = makeProjectTempDir(`gv-onboarding-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return createShellPathService({
    workingDirectory: join(root, 'workspace'),
    homeDirectory: join(root, 'home'),
  });
}

describe('onboarding check marker helpers', () => {
  test('writes and reads user and project markers with user-only effective check state', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 100,
      updatedAt: 110,
      source: 'wizard',
      mode: 'new',
    });
    writeOnboardingCheckMarker(shellPaths, {
      scope: 'project',
      checkedAt: 200,
      updatedAt: 210,
      source: 'command',
      mode: 'edit',
    });

    const markers = readOnboardingCheckMarkers(shellPaths);

    expect(markers.user.payload?.checkedAt).toBe(100);
    expect(markers.user.payload?.workspaceRoot).toBeUndefined();
    expect(markers.project.payload?.checkedAt).toBe(200);
    expect(markers.effective?.scope).toBe('user');
    expect(markers.effective?.payload?.mode).toBe('new');
  });

  test('falls back to a valid user marker when the project marker is invalid', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 300,
      source: 'wizard',
    });

    const projectPath = getOnboardingCheckMarkerPath(shellPaths, 'project');
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, '{invalid-json', 'utf-8');

    const markers = readOnboardingCheckMarkers(shellPaths);

    expect(markers.project.exists).toBe(true);
    expect(markers.project.payload).toBeNull();
    expect(markers.project.parseError).toContain('JSON');
    expect(markers.effective?.scope).toBe('user');
  });

  test('does not treat a project marker as global onboarding check state', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCheckMarker(shellPaths, {
      scope: 'project',
      checkedAt: 400,
      source: 'command',
    });

    const markers = readOnboardingCheckMarkers(shellPaths);

    expect(markers.project.payload?.checkedAt).toBe(400);
    expect(markers.user.payload).toBeNull();
    expect(markers.effective).toBeNull();
  });

  test('stores completion separately from check markers', () => {
    const shellPaths = createShellPaths();

    writeOnboardingCheckMarker(shellPaths, {
      scope: 'user',
      checkedAt: 500,
      source: 'command',
    });
    writeOnboardingCompletionMarker(shellPaths, {
      scope: 'user',
      checkedAt: 600,
      source: 'wizard',
      mode: 'new',
    });

    const checkPath = getOnboardingCheckMarkerPath(shellPaths, 'user');
    const completionPath = getOnboardingCompletionMarkerPath(shellPaths, 'user');
    const markers = readOnboardingCheckMarkers(shellPaths);
    const completion = readOnboardingCompletionMarker(shellPaths, 'user');

    expect(completionPath).not.toBe(checkPath);
    expect(markers.user.payload?.checkedAt).toBe(500);
    expect(completion.payload?.checkedAt).toBe(600);
    expect(completion.payload?.source).toBe('wizard');
  });
});
