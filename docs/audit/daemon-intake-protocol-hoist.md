# Intake protocol and optional routing hoist

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, inbox provider `imap-client.ts` and `route-util.ts`. The implementations now live under the engine's host-only `platform/intake` subpath. Public IMAP names carry the `Intake` prefix to distinguish this bounded inbox reader from the richer email service. No browser export is added.

The reader preserves the existing LOGIN, SELECT, UID SEARCH, UID FETCH with a 600-byte BODY.PEEK and LOGOUT sequence, injectable provider client boundary, default 20-second deadline and 4 MiB response cap. The transport seam accepts an in-memory socket for tests. Optional route resolution retains the provider, sender digest and structured kind; a resolver failure leaves the item unbound and reports a warning.

Three executable regressions fail on the pinned reader before correction: command processing discards literal header/body lines; timeout errors expose the LOGIN credential; and control characters in a credential reach the command stream. The hoist preserves full literals, emits command/status-only diagnostics, and refuses command separators before writing. A server's rejection prose and transport errors cannot echo credentials into the resulting diagnostic. The byte cap counts original socket octets, before any text decoding.

The response helper passes explicit syntax/literal frames into the canonical email FETCH parser. Literal boundaries are counted on raw socket bytes; only the isolated payload is decoded as UTF-8 text, with replacement characters for invalid sequences. The collector stops exactly at the real tagged completion and does not fold later unsolicited responses into the command. Literal payloads are not protocol: embedded tagged completions, forged FETCH/UID/FLAGS text and multibyte content remain message text. Unreadable FETCH responses refuse rather than masquerading as an empty mailbox. RFC 2047 encoded words are decoded as bytes in their declared charset. This is protocol parsing and performs no judgment or preview sanitization.

Connection readiness has its own deadline, observes an eager greeting, and rejects a close during connection. Late connection callbacks cannot reopen a closed client. Commands cannot overlap; transport failure, timeout and exceeded response bounds close the owned socket. Tests use dummy credentials and in-memory transport only, and include close/listener cleanup, invalid values, numeric UID parsing and both encoded-word forms.

The product remains partial. The email adapter, Slack/Discord adapters, semantic preview mapping and triage are separate pending ports. These raw envelopes remain local; exporting this protocol module does not authorize transmitting their content to a judgment provider or expose them through the inbox wire surface.

## Review regressions and shared-parser boundary

The review's quote-leading literal (`"text" UID 999)`) and one-byte-chunk 8-bit literal probes fail on `3b1c3a1`: literal data can replace the protocol UID or fabricate command completion. The new guarded regressions preserve literal NIL, quotes, whitespace, empty data, invalid UTF-8 and incomplete UTF-8 previews; body-contained FETCH/tag text cannot settle a command before the genuine completion.

`parseFetchResponses` accepts explicit `ImapFetchFrame` records in addition to the existing string-array contract. Intake uses only the framed path. The richer email `ImapSession` still decodes socket text and flattens literal payloads into strings; the new parser seam cannot recover discarded byte/literal boundaries for that legacy caller. Migrating that separate session protocol is a follow-on, not a claim of this intake repair.
