/**
 * FleetSessionActions, the wire-backed session actions for a fleet process-tree node
 * that has a live sessionRef.sessionId: a compact steer input (when steerable) and a
 * "detach this browser" action (whenever a session is attached, regardless of
 * steerable).
 *
 * Session classification is host-owned. Native sessions use the shared original-source
 * continuation workflow; only explicit legacy sessions retain the compact steer input.
 * Detach remains separate and targets this browser's existing surface identity.
 *
 * Only rendered for a node where lib/fleet.ts's wireBackedActions(node) includes
 * 'steer' and/or 'detach', never a disabled ghost control for a node this client
 * cannot act on.
 */

import { useState, type SyntheticEvent } from 'react';
import { SendHorizontal, Unlink } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sdk, WEBUI_SURFACE_ID, WEBUI_SURFACE_KIND } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import { useToast } from '../../lib/toast';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { SessionContinuation } from '../sessions/SessionContinuation';

export interface FleetSessionActionsProps {
  sessionId: string;
  /** Show the steer input, only true when the node is 'agent' + capabilities.steerable. */
  steerable: boolean;
  /** Show the detach action, true for any node with a live sessionRef. */
  detachable: boolean;
}

export function FleetSessionActions({ sessionId, steerable, detachable }: FleetSessionActionsProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const detach = useMutation({
    mutationFn: () => sdk.operator.sessions.detach(sessionId, WEBUI_SURFACE_ID),
    onSuccess: async () => {
      toast({ title: 'Detached: this browser stops receiving live updates for this session', tone: 'info' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    },
    onError: (error: unknown) => {
      toast({ title: 'Detach failed', description: formatError(error), tone: 'danger' });
    },
  });

  if (!steerable && !detachable) return null;

  return (
    <div className="work-steer">
      {steerable && (
        <SessionContinuation sessionId={sessionId}>
          <LegacyFleetSteer sessionId={sessionId} />
        </SessionContinuation>
      )}
      {detachable && (
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon={<Unlink aria-hidden="true" />}
            disabled={detach.isPending}
            title="Stop this browser from receiving live updates for this session, does not stop the process, and other attached surfaces are unaffected"
            onClick={() => detach.mutate()}
          >
            {detach.isPending ? 'Detaching…' : 'Detach this browser'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The existing compact fleet action, available only after explicit legacy discovery. */
function LegacyFleetSteer({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState('');

  const steer = useMutation({
    mutationFn: (body: string) =>
      sdk.operator.sessions.steer(sessionId, { body, surfaceKind: WEBUI_SURFACE_KIND, surfaceId: WEBUI_SURFACE_ID }),
    onSuccess: async () => {
      setText('');
      toast({ title: 'Steer sent', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: queryKeys.fleet });
    },
    onError: (error: unknown) => {
      toast({ title: 'Steer failed', description: formatError(error), tone: 'danger' });
    },
  });

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = text.trim();
    if (!body || steer.isPending) return;
    steer.mutate(body);
  }

  return (
    <form className="work-steer__form" onSubmit={submit}>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Steer this agent…"
        aria-label="Steer message"
        disabled={steer.isPending}
      />
      <Button
        type="submit"
        icon={<SendHorizontal aria-hidden="true" />}
        disabled={!text.trim() || steer.isPending}
        aria-label="Send steer"
      >
        {steer.isPending ? 'Sending…' : 'Steer'}
      </Button>
    </form>
  );
}
