/**
 * redirect-headers.ts, which request headers follow a redirect to another
 * origin.
 *
 * Three kinds of header never follow, in code:
 *   - Authorization, Proxy-Authorization and Cookie, which the protocol
 *     defines as credentials (RFC 9110 §11.6 and §11.7, RFC 6265; the Fetch
 *     standard drops Authorization on a cross-origin redirect);
 *   - the headers the tool itself set from the call's `auth` or `service`,
 *     which are credentials because that is where the tool put them.
 * Every other header the caller set is read by Jev from its NAME alone, never
 * its value (`engine.tools.credential-header`), and follows only on a no that
 * acts. A failed reading throws, and the fetch reports it as that URL's error.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { credentialHeader } from '../batteries/credential-header.js';

const CREDENTIAL_HEADER_SITE = 'tools.fetch.redirect-header';

/** The header names HTTP itself defines as carrying credentials, lower-cased. */
const PROTOCOL_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie']);

/** Whether a header the caller set may follow a redirect to another origin. */
async function followsToOtherOrigin(name: string): Promise<boolean> {
  const run = await credentialHeader.run(judgmentPort(CREDENTIAL_HEADER_SITE), { header: name }, { site: CREDENTIAL_HEADER_SITE });
  const { verdict, outcome } = run.readings.credential;
  const follows = verdict === 'no' && outcome === 'act';
  run.recordAction(follows ? 'sent to the redirected origin' : 'dropped at the cross-origin redirect');
  return follows;
}

/**
 * The headers that follow a redirect to another origin.
 *
 * @param headers - The headers of the request being redirected.
 * @param toolCredentialHeaders - Lower-cased names of the headers the tool set from `auth` or `service`.
 */
export async function headersForOtherOrigin(
  headers: Readonly<Record<string, string>>,
  toolCredentialHeaders: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const entries = Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    return !PROTOCOL_CREDENTIAL_HEADERS.has(normalized) && !toolCredentialHeaders.has(normalized);
  });
  const follows = await Promise.all(entries.map(([name]) => followsToOtherOrigin(name)));
  return Object.fromEntries(entries.filter((_, index) => follows[index]));
}
