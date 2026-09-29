/**
 * `engine.tools.credential-header`: does an HTTP request header, by its NAME,
 * carry a credential? Asked by the fetch tool when a redirect leaves the
 * request's origin, about each header the caller set that neither the
 * protocol nor the tool already marks as a credential. It replaces stripping
 * only Authorization, Cookie and Proxy-Authorization, which let a caller's
 * X-Auth-Token or X-API-Key follow the redirect to the other origin.
 *
 * Only the name is read, never the value.
 *
 * Band: asymmetric. A wrong no hands a credential to an origin the caller
 * never addressed, so keeping a header needs a strong no (the high band's no
 * side); a wrong yes drops a harmless header from one redirected request,
 * which the caller can send to the new origin directly, so dropping acts on a
 * medium yes. Code drops every header the reading does not clear with an
 * acting no.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const named = (header: string) => ({ header });

export const credentialHeader = defineBattery({
  name: 'engine.tools.credential-header',
  version: 1,
  description: 'Whether an HTTP request header, judged by its name alone, carries a credential or grants access.',
  accuracyFloor: 0.85,
  items: {
    credential: yesNo(
      '`header` is the name of an HTTP request header a caller set on a request. Judging by the name alone, does this header normally carry a credential or something that grants access: an API key, an access, session or CSRF token, a password, a signature or signing secret, or a session id? Headers that describe the request or its content, such as the accepted formats or language, the content type, the user agent, caching or conditional request fields, a request or trace id, a client or API version, or a limit setting, do not.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
    ),
  },
  fixtures: [
    { name: 'auth token', state: named('X-Auth-Token'), expect: { credential: 'yes' } },
    { name: 'api key', state: named('X-API-Key'), expect: { credential: 'yes' } },
    { name: 'bare api key', state: named('Api-Key'), expect: { credential: 'yes' } },
    { name: 'gitlab private token', state: named('Private-Token'), expect: { credential: 'yes' } },
    { name: 'aws session token', state: named('X-Amz-Security-Token'), expect: { credential: 'yes' } },
    { name: 'csrf token', state: named('X-CSRF-Token'), expect: { credential: 'yes' } },
    { name: 'google api key', state: named('X-Goog-Api-Key'), expect: { credential: 'yes' } },
    { name: 'session id', state: named('X-Session-Id'), expect: { credential: 'yes' } },
    { name: 'accept', state: named('Accept'), expect: { credential: 'no' } },
    { name: 'accept language', state: named('Accept-Language'), expect: { credential: 'no' } },
    { name: 'user agent', state: named('User-Agent'), expect: { credential: 'no' } },
    { name: 'content type', state: named('Content-Type'), expect: { credential: 'no' } },
    { name: 'if none match', state: named('If-None-Match'), expect: { credential: 'no' } },
    { name: 'request id', state: named('X-Request-Id'), expect: { credential: 'no' } },
    { name: 'api version', state: named('X-GitHub-Api-Version'), expect: { credential: 'no' } },
    { name: 'token limit', state: named('X-Max-Tokens'), expect: { credential: 'no' } },
  ],
});
