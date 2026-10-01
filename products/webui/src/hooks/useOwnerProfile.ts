/**
 * useOwnerProfile, the queries and mutations behind the owner-profile settings card
 * (profile.* verbs, docs/owner-profile.md §11.1).
 *
 * Same shape as usePowerStatus/useMemoryDiagnostics: one query per verb, a defensive wire
 * parse in the queryFn (lib/owner-profile.ts's readProfile* readers), and an honest
 * retriable error when the daemon answers 200 with a body that is not a profile. The
 * distinction that matters here is that "the profile could not be read" is a SUCCESSFUL
 * response carrying `state.kind: 'unavailable'` and a reason, not a query error,
 * because §4.4 requires that state to be stated rather than rendered as an empty profile.
 *
 * WHAT EVERY WRITE STATES. Three things, all claims this surface can make honestly:
 *
 *   `authority: 'owner-direct'`, where the fact came from. The daemon requires every
 *      caller to say: routes/owner-profile.ts's readAuthority 400s on an absent or
 *      unrecognised value, and it refuses rather than defaulting because §7 gives forget
 *      and undo an authority check and nothing else, so an unstated authority on a delete
 *      would be no gate at all. This surface can claim owner-direct truthfully because
 *      the only thing that reaches these calls is the owner typing into his own settings
 *      page, no page content, no message body and no document composes them. The agent
 *      must NOT hardcode this; it can genuinely be handed a purported fact by an email or
 *      a web page, and has to state which so the SDK can refuse.
 *   `surface: 'webui'` and `said: '(edited in settings)'`, §9.3's pair, which is what
 *      keeps the resulting line's provenance answerable.
 *
 * `explicitUserRequest` is deliberately NOT sent, and that is not the same call as
 * authority. It lives in an invocation context no transport populates, and
 * refuseNonUserRequest() refuses only an explicit `false`, so sending one would assert
 * something this surface cannot know, and sending `false` would refuse the owner's own
 * click. Authority is a body parameter every caller is already constructing, which is
 * exactly why stating it costs one word and closes a hole.
 *
 * No wire event exists for this domain, so nothing rides useRealtimeInvalidation; each
 * mutation invalidates the whole owner-profile key prefix.
 *
 * CONTAINMENT (§11.3): every value stays in react-query's in-memory cache and in React
 * state. Nothing here writes to localStorage/sessionStorage/IndexedDB, and nothing here
 * logs, a profile value must not reach a console, a persisted cache, or a diagnostic
 * view on this surface.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../lib/goodvibes';
import { queryKeys } from '../lib/queries';
import {
  forgetTargetInput,
  readProfileDocument,
  readProfileProvenanceAnswer,
  readProfileStatus,
  readProfileWriteOutcome,
  SETTINGS_EDIT_UTTERANCE,
  WEBUI_PROFILE_AUTHORITY,
  WEBUI_PROFILE_SURFACE,
  type ProfileDocument,
  type ProfileProvenanceAnswer,
  type ProfileStatus,
  type ProfileTarget,
  type ProfileWriteOutcome,
} from '../lib/owner-profile';

const MALFORMED_DOCUMENT = 'The daemon answered, but its response did not carry an owner profile.';
const MALFORMED_STATUS = 'The daemon answered, but its response did not carry the profile’s load state.';
const MALFORMED_PROVENANCE = 'The daemon answered, but its response did not carry provenance for this field.';

export function useOwnerProfileDocument() {
  return useQuery<ProfileDocument>({
    queryKey: queryKeys.ownerProfile,
    queryFn: async () => {
      const document = readProfileDocument(await sdk.operator.profile.read());
      if (!document) throw new Error(MALFORMED_DOCUMENT);
      return document;
    },
    staleTime: 10_000,
    retry: false,
  });
}

export function useOwnerProfileStatus() {
  return useQuery<ProfileStatus>({
    queryKey: queryKeys.ownerProfileStatus,
    queryFn: async () => {
      const status = readProfileStatus(await sdk.operator.profile.status());
      if (!status) throw new Error(MALFORMED_STATUS);
      return status;
    },
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * One field's provenance, fetched only once the operator asks for it, reachable per
 * field, never a bulk dump (§8.3).
 *
 * The verb takes a fieldId and nothing else, so there is no prose-line form of this call.
 * That is not a gap: a prose bullet's whole provenance is the suffix `profile.read`
 * already returned on the line, and §9.1 states prose bullets are never superseded, so
 * there is no predecessor list to go and fetch. The panel renders the line's own suffix
 * and says so.
 */
export function useOwnerProfileProvenance(fieldId: string | null) {
  return useQuery<ProfileProvenanceAnswer>({
    queryKey: queryKeys.ownerProfileProvenance(fieldId ?? 'none'),
    queryFn: async () => {
      if (fieldId === null) throw new Error('No field was named, so there is no provenance to look up.');
      const answer = readProfileProvenanceAnswer(await sdk.operator.profile.provenance(fieldId));
      if (!answer) throw new Error(MALFORMED_PROVENANCE);
      return answer;
    },
    enabled: fieldId !== null,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * A field edit. Per §9.3 this is a supersede, not a silent overwrite: the previous value
 * moves into a `<!-- was: … -->` comment and profile.undo can promote it back.
 *
 * The outcome may be null (a body that did not carry `ok`), the caller must render that
 * as "the daemon did not say", never as a success.
 */
export function useSetOwnerProfileField() {
  const queryClient = useQueryClient();
  return useMutation<ProfileWriteOutcome | null, unknown, { fieldId: string; value: string }>({
    mutationFn: async ({ fieldId, value }) => readProfileWriteOutcome(
      await sdk.operator.profile.set({
        fieldId,
        value,
        surface: WEBUI_PROFILE_SURFACE,
        said: SETTINGS_EDIT_UTTERANCE,
        authority: WEBUI_PROFILE_AUTHORITY,
      }),
    ),
    onSettled: async () => { await invalidateProfile(queryClient); },
  });
}

/** A new prose bullet in a section (§6), addressed by its heading as written. */
export function useAppendOwnerProfileLine() {
  const queryClient = useQueryClient();
  return useMutation<ProfileWriteOutcome | null, unknown, { section: string; text: string }>({
    mutationFn: async ({ section, text }) => readProfileWriteOutcome(
      await sdk.operator.profile.append({
        section,
        text,
        surface: WEBUI_PROFILE_SURFACE,
        said: SETTINGS_EDIT_UTTERANCE,
        authority: WEBUI_PROFILE_AUTHORITY,
      }),
    ),
    onSettled: async () => { await invalidateProfile(queryClient); },
  });
}

/**
 * Delete, permanently, no tombstone, no retention window, and every `<!-- was: … -->`
 * comment for that field goes with it (§9.2,
 * docs/decisions/2026-07-06-delete-means-delete.md). A field that was not there comes back
 * `ok: false` with the store's own "there was nothing to forget" sentence, which the
 * caller relays rather than translating into a success.
 */
export function useForgetOwnerProfile() {
  const queryClient = useQueryClient();
  return useMutation<ProfileWriteOutcome | null, unknown, ProfileTarget>({
    mutationFn: async (target) => readProfileWriteOutcome(
      await sdk.operator.profile.forget({ ...forgetTargetInput(target), authority: WEBUI_PROFILE_AUTHORITY }),
    ),
    onSettled: async () => { await invalidateProfile(queryClient); },
  });
}

/** Promote a field's most recent superseded value back (§9.1), the recovery for a wrong edit. */
export function useUndoOwnerProfile() {
  const queryClient = useQueryClient();
  return useMutation<ProfileWriteOutcome | null, unknown, string>({
    mutationFn: async (fieldId) => readProfileWriteOutcome(
      await sdk.operator.profile.undo({ fieldId, authority: WEBUI_PROFILE_AUTHORITY }),
    ),
    onSettled: async () => { await invalidateProfile(queryClient); },
  });
}

/** Every write can change the document, its counts, and any field's provenance history. */
async function invalidateProfile(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['owner-profile'] });
}
