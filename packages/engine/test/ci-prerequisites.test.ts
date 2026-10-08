/** Execute the real workflow prerequisite bodies; never invoke real sudo/APT. */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { 'timeout-minutes'?: number; steps: Array<{ name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }> }>;
};
const bodies = {
  browser: workflow.jobs['webui-browser-partitions']!.steps.find((step) => step.name === 'Install official Playwright Chromium and OS dependencies')!.run!,
  containment: workflow.jobs['exec-containment-proof']!.steps.find((step) => step.name === 'Install official sandbox and PTY packages')!.run!,
};

function live(pid: number): boolean {
  try { return !/[)] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('CI prerequisite acquisition', () => {
  test('Agent and TUI use the same proven bounded terminal installer without weakening TUI proof', () => {
    const agent = workflow.jobs['agent-tests']!.steps.find((step) => step.name === 'Install Agent terminal E2E prerequisite')!;
    const tui = workflow.jobs['tui-host-pair-terminal']!;
    const installer = tui.steps.find((step) => step.name === 'Install official terminal harness package')!;
    // workflow-shape executes the Agent body through ready/missing/failure/hang
    // fixtures. Exact equality requires both consumers to run that same program.
    expect(agent.run).toBeDefined();
    expect(installer.run).toBe(agent.run);
    expect(installer.if).toBeUndefined();
    expect(installer['continue-on-error']).toBeUndefined();
    expect(tui['timeout-minutes']).toBe(10);
    const proof = tui.steps.find((step) => step.name === 'Qualify host pairing, passive planning history and interruption recovery')!;
    expect(proof.run).toBe('bun packages/engine/scripts/test.ts --cwd ../../products/tui --timeout=300000 src/test/e2e/host-pair-terminal.e2e.test.ts src/test/e2e/host-pair-interactive.e2e.test.ts src/test/e2e/planning-history.e2e.test.ts');
    expect(proof.if).toBeUndefined();
    expect(proof['continue-on-error']).toBeUndefined();
    expect(tui.steps.indexOf(installer)).toBeLessThan(tui.steps.indexOf(proof));
  });

  test('browser partitions use the installed CLI, real smoke, and mandatory verified suite', () => {
    expect(bodies.browser).toContain('node node_modules/@playwright/test/cli.js install chromium');
    expect(bodies.browser).not.toMatch(/bunx|SKIP_VALIDATE|continue-on-error|\|\| true/);
    expect(bodies.browser).toContain('timeout --signal=KILL 30s bun scripts/ci-browser-smoke.ts');
    const testStep = workflow.jobs['webui-browser-partitions']!.steps.find((step) => step.name === 'Exercise the production app with synthetic daemon fixtures')!;
    expect(testStep.run).toContain('bun scripts/ci-browser-partitions.ts run "$BROWSER_PARTITION"');
    const discovery = workflow.jobs['webui-browser-partitions']!.steps.find((step) => step.name === 'Verify complete disjoint browser discovery')!;
    expect(discovery.run).toBe('bun scripts/ci-browser-partitions.ts discover');
    expect(discovery.if).toBeUndefined();
    expect(discovery['continue-on-error']).toBeUndefined();
    expect(testStep.if).toBeUndefined();
    expect(testStep['continue-on-error']).toBeUndefined();
  });

  // Actual process-group timeout behavior needs Linux /proc and GNU timeout,
  // exactly as the existing Agent prerequisite regression does.
  for (const kind of ['browser', 'containment'] as const) {
    const scenarios = kind === 'browser'
      ? ['ready', 'missing', 'download-fails', 'download-hangs', 'config-fails', 'config-override', 'deps-fails', 'deps-hangs', 'probe-timeout', 'probe-hangs', 'verify-fails', 'verify-hangs']
      : ['ready', 'missing', 'cached-fails', 'cached-hangs', 'update-fails', 'update-hangs', 'deps-fails', 'deps-hangs', 'probe-hangs', 'verify-fails', 'verify-hangs', 'pty-fails'];
    for (const scenario of scenarios) {
      test.skipIf(process.platform !== 'linux')(`${kind}: ${scenario} is bounded and fails closed`, async () => {
        const fixture = mkdtempSync(join(tmpdir(), 'ci-prerequisite-'));
        const bin = join(fixture, 'bin');
        mkdirSync(bin);
        const log = join(fixture, 'commands');
        const pids = join(fixture, 'pids');
        writeFileSync(log, '');
        const executable = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
        const hang = `
          # A TERM-exiting parent plus TERM-ignoring child catches orphan leaks.
          trap 'exit 0' TERM
          export FIXTURE_PARENT_PID=$BASHPID
          /bin/bash -c 'trap "" TERM; printf "%s\\n%s\\n" "$FIXTURE_PARENT_PID" "$BASHPID" > "$PIDS.pending"; /bin/mv "$PIDS.pending" "$PIDS"; exec /bin/sleep 30' &
          wait
        `;
        const operation = `
          printf '%s\\n' "$OP" >> "$LOG"
          [[ "$SCENARIO" != "$OP-fails" ]] || exit 42
          if [[ "$SCENARIO" == "$OP-hangs" ]]; then
            ${hang}
          fi
        `;
        try {
          executable('sudo', '[[ "$1" == -n && "$2" == timeout ]]\nshift\nexec "$@"');
          executable('timeout', `
            printf 'timeout %s\\n' "$*" >> "$LOG"
            [[ "$1" == --signal=KILL ]]
            [[ "$2" == 10s || "$2" == 30s || "$2" == 60s || "$2" == 90s || "$2" == 180s ]]
            shift 2
            # Keep production durations asserted above. Trigger GNU timeout's own
            # alarm only after both fixture processes are demonstrably running.
            /usr/bin/timeout --signal=KILL 5s "$@" &
            owned=$!
            while kill -0 "$owned" 2>/dev/null; do
              if [[ -s "$PIDS" && ! -e "$PIDS.alarmed" ]]; then
                : > "$PIDS.alarmed"
                kill -ALRM "$owned"
                break
              fi
              /bin/sleep 0.01
            done
            set +e
            wait "$owned"
            exit $?
          `);
          executable('node', `
            OP=download
            [[ " $* " != *' install-deps '* ]] || OP=deps
            ${operation}
            if [[ "$OP" == deps ]]; then
              /bin/cat "$APT_CONFIG" > "$LOG.config"
              : > "$FIXTURE/installed"
            fi
          `);
          executable('bun', `
            OP=probe
            [[ ! -e "$FIXTURE/installed" ]] || OP=verify
            ${operation}
            [[ "$SCENARIO" != probe-timeout ]] || exit 124
            [[ "$SCENARIO" == ready || "$OP" == verify ]]
          `);
          executable('bwrap', `
            [[ "$*" == '--ro-bind / / --proc /proc --dev /dev --unshare-net /bin/true' ]]
            OP=probe
            [[ ! -e "$FIXTURE/installed" ]] || OP=verify
            ${operation}
            [[ "$SCENARIO" == ready || "$OP" == verify ]]
          `);
          executable('script', `
            [[ "$*" == '--quiet --return --command test -t 0 && test -t 1 /dev/null' ]]
            OP=pty
            ${operation}
          `);
          executable('apt-config', `
            OP=config
            ${operation}
            if [[ "$SCENARIO" == config-override ]]; then
              printf "error_mode='persistent'\\n"
            else
              printf "%s\\n" "error_mode='any'" "retries='1'" "http_timeout='15'" "https_timeout='15'"
            fi
          `);
          executable('apt-get', `
            OP=deps
            if [[ ! -e "$FIXTURE/cache-attempt" ]]; then
              OP=cached
              : > "$FIXTURE/cache-attempt"
            fi
            [[ "\${!#}" != update ]] || OP=update
            [[ "$*" == *'Acquire::Retries=1'* && "$*" == *'Acquire::http::Timeout=15'* && "$*" == *'Acquire::https::Timeout=15'* ]]
            if [[ "$OP" == update ]]; then [[ "$*" == *'--error-on=any update' ]]; fi
            ${operation}
            if [[ "$OP" == cached && ( "$SCENARIO" == update-* || "$SCENARIO" == deps-* ) ]]; then exit 42; fi
            [[ "$OP" == update ]] || : > "$FIXTURE/installed"
          `);
          for (const command of ['cat', 'rm', 'mktemp', 'env']) executable(command, `exec /usr/bin/${command} "$@"`);
          executable('realpath', 'printf "/fixture/playwright-cli.js\\n"');
          const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', bodies[kind]], {
            env: { PATH: bin, FIXTURE: fixture, TMPDIR: fixture, LOG: log, PIDS: pids, SCENARIO: scenario },
            encoding: 'utf8', timeout: 8000,
          });
          expect(result.error, result.stderr).toBeUndefined();
          const successful = kind === 'browser'
            ? ['ready', 'missing'].includes(scenario)
            : ['ready', 'missing', 'cached-fails', 'cached-hangs', 'probe-hangs'].includes(scenario);
          const failure = scenario === 'config-override' ? 1 : scenario === 'probe-timeout' ? 124 : scenario.endsWith('-hangs') ? 137 : 42;
          expect(result.status, result.stderr).toBe(successful ? 0 : failure);
          const commands = readFileSync(log, 'utf8').trim().split('\n');
          const operations = commands.filter((line) => !line.startsWith('timeout '));
          const expected: string[] = [];
          if (kind === 'browser') {
            expected.push('download');
            if (!scenario.startsWith('download-')) {
              expected.push('probe');
              if (!['ready', 'probe-timeout', 'probe-hangs'].includes(scenario)) {
                expected.push('config');
                if (!scenario.startsWith('config-')) {
                  expected.push('deps');
                  if (!scenario.startsWith('deps-')) expected.push('verify');
                }
              }
            }
          } else {
            expected.push('probe');
            if (scenario === 'ready') expected.push('pty');
            else {
              expected.push('cached');
              const refresh = ['cached-', 'update-', 'deps-'].some((prefix) => scenario.startsWith(prefix));
              if (refresh) {
                expected.push('update');
                if (!scenario.startsWith('update-')) expected.push('deps');
              }
              if (!scenario.startsWith('update-') && !scenario.startsWith('deps-')) {
                expected.push('verify');
                if (!scenario.startsWith('verify-')) expected.push('pty');
              }
            }
          }
          expect(operations).toEqual(expected);
          if (kind === 'browser' && existsSync(`${log}.config`)) {
            const config = readFileSync(`${log}.config`, 'utf8');
            expect(config).toContain('APT::Update::Error-Mode "any";');
            expect(config).toContain('Acquire::Retries "1";');
            expect(config).toContain('Acquire::http::Timeout "15";');
            expect(config).toContain('Acquire::https::Timeout "15";');
          }
          if (scenario.endsWith('-hangs')) {
            const children = readFileSync(pids, 'utf8').trim().split('\n').map(Number);
            expect(children).toHaveLength(2);
            const deadline = Date.now() + 1000;
            while (children.some(live) && Date.now() < deadline) await Bun.sleep(10);
            for (const pid of children) expect(live(pid), `left live fixture ${pid}`).toBe(false);
          }
        } finally {
          if (existsSync(pids)) for (const pid of readFileSync(pids, 'utf8').trim().split('\n').map(Number)) {
            if (Number.isSafeInteger(pid) && pid > 1 && live(pid)) {
              try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
            }
          }
          rmSync(fixture, { recursive: true, force: true });
        }
      });
    }
  }
});
