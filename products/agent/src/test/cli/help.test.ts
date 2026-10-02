import { describe, expect, test } from 'bun:test';
import { renderCompletion } from '../../cli/completion.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesVersion } from '../../cli/help.ts';

const AGENT_BIN = ['goodvibes', 'agent'].join('-');
const RETIRED_START_COMMAND = [AGENT_BIN, 'start'].join(' ');

describe('CLI help/version', () => {
  test('does not report the consuming project npm_package_version', () => {
    const previous = process.env.npm_package_version;
    process.env.npm_package_version = '1.0.0';

    try {
      expect(renderGoodVibesVersion()).not.toBe('goodvibes 1.0.0');
    } finally {
      if (previous === undefined) {
        delete process.env.npm_package_version;
      } else {
        process.env.npm_package_version = previous;
      }
    }
  });

  test('shell completion advertises product commands instead of runtime lifecycle commands', () => {
    const completion = renderCompletion('bash', 'goodvibes-agent');

    expect(completion).not.toContain('tui');
    expect(completion).not.toContain('launch');
    expect(completion).not.toContain(' start ');
    expect(completion).toContain('profiles');
    expect(completion).toContain('knowledge');
    expect(completion).toContain('delegate');
    expect(completion).toContain('--runtime-url');
    expect(completion).not.toContain(' tasks ');
    expect(completion).not.toContain(' remote ');
    expect(completion).not.toContain(' bridge ');
    expect(completion).not.toContain(' serve ');
    expect(completion).not.toContain(' service ');
    expect(completion).not.toContain(' surfaces ');
    expect(completion).not.toContain(' listener ');
    expect(completion).not.toContain(' control-plane ');
    expect(completion).not.toContain('--daemon-home');
    expect(completion).not.toContain('--hostname');
    expect(completion).not.toContain('--port');
  });

  test('shell completion defaults to goodvibes-agent as the binary name', () => {
    // D6: renderCompletion default binary must be 'goodvibes-agent', not 'goodvibes'.
    const completion = renderCompletion('bash');
    expect(completion).toContain('goodvibes-agent');
    expect(completion).not.toContain('_goodvibes()');
  });

  test('retired start launcher alias is not command help', () => {
    const help = renderGoodVibesCommandHelp('start');

    expect(help).toContain('No detailed help is available for "start".');
    expect(help).not.toContain([RETIRED_START_COMMAND, '[path]'].join(' '));
  });

});
