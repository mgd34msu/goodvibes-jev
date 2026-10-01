import { describe, expect, test } from 'bun:test';
import { parseDaemonCli } from '../../cli/parser.ts';

function parse(...argv: string[]) {
  return parseDaemonCli(argv, 'goodvibes-daemon');
}

describe('serving happens on a bare invocation or `serve`, and nothing else', () => {
  test('no arguments means serve', () => {
    const result = parse();
    expect(result.command).toBe('serve');
    expect(result.rawCommand).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  test('flags with no command still mean serve', () => {
    const result = parse('--port', '4000', '--daemon-home', '/tmp/gv');
    expect(result.command).toBe('serve');
    expect(result.flags.port).toBe(4000);
    expect(result.flags.daemonHome).toBe('/tmp/gv');
    expect(result.errors).toEqual([]);
  });

  test('the word `serve` means serve', () => {
    const result = parse('serve', '--hostname', '0.0.0.0');
    expect(result.command).toBe('serve');
    expect(result.rawCommand).toBe('serve');
    expect(result.flags.hostname).toBe('0.0.0.0');
    expect(result.errors).toEqual([]);
  });
});

describe('an unrecognized command is refused, never served', () => {
  // Each of these used to be consumed as a positional nothing read, after
  // which the process started a daemon in the foreground.
  test.each([
    ['doctor'],
    ['tui'],
    ['run'],
    ['models'],
    ['install-servce'],
    ['statuss'],
    ['sesions'],
  ])('%s exits with an unknown-command error rather than serving', (word) => {
    const result = parse(word);
    expect(result.errors).toEqual([`Unknown command: ${word}`]);
    expect(result.command).not.toBe('serve');
  });

  test('the error names the word the operator actually typed', () => {
    const result = parse('--daemon-home', '/tmp/gv', 'instal-service');
    expect(result.errors).toEqual(['Unknown command: instal-service']);
    expect(result.rawCommand).toBe('instal-service');
  });
});

describe('command words and aliases', () => {
  test.each([
    ['status', 'status'],
    ['sessions', 'sessions'],
    ['session', 'sessions'],
    ['pair', 'pair'],
    ['qr', 'pair'],
    ['qrcode', 'pair'],
    ['completion', 'completion'],
    ['completions', 'completion'],
    ['install-service', 'install-service'],
    ['start-service', 'start-service'],
    ['stop-service', 'stop-service'],
    ['restart-service', 'restart-service'],
    ['service-status', 'service-status'],
    ['migrate-service', 'migrate-service'],
    ['config', 'config'],
    ['update', 'update'],
    ['version', 'version'],
    ['help', 'help'],
  ])('`%s` resolves to %s', (word, command) => {
    const result = parse(word);
    expect(result.command).toBe(command as never);
    expect(result.errors).toEqual([]);
  });

  test('case does not matter', () => {
    expect(parse('STATUS').command).toBe('status');
  });
});

describe('the terminal app\'s conversation flags are refused by name', () => {
  test.each([
    ['--resume', 'resuming a conversation'],
    ['--continue', 'continuing the last conversation'],
    ['--fork', 'forking a conversation'],
    ['--print', 'printing one conversation turn'],
    ['--open', 'opening a browser window'],
    ['--no-alt-screen', 'terminal screen handling'],
    ['--strict', "the doctor command's strict mode"],
  ])('%s is refused and says where it belongs', (flag, reason) => {
    const result = parse(flag);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain(flag);
    expect(result.errors[0]).toContain(reason);
    expect(result.errors[0]).toContain('terminal app');
  });

  test('value-taking conversation flags do not swallow the next argument', () => {
    // `--prompt` took a value in the terminal app's parser. Refusing it must
    // not also lose the word after it, or the refusal reads as two problems.
    const result = parse('--prompt', 'hello');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('--prompt');
  });

  test('the short spellings are refused too, and the value-taking ones eat their value', () => {
    for (const flag of ['-p', '-o', '-s']) {
      const result = parse(flag, 'x');
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain(flag);
    }
    // `-r`/`--resume`/`--fork` took an OPTIONAL value, so they are treated as
    // taking none: over-skipping would swallow a real command word.
    for (const flag of ['-r', '--resume', '--fork']) {
      const result = parse(flag);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain(flag);
    }
  });
});

describe('flags are accepted per command', () => {
  test('--json is taken by status and refused by serve', () => {
    expect(parse('status', '--json').flags.json).toBe(true);
    expect(parse('status', '--json').errors).toEqual([]);
    const onServe = parse('serve', '--json');
    expect(onServe.errors.length).toBe(1);
    expect(onServe.errors[0]).toContain('--json');
    expect(onServe.errors[0]).toContain('serve');
  });

  test('--host means the bind address under serve and the target under status', () => {
    expect(parse('serve', '--host', '0.0.0.0').flags.hostname).toBe('0.0.0.0');
    expect(parse('serve', '--host', '0.0.0.0').flags.host).toBeUndefined();
    expect(parse('status', '--host', '10.0.0.7').flags.host).toBe('10.0.0.7');
    expect(parse('status', '--host', '10.0.0.7').flags.hostname).toBeUndefined();
  });

  test('--hostname is a serving flag and status refuses it', () => {
    const result = parse('status', '--hostname', 'x');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('--hostname');
  });

  test('an entirely unknown flag names what the command does take', () => {
    const result = parse('status', '--nonsense');
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Unknown option: --nonsense');
    expect(result.errors[0]).toContain('--json');
  });

  test('the global flags work on every command', () => {
    const result = parse('service-status', '--daemon-home', '/tmp/gv', '-C', '/srv');
    expect(result.errors).toEqual([]);
    expect(result.flags.daemonHome).toBe('/tmp/gv');
    expect(result.flags.workingDir).toBe('/srv');
  });
});

describe('values', () => {
  test('--port is validated as a port', () => {
    expect(parse('serve', '--port', '3421').flags.port).toBe(3421);
    expect(parse('serve', '--port', '0').errors[0]).toContain('--port must be a port number');
    expect(parse('serve', '--port', '70000').errors[0]).toContain('--port must be a port number');
    expect(parse('serve', '--port', 'abc').errors[0]).toContain('--port must be a port number');
  });

  test('a value-taking flag with no value is refused', () => {
    expect(parse('serve', '--daemon-home').errors).toEqual(['--daemon-home requires a value.']);
    expect(parse('status', '--token').errors).toEqual(['--token requires a value.']);
  });

  test('a boolean flag given a value is refused', () => {
    expect(parse('status', '--json=yes').errors).toEqual(['--json takes no value.']);
  });

  test('--flag=value is accepted', () => {
    expect(parse('status', '--host=10.0.0.7').flags.host).toBe('10.0.0.7');
    expect(parse('serve', '--port=3999').flags.port).toBe(3999);
  });

  test('-c/--config and --enable/--disable collect repeats', () => {
    const result = parse('serve', '-c', 'a=1', '--config', 'b=2', '--enable', 'x', '--disable', 'y');
    expect(result.flags.configOverrides).toEqual(['a=1', 'b=2']);
    expect(result.flags.enableFeatures).toEqual(['x']);
    expect(result.flags.disableFeatures).toEqual(['y']);
  });

  test('-m infers the provider from a provider:model key', () => {
    const result = parse('serve', '-m', 'anthropic:claude');
    expect(result.flags.model).toBe('anthropic:claude');
    expect(result.flags.provider).toBe('anthropic');
  });

  test('an explicit --provider wins over the one inferred from the model', () => {
    const result = parse('serve', '--provider', 'openai', '-m', 'anthropic:claude');
    expect(result.flags.provider).toBe('openai');
  });

  test('-y, --yes and --non-interactive all mean yes', () => {
    expect(parse('migrate-service', '-y').flags.yes).toBe(true);
    expect(parse('migrate-service', '--yes').flags.yes).toBe(true);
    expect(parse('migrate-service', '--non-interactive').flags.yes).toBe(true);
  });

  test('pair takes -y/--yes alongside the remote-target flags', () => {
    const result = parse('pair', '--host', '10.0.0.7', '--port', '4100', '--token', 't', '-y');
    expect(result.flags.host).toBe('10.0.0.7');
    expect(result.flags.port).toBe(4100);
    expect(result.flags.token).toBe('t');
    expect(result.flags.yes).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('pair with no -y still parses cleanly (yes defaults false)', () => {
    const result = parse('pair', '--host', '10.0.0.7');
    expect(result.flags.yes).toBe(false);
    expect(result.errors).toEqual([]);
  });
});

describe('positional arguments after a command', () => {
  test('sessions carries its subcommand and id through', () => {
    const result = parse('sessions', 'kill', 'abc123', '--json');
    expect(result.command).toBe('sessions');
    expect(result.commandArgs).toEqual(['kill', 'abc123']);
    expect(result.flags.json).toBe(true);
  });

  test('config carries key and value through', () => {
    const result = parse('config', 'set', 'controlPlane.port', '3421');
    expect(result.commandArgs).toEqual(['set', 'controlPlane.port', '3421']);
  });

  test('help carries the topic through', () => {
    expect(parse('help', 'sessions').commandArgs).toEqual(['sessions']);
  });
});

describe('passthrough commands keep their own arguments intact', () => {
  test('send takes everything after it verbatim, dashes included', () => {
    const result = parse('send', '--channel', 'telegram', '-- not a flag --port 1');
    expect(result.command).toBe('send');
    expect(result.commandArgs).toEqual(['--channel', 'telegram', '-- not a flag --port 1']);
    expect(result.errors).toEqual([]);
    // The daemon's own --port must NOT have been consumed from the message.
    expect(result.flags.port).toBeUndefined();
  });

  test('cluster keeps --group/--key/--host, which this parser does not own', () => {
    const result = parse('cluster', 'join', '--group', 'g1', '--key', 'gvj1-x', '--host', 'box');
    expect(result.commandArgs).toEqual(['join', '--group', 'g1', '--key', 'gvj1-x', '--host', 'box']);
    expect(result.flags.host).toBeUndefined();
  });

  test('webui keeps --bundle-dir and --lan', () => {
    const result = parse('webui', 'enable', '--bundle-dir', '/srv/ui', '--lan');
    expect(result.commandArgs).toEqual(['enable', '--bundle-dir', '/srv/ui', '--lan']);
    expect(result.errors).toEqual([]);
  });

  test('a global flag before a passthrough command is still parsed', () => {
    const result = parse('--daemon-home', '/tmp/gv', 'send', 'hello');
    expect(result.command).toBe('send');
    expect(result.flags.daemonHome).toBe('/tmp/gv');
    expect(result.commandArgs).toEqual(['hello']);
  });
});

describe('--help and --version', () => {
  test('--help sets the flag and keeps the command it was asked about', () => {
    const result = parse('sessions', '--help');
    expect(result.flags.help).toBe(true);
    expect(result.command).toBe('sessions');
  });

  test('-v works with no command', () => {
    expect(parse('-v').flags.version).toBe(true);
  });
});
