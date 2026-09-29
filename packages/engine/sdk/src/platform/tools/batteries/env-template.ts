/**
 * `engine.tools.env-template`: analyze mode `env_audit` compares the env
 * files it finds against the one that lists every variable the project
 * expects. Which found file, if any, is that template? Read by Jev over each
 * file's name and its variable names (with whether each value is blank; the
 * values themselves are never sent), in place of taking `.env.example` when
 * present and otherwise the first file found, which compared every file
 * against a developer's own `.env` as if it were the list of what is
 * expected.
 *
 * The candidate-selection pattern: one choice picks a file or none, and one
 * yes/no per file confirms the pick lists the expected variables. With no
 * template the audit reports each file's variables and compares nothing.
 *
 * Band: low stakes. The audit is advice; a wrong template lists variables as
 * missing or extra that are not. A pick that acts or confirms is used.
 */
import { defineSelector, NONE, STAKES_BANDS, type Candidate, type JsonValue } from '@goodvibes-jev/judgment';

/** Most variables of one file the reading carries. */
export const MAX_JUDGED_ENV_KEYS = 80;

/** One found env file as a candidate: its name and its variables, each marked blank or set. */
export function envTemplateCandidate(name: string, variables: ReadonlyArray<{ readonly key: string; readonly blank: boolean }>): Candidate {
  const shown = variables.slice(0, MAX_JUDGED_ENV_KEYS).map(({ key, blank }) => `${key}=${blank ? '(blank)' : '(set)'}`);
  const more = variables.length > MAX_JUDGED_ENV_KEYS ? [`(${variables.length - MAX_JUDGED_ENV_KEYS} more variables)`] : [];
  return { id: name, content: { file: name, variables: [...shown, ...more] } };
}

/** What the selection sees about the project: every env file name found. */
export function envTemplateContext(names: readonly string[]): JsonValue {
  return { envFiles: [...names] };
}

const file = (name: string, ...entries: Array<[string, boolean]>) => envTemplateCandidate(name, entries.map(([key, blank]) => ({ key, blank })));

export const envTemplate = defineSelector({
  name: 'engine.tools.env-template',
  version: 1,
  description: 'Which env file in a project, if any, is the template that lists every variable the project expects.',
  accuracyFloor: 0.85,
  instructions:
    'A project has the env files listed in `context.envFiles`; each candidate shows one file\'s variable names and whether each value is blank or set (the values are hidden). Which file is the template checked into the project to list every variable the project expects, which developers copy to make their own env files? Choose none when every file is an env file for one machine or one environment rather than a template.',
  fitInstructions:
    'Is this file a template that lists the variables the project expects (an example or sample file meant to be copied and filled in), rather than the settings one developer or one environment actually runs with?',
  band: STAKES_BANDS.low.confidence,
  fitBand: STAKES_BANDS.low.yesNo,
  fixtures: [
    {
      name: 'example beside a local env',
      context: envTemplateContext(['.env', '.env.example']),
      candidates: [file('.env', ['DATABASE_URL', false], ['STRIPE_KEY', false]), file('.env.example', ['DATABASE_URL', true], ['STRIPE_KEY', true], ['SENTRY_DSN', true])],
      expect: '.env.example',
    },
    {
      name: 'example with per-environment files',
      context: envTemplateContext(['.env.example', '.env.production', '.env.test']),
      candidates: [file('.env.example', ['API_URL', true], ['LOG_LEVEL', true]), file('.env.production', ['API_URL', false], ['LOG_LEVEL', false]), file('.env.test', ['API_URL', false])],
      expect: '.env.example',
    },
    {
      name: 'only an example',
      context: envTemplateContext(['.env.example']),
      candidates: [file('.env.example', ['PORT', true], ['DATABASE_URL', true])],
      expect: '.env.example',
    },
    {
      name: 'local and development settings only',
      context: envTemplateContext(['.env', '.env.local']),
      candidates: [file('.env', ['PORT', false], ['DATABASE_URL', false]), file('.env.local', ['DATABASE_URL', false], ['DEBUG', false])],
      expect: NONE,
    },
    {
      name: 'per-environment files only',
      context: envTemplateContext(['.env.development', '.env.production', '.env.test']),
      candidates: [file('.env.development', ['API_URL', false]), file('.env.production', ['API_URL', false], ['CDN_URL', false]), file('.env.test', ['API_URL', false])],
      expect: NONE,
    },
    {
      name: 'a single filled env',
      context: envTemplateContext(['.env']),
      candidates: [file('.env', ['OPENAI_API_KEY', false], ['PORT', false])],
      expect: NONE,
    },
  ],
});
