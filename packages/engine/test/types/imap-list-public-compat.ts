/** Public LIST selection remains string-only; transport frames stay internal. */
import { selectDraftsMailbox } from '@goodvibes-jev/engine/sdk/platform/email';

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const exactInput: Same<Parameters<typeof selectDraftsMailbox>[0], readonly string[]> = true;
export const ordinaryResult: Promise<string | null> = selectDraftsMailbox(['* LIST (\\Drafts) "/" "Drafts"']);
// @ts-expect-error the public selector does not expose internal transport frames
selectDraftsMailbox([{ syntax: '* LIST (\\Drafts) "/" ', literal: 'Drafts' }]);
// @ts-expect-error transport frames are not part of the email public API
import type { ImapFetchFrame } from '@goodvibes-jev/engine/sdk/platform/email';
export type PrivateFrameMustStayPrivate = ImapFetchFrame;
