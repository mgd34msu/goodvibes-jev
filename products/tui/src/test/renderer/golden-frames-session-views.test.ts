import { usePresentationReadings } from '../helpers/presentation-readings.ts';
usePresentationReadings([["error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.", 'error']]);
// ---------------------------------------------------------------------------
// golden-frames-session-views.test.ts, an agent and a background process
// opened full screen, and the session chips row on the main screen.
//
// The concept page's agent-focus and process-focus scenes, rendered through
// the real view path (shell/session-views.ts) over fake agent and process
// managers at a fixed clock (helpers/session-view-scenes.ts). The layout audit
// runs on every frame here and again in golden-frames-audit.test.ts.
//
// Theme sets: golden-frames/ for goodvibes (this file), and
// golden-frames-goodvibes-neon/ through golden-frames-session-views-neon.test.ts.
//
// Update path:
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-session-views.test.ts
//   GOODVIBES_UPDATE_GOLDENS=1 bun test src/test/renderer/golden-frames-session-views-neon.test.ts
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC'; // the process view's clock times

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { activeTokens, setActiveThemeMode, setActiveThemeName } from '../../renderer/theme.ts';
import { auditFrame } from '../helpers/frame-audit.ts';
import { assertGoldenIn, encodeGolden } from '../helpers/golden-snapshot.ts';
import { makeViewScene, renderViewScreen, type ViewScene } from '../helpers/session-view-scenes.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { makeProcessOutputReadingFixture } from '../helpers/process-output-reading.ts';
import type { ThrobberState } from '../../renderer/throbber.ts';

const THEME = process.env['GOODVIBES_GOLDEN_THEME'] ?? 'goodvibes';
setActiveThemeName(THEME);
setActiveThemeMode('dark');
const DIR = new URL(THEME === 'goodvibes' ? './golden-frames/' : `./golden-frames-${THEME}/`, import.meta.url).pathname;

const scenes: ViewScene[] = [];
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(makeProcessOutputReadingFixture(
  ["error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'."],
  ['  ➜  Local:   http://localhost:5173/'],
).port); });
afterEach(async () => { await Promise.all(scenes.splice(0).map(scene => scene.views.log.dispose())); installJudgmentPort(previousPort); });
const scene = () => { const value = makeViewScene(); scenes.push(value); return value; };
async function render(scene: ViewScene, width: number, height: number, throbber: ThrobberState | null = null): Promise<Line[]> {
  await scene.views.log.whenSettled();
  return renderViewScreen(scene, width, height, throbber);
}

const MAIN_WORKING: ThrobberState = { spinner: '⠋', frame: 0, activity: { kind: 'tool', tool: 'exec', argument: 'bun test src/net/retry.test.ts', elapsedMs: 3_000 } };

const FRAMES: ReadonlyArray<{ readonly name: string; readonly width: number; readonly height: number; readonly render: () => Promise<Line[]> }> = [
  { name: 'agent-view-120x30', width: 120, height: 30, render: async () => { const s = scene(); s.views.open({ kind: 'agent', id: 'eng' }); return render(s, 120, 30); } },
  { name: 'agent-view-80x24', width: 80, height: 24, render: async () => { const s = scene(); s.views.open({ kind: 'agent', id: 'eng' }); return render(s, 80, 24); } },
  { name: 'agent-view-child-stop-armed', width: 120, height: 30, render: async () => {
    const s = scene(); s.views.open({ kind: 'agent', id: 'tester' }); s.views.pressStop(); return render(s, 120, 30);
  } },
  { name: 'process-view-120x30', width: 120, height: 30, render: async () => { const s = scene(); s.views.open({ kind: 'process', id: 'bg-1' }); return render(s, 120, 30); } },
  { name: 'process-view-80x24', width: 80, height: 24, render: async () => { const s = scene(); s.views.open({ kind: 'process', id: 'bg-1' }); return render(s, 80, 24); } },
  { name: 'process-view-search', width: 120, height: 30, render: async () => {
    const s = scene(); s.views.open({ kind: 'process', id: 'bg-1' }); s.views.startSearch(); s.views.searchType('client'); return render(s, 120, 30);
  } },
  // Main keeps working under a view: its throbber, led by "main", sits over the view's input area.
  { name: 'agent-view-main-working-120x30', width: 120, height: 30, render: async () => { const s = scene(); s.views.open({ kind: 'agent', id: 'eng' }); return render(s, 120, 30, MAIN_WORKING); } },
  { name: 'process-view-main-working-80x24', width: 80, height: 24, render: async () => { const s = scene(); s.views.open({ kind: 'process', id: 'bg-1' }); return render(s, 80, 24, MAIN_WORKING); } },
  { name: 'session-chips-main-120', width: 120, height: 9, render: async () => render(scene(), 120, 9) },
  { name: 'session-chips-main-80', width: 80, height: 9, render: async () => render(scene(), 80, 9) },
];

describe(`golden-frames : session views (${THEME})`, () => {
  for (const frame of FRAMES) {
    test(frame.name, async () => {
      const lines = await frame.render();
      expect(lines).toHaveLength(frame.height);
      expect(lines.every((l) => l.length === frame.width)).toBe(true);
      assertGoldenIn(DIR, frame.name, lines);
      expect(encodeGolden(frame.name, await frame.render())).toBe(encodeGolden(frame.name, lines));
      expect(auditFrame(lines, frame.width, activeTokens()).map((i) => `${i.kind} row ${i.row}: ${i.detail}`)).toEqual([]);
    });
  }
});
