import { execFileSync } from 'node:child_process';

export interface NpmViewRunnerOptions {
  readonly command: 'npm';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type NpmViewRunner = (options: NpmViewRunnerOptions) => string;

export interface PublishedNpmVersionOptions {
  readonly name: string;
  readonly version: string;
  readonly registry: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runner?: NpmViewRunner;
}

function defaultNpmViewRunner(options: NpmViewRunnerOptions): string {
  return execFileSync(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function buildNpmPackageVersionSpec(name: string, version: string): string {
  return `${name}@${version}`;
}

export function getPublishedNpmVersion(options: PublishedNpmVersionOptions): string | null {
  const runner = options.runner ?? defaultNpmViewRunner;
  try {
    const output = runner({
      command: 'npm',
      args: [
        'view',
        buildNpmPackageVersionSpec(options.name, options.version),
        'version',
        '--registry',
        options.registry,
      ],
      cwd: options.cwd,
      env: options.env,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}
