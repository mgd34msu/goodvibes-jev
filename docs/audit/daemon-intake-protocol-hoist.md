# Intake protocol and optional routing hoist

Pinned source: daemon `443e5ee4d6cda0d36d57e2886398d0836074a4a9`, inbox provider `imap-client.ts` and `route-util.ts`. The implementations now live under the engine's host-only `platform/intake` subpath. Public IMAP names carry the `Intake` prefix to distinguish this bounded inbox reader from the richer email service. No browser export is added.

The reader preserves the existing LOGIN, SELECT, UID SEARCH, UID FETCH with a 600-byte BODY.PEEK and LOGOUT sequence, injectable provider client boundary, default 20-second deadline and 4 MiB response cap. The transport seam accepts an in-memory socket for tests. Optional route resolution retains the provider, sender digest and structured kind; a resolver failure leaves the item unbound and reports a warning.

Three executable regressions fail on the pinned reader before correction: command processing discards literal header/body lines; timeout errors expose the LOGIN credential; and control characters in a credential reach the command stream. The hoist preserves full literals, emits command/status-only diagnostics, and refuses command separators before writing. A server's rejection prose and transport errors cannot echo credentials into the resulting diagnostic. The byte cap counts UTF-8 bytes.

The response helper folds literals into the existing canonical email FETCH parser. Literal payloads are not protocol: embedded tagged completions, forged FETCH/UID/FLAGS text and multibyte content remain message text. Unreadable FETCH responses refuse rather than masquerading as an empty mailbox. RFC 2047 encoded words are decoded as bytes in their declared charset. This is protocol parsing and performs no judgment or preview sanitization.

Connection readiness has its own deadline, observes an eager greeting, and rejects a close during connection. Late connection callbacks cannot reopen a closed client. Commands cannot overlap; transport failure, timeout and exceeded response bounds close the owned socket. Tests use dummy credentials and in-memory transport only, and include close/listener cleanup, invalid values, numeric UID parsing and both encoded-word forms.

The product remains partial. The email adapter, Slack/Discord adapters, semantic preview mapping and triage are separate pending ports. These raw envelopes remain local; exporting this protocol module does not authorize transmitting their content to a judgment provider or expose them through the inbox wire surface.
