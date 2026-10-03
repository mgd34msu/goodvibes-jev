import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NpmPublishAuthEnvOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly registry: string;
  readonly tempRoot: string;
}

export interface NpmPublishAuthEnvResult {
  readonly env: NodeJS.ProcessEnv;
  readonly userconfigPath: string | null;
}

export function buildNpmPublishAuthEnv(options: NpmPublishAuthEnvOptions): NpmPublishAuthEnvResult {
  const existingUserconfig = options.env.NPM_CONFIG_USERCONFIG?.trim();
  if (existingUserconfig) {
    return {
      env: options.env,
      userconfigPath: null,
    };
  }

  const token = options.env.NODE_AUTH_TOKEN?.trim() || options.env.NPM_TOKEN?.trim();
  if (!token) {
    return {
      env: options.env,
      userconfigPath: null,
    };
  }

  const registryUrl = new URL(options.registry);
  const userconfigPath = join(options.tempRoot, 'npmrc');
  writeFileSync(
    userconfigPath,
    `//${registryUrl.host}/:_authToken=${token}\nregistry=${options.registry}\n`,
    { mode: 0o600 },
  );
  chmodSync(userconfigPath, 0o600);

  return {
    env: {
      ...options.env,
      NPM_CONFIG_USERCONFIG: userconfigPath,
    },
    userconfigPath,
  };
}
