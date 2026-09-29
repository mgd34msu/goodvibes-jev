/**
 * `engine.gate.ledger-arg`: what one argument of a tool call is, by the tool
 * and the argument's name, for the execution ledger's record of the call
 * (gate/policy/execution-ledger.ts). Read once per tool and argument name and
 * remembered for the process: the names repeat across calls, the values do
 * not.
 *
 * - `holds_credential`: does the argument carry a credential (a password,
 *   token, API key, client secret or authorization value)? Its value is then
 *   redacted from the ledger's preview and its name left out of the key list.
 *   It replaces a regex over the key name (api_key, authorization, bearer,
 *   client_secret, password, secret, token) that missed names such as
 *   `pat`, `passphrase` or `auth`, and redacted `max_tokens`.
 * - `is_target`: is the argument what the call acts on (the file, URL, query,
 *   task or record)? The ledger previews the first such value. It replaces a
 *   fixed list of key names (path, file, target, url, query, task).
 *
 * Band: high stakes for the credential question (a wrong no shows a secret in
 * a panel); code redacts unless the reading is a no that acts. Low stakes for
 * the target (it only picks what a preview line shows).
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const arg = (tool: string, argument: string) => ({ tool, argument });

export const ledgerArg = defineBattery({
  name: 'engine.gate.ledger-arg',
  version: 1,
  description: 'Whether a tool argument, by the tool and the argument name, carries a credential, and whether it is what the call acts on.',
  accuracyFloor: 0.85,
  items: {
    holds_credential: yesNo(
      'An AI agent calls the tool `tool` with an argument named `argument`. Would the value of this argument be a credential: a password or passphrase, an access token, an API key, a client secret or an authorization header value? A count, a limit, a model name, a path or ordinary text is a no.',
      STAKES_BANDS.high.yesNo,
    ),
    is_target: yesNo(
      'An AI agent calls the tool `tool` with an argument named `argument`. Is this argument what the call acts on: the file or directory, URL, search query, task, record or recipient the call is about? An option that only changes how the call behaves (a limit, a format, a flag, a timeout, content to write) is a no.',
      STAKES_BANDS.low.yesNo,
    ),
  },
  fixtures: [
    { name: 'api key', state: arg('fetch', 'api_key'), expect: { holds_credential: 'yes', is_target: 'no' } },
    { name: 'personal access token', state: arg('github', 'pat'), expect: { holds_credential: 'yes', is_target: 'no' } },
    { name: 'passphrase', state: arg('ssh_connect', 'passphrase'), expect: { holds_credential: 'yes', is_target: 'no' } },
    { name: 'authorization', state: arg('http_request', 'authorization'), expect: { holds_credential: 'yes', is_target: 'no' } },
    { name: 'max tokens', state: arg('agent', 'max_tokens'), expect: { holds_credential: 'no', is_target: 'no' } },
    { name: 'token budget', state: arg('repo_map', 'budgetTokens'), expect: { holds_credential: 'no', is_target: 'no' } },
    { name: 'read path', state: arg('read', 'path'), expect: { holds_credential: 'no', is_target: 'yes' } },
    { name: 'fetch url', state: arg('fetch', 'url'), expect: { holds_credential: 'no', is_target: 'yes' } },
    { name: 'search query', state: arg('web_search', 'query'), expect: { holds_credential: 'no', is_target: 'yes' } },
    { name: 'mail recipient', state: arg('send_email', 'to'), expect: { holds_credential: 'no', is_target: 'yes' } },
    { name: 'output format', state: arg('find', 'format'), expect: { holds_credential: 'no', is_target: 'no' } },
    { name: 'timeout', state: arg('exec', 'timeout_ms'), expect: { holds_credential: 'no', is_target: 'no' } },
  ],
});
