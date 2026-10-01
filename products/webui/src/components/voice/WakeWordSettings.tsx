/**
 * WakeWordSettings, everything a user needs to actually RUN wake detection here.
 *
 * The `voice.wake.*` rows already reach the schema-driven Settings "Voice" group, and
 * that is the right place to tune a threshold. It is not enough to get the feature
 * working in a browser, because three things are specific to this surface and none of
 * them is a config row:
 *
 *   - the models have to be provisioned on the daemon (~3.7 MB, an explicit act,
 *     never automatic) and this is where that act lives, with the size on the button;
 *   - the microphone is opted into PER ORIGIN, because a browser permission prompt is
 *     per origin, `voice.wake.surfaces.webui` is that opt-in and it defaults to off;
 *   - the settings resolver refuses or downgrades rows a tab cannot honour, and those
 *     refusals are written sentences that must be READ, not summarised.
 *
 * So blockers and limitations are rendered VERBATIM from the resolver. They are the
 * SDK's own wording about why a row is not in force, and re-phrasing them here would
 * be this surface inventing an explanation for a decision it did not make.
 *
 * The model's recall qualification rides `recallIsSyntheticOnly` from
 * `voice.wake.status` and is shown beside the setup action rather than buried: the
 * published recall figures are measured on synthesised speech only, no human
 * recording of the phrase exists, while the false-accept figures are measured on
 * real speech. Someone deciding whether to hold a microphone open should be told that
 * before they do it, not after.
 */
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sdk } from '../../lib/goodvibes';
import { formatError, isMethodNotInvokableError, isMethodUnavailableError } from '../../lib/errors';
import { formatBytes } from '../../lib/object';
import {
  useWakeProvisioning,
  useWakeState,
  useWakeSurfaceSettings,
  useWakeTranscriptionAvailable,
} from '../../lib/voice/useWake';
import { WAKE_SURFACE_KEY } from '../../lib/voice/wake-config';
import { STT_UNAVAILABLE_MESSAGE } from '../../lib/voice/voice-config';
import { wakeIndicatorCopy } from './wake-indicator';

interface WakeWordSettingsProps {
  /** True while the containing popover/sheet is open; gates the status read. */
  readonly open: boolean;
}

export function WakeWordSettings({ open }: WakeWordSettingsProps) {
  const queryClient = useQueryClient();
  const settings = useWakeSurfaceSettings();
  const hostState = useWakeState();
  const canTranscribe = useWakeTranscriptionAvailable();
  const { status, provision } = useWakeProvisioning(open);

  const setKey = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => sdk.operator.config.set(key, value),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['voice', 'config'] });
    },
  });

  // A daemon build that has never heard of voice.wake.status gets no section at all,
  // rather than a "not available" line about a verb it cannot have, the same honest
  // omission the local-voice card makes.
  const verbAbsent = status.isError
    && (isMethodUnavailableError(status.error) || isMethodNotInvokableError(status.error));
  if (verbAbsent) return null;

  const ready = status.data?.ready === true;
  const downloadBytes = status.data?.downloadBytes;
  const corrupt = [status.data?.classifier, status.data?.embedding, status.data?.notice]
    .filter((artifact) => artifact?.corrupt === true).length;

  return (
    <div className="voice-settings-wake" data-testid="voice-settings-wake">
      <p className="voice-settings-title">Wake word ("hey goodvibes")</p>

      {status.isPending && <p className="voice-settings-hint">Checking the wake-word models…</p>}

      {status.isError && (
        <p className="voice-settings-hint" role="alert">
          Wake-word status unavailable: {formatError(status.error)}
        </p>
      )}

      {status.isSuccess && (
        <>
          <p className="voice-settings-hint">
            {ready
              ? `Models installed and checksum-verified${status.data.modelVersion ? ` (${status.data.modelVersion})` : ''}.`
              : status.data.reason ?? 'The pinned wake-word models are not installed on the daemon yet.'}
          </p>

          {corrupt > 0 && (
            <p className="voice-settings-hint" role="alert">
              {corrupt === 1
                ? 'One installed file failed verification: it is present but torn, truncated, or the wrong asset. '
                  + 'Provisioning again replaces it.'
                : `${corrupt} installed files failed verification: present but torn, truncated, or the wrong `
                  + 'assets. Provisioning again replaces them.'}
            </p>
          )}

          {status.data.recallIsSyntheticOnly && (
            <p className="voice-settings-hint" data-testid="wake-recall-note">
              Worth knowing before you switch it on: this model’s published recall is measured on synthesised
              speech only, no human recording of the phrase exists, while its false-accept rate is measured on
              real speech. It may hear the phrase less reliably than the recall figure suggests.
            </p>
          )}

          {!ready && (
            <Button
              className="voice-settings-action"
              disabled={provision.isPending}
              onClick={() => provision.mutate()}
            >
              {provision.isPending
                ? 'Downloading…'
                : `Download the wake-word models${typeof downloadBytes === 'number' && downloadBytes > 0 ? ` (~${formatBytes(downloadBytes)})` : ''}`}
            </Button>
          )}

          {provision.isError && (
            <p className="voice-settings-hint" role="alert">{formatError(provision.error)}</p>
          )}

          {provision.isSuccess && (
            <div className="voice-settings-local-receipt" role="status">
              {provision.data.outcomes.map((outcome) => (
                <p key={outcome.component}>
                  {outcome.component}: {outcome.state}
                  {outcome.error ? `: ${outcome.error}` : ''}
                  {typeof outcome.bytes === 'number' ? ` (${formatBytes(outcome.bytes)})` : ''}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {/* The per-origin opt-in. Off by default and it must stay off until someone
          asks for it here: while it is off this tab never calls getUserMedia, so no
          microphone permission prompt appears at all. */}
      <Checkbox
        className="voice-settings-field voice-settings-field--check"
        checked={settings.surfaceEnabled}
        disabled={setKey.isPending}
        onChange={(checked) => setKey.mutate({ key: WAKE_SURFACE_KEY, value: checked })}
      >
        Listen for the wake word in this browser
      </Checkbox>
      <p className="voice-settings-hint">
        Opted into per browser, not inherited from the terminal: the microphone permission is this origin’s own.
        {settings.enabled
          ? ''
          : ' Wake detection is switched off for every device, so this alone will not start it.'}
      </p>

      {!settings.enabled && (
        <Checkbox
          className="voice-settings-field voice-settings-field--check"
          checked={settings.enabled}
          disabled={setKey.isPending}
          onChange={(checked) => setKey.mutate({ key: 'voice.wake.enabled', value: checked })}
        >
          Enable wake-word detection (all surfaces)
        </Checkbox>
      )}

      {setKey.isError && <p className="voice-settings-hint" role="alert">{formatError(setKey.error)}</p>}

      {/* A detector that fires into a daemon with no speech-to-text provider produces
          audio nobody can read. Saying so here beats a wake that chimes and then
          appears to do nothing. */}
      {!canTranscribe && (
        <p className="voice-settings-hint" role="alert" data-testid="wake-stt-missing">
          A confirmed wake would have nothing to transcribe it: {STT_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {/* Rows that stop the detector, verbatim from the resolver. */}
      {settings.blockers.length > 0 && (
        <ul className="voice-settings-wake-reasons" data-testid="wake-blockers">
          {settings.blockers.map((blocker) => (
            <li key={blocker.key} role="alert">
              <code>{blocker.key}</code> {blocker.detail}
            </li>
          ))}
        </ul>
      )}

      {/* Rows not in force while the detector still runs, verbatim. */}
      {settings.limitations.length > 0 && (
        <ul className="voice-settings-wake-reasons" data-testid="wake-limitations">
          {settings.limitations.map((limitation) => (
            <li key={limitation.key}>
              <code>{limitation.key}</code> {limitation.detail}
            </li>
          ))}
        </ul>
      )}

      {hostState.backendNote && (
        <p className="voice-settings-hint" data-testid="wake-backend-note">
          <code>voice.wake.browserBackend</code> {hostState.backendNote}
        </p>
      )}

      {hostState.phase !== 'off' && (
        <p className="voice-settings-hint" data-testid="wake-live-state">
          {wakeIndicatorCopy(hostState).label}: {wakeIndicatorCopy(hostState).detail}
          {hostState.backend ? ` Backend: ${hostState.backend}.` : ''}
        </p>
      )}

      {hostState.phase === 'latched' && (
        <p className="voice-settings-hint">
          Turn the switch above off and on again to try once more: a detector that could not stay up stops
          consuming the microphone rather than thrashing.
        </p>
      )}

      {hostState.lastTranscript && (
        <p className="voice-settings-hint" data-testid="wake-last-transcript">
          Last heard: "{hostState.lastTranscript}"
        </p>
      )}
    </div>
  );
}
