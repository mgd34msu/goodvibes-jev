/** Consumer-vantage declarations for structural normalization, not previews. */
import {
  sha256First, digestSender, stripMarkup, normalizeWhitespace,
} from '@goodvibes-jev/engine/sdk/platform/intake';

const hash: (input: string, hexChars: number) => string = sha256First;
const digest: (senderExternalId: string) => string = digestSender;
const markup: (input: string) => string = stripMarkup;
const whitespace: (input: string) => string = normalizeWhitespace;
// @ts-expect-error A structural helper does not accept an absent body.
stripMarkup(undefined);
// @ts-expect-error Digest width is an explicit numeric parameter.
sha256First('fixture');
export { hash, digest, markup, whitespace };
