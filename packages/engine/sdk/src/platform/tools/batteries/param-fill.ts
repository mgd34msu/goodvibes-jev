/**
 * `engine.tools.param-fill`: a tool call is missing a required string
 * parameter and carries spare string arguments the tool does not require.
 * Which spare argument, if any, is the value the caller meant for the missing
 * parameter? Read by Jev in place of the substring overlap between the two
 * parameter NAMES that auto-repair.ts used (`pathValue` fills `path`,
 * `encoding` never does).
 *
 * The candidate-selection pattern: code offers only the spare arguments that
 * could type-check as the missing parameter (present, non-empty strings the
 * schema does not require); one choice picks among them or none, and one
 * yes/no per candidate confirms the pick fits on its own.
 *
 * Band: high stakes. The repaired call runs as if the caller had sent it, so
 * a wrong pick sends the wrong value into a tool (a wrong path, a wrong
 * query); a missed pick only lets the call fail on its missing parameter, as
 * it would have without repair. Only a pick that acts is applied.
 */
import { defineSelector, STAKES_BANDS, type Candidate, type JsonValue } from '@goodvibes-jev/judgment';

/** Most characters of an argument value or description the reading carries. */
export const MAX_JUDGED_ARGUMENT_CHARS = 400;

const clip = (text: string): string =>
  text.length <= MAX_JUDGED_ARGUMENT_CHARS ? text : `${text.slice(0, MAX_JUDGED_ARGUMENT_CHARS)} [${text.length - MAX_JUDGED_ARGUMENT_CHARS} more characters]`;

/** What the selection sees about the call: the tool, what it does, and the missing parameter. */
export function paramFillContext(tool: string, toolDescription: string, missing: string, missingDescription: string | undefined): JsonValue {
  return {
    tool,
    toolDescription: clip(toolDescription),
    missingParameter: missing,
    ...(missingDescription ? { missingParameterDescription: clip(missingDescription) } : {}),
  };
}

/** One spare argument as a candidate: its name, value and, when the schema has one, its description. */
export function paramFillCandidate(name: string, value: string, description: string | undefined): Candidate {
  return {
    id: name,
    content: { argument: name, value: clip(value), ...(description ? { description: clip(description) } : {}) },
  };
}

const context = (tool: string, toolDescription: string, missing: string, missingDescription?: string) =>
  paramFillContext(tool, toolDescription, missing, missingDescription);
const arg = (name: string, value: string, description?: string) => paramFillCandidate(name, value, description);

export const paramFill = defineSelector({
  name: 'engine.tools.param-fill',
  version: 1,
  description: 'Which spare argument of a tool call, if any, is the value the caller meant for a missing required parameter.',
  accuracyFloor: 0.85,
  instructions:
    'An AI model called the tool `context.tool` but left out the required parameter `context.missingParameter`. The call carries the spare arguments in `candidates`, which the tool does not require. Which spare argument holds the value the model meant to pass as `context.missingParameter`, most likely under a misspelled, abbreviated or alternative name? Choose none when no spare argument holds such a value.',
  fitInstructions:
    'Is this spare argument\'s value the value the model meant for `context.missingParameter`: the same kind of thing that parameter asks for (a file path for a path, a search text for a query, a URL for a url), so that passing it as that parameter carries out the call the model intended? An argument that means something else, such as an encoding, a mode, a label or a message for a different purpose, does not fit.',
  band: STAKES_BANDS.high.confidence,
  fitBand: STAKES_BANDS.high.yesNo,
  fixtures: [
    {
      name: 'path under an alternative name',
      context: context('read', 'Read a file from disk.', 'path', 'Path of the file to read.'),
      candidates: [arg('file_path', 'src/server.ts'), arg('encoding', 'utf-8', 'Text encoding.')],
      expect: 'file_path',
    },
    {
      name: 'path with a suffix on its name',
      context: context('read', 'Read a file from disk.', 'path', 'Path of the file to read.'),
      candidates: [arg('pathValue', '/etc/hosts')],
      expect: 'pathValue',
    },
    {
      name: 'query sent as q',
      context: context('web_search', 'Search the web.', 'query', 'What to search for.'),
      candidates: [arg('q', 'bun sqlite prepared statements'), arg('provider', 'brave', 'Search provider id.')],
      expect: 'q',
    },
    {
      name: 'url misspelled',
      context: context('fetch', 'Fetch a web page.', 'url', 'The address to fetch.'),
      candidates: [arg('ulr', 'https://bun.sh/docs'), arg('extract', 'markdown', 'Extraction mode.')],
      expect: 'ulr',
    },
    {
      name: 'command under cmd',
      context: context('exec', 'Run a shell command.', 'command', 'The shell command to run.'),
      candidates: [arg('cmd', 'git status --short')],
      expect: 'cmd',
    },
    {
      name: 'only an encoding is spare',
      context: context('read', 'Read a file from disk.', 'path', 'Path of the file to read.'),
      candidates: [arg('encoding', 'utf-8', 'Text encoding.')],
      expect: 'none',
    },
    {
      name: 'only a mode is spare',
      context: context('write', 'Write a file.', 'content', 'The text to write into the file.'),
      candidates: [arg('mode', 'overwrite', 'fail_if_exists, overwrite or backup.')],
      expect: 'none',
    },
    {
      name: 'a label is not the message',
      context: context('channel', 'Send a message to a channel.', 'text', 'The message text to send.'),
      candidates: [arg('target', '#deploys', 'The channel to send to.')],
      expect: 'none',
    },
    {
      name: 'message under body among others',
      context: context('channel', 'Send a message to a channel.', 'text', 'The message text to send.'),
      candidates: [arg('target', '#deploys', 'The channel to send to.'), arg('body', 'Deploy of v2.3 finished.')],
      expect: 'body',
    },
    {
      name: 'the value is the wrong kind despite a close name',
      context: context('read', 'Read a file from disk.', 'path', 'Path of the file to read.'),
      candidates: [arg('path_style', 'posix', 'Whether to print posix or windows paths.')],
      expect: 'none',
    },
  ],
});
