import type { ApprovalBroker } from '../control-plane/approval-broker.js';

interface InteractiveApprovalContext {
  readonly broker: Pick<ApprovalBroker, 'claimApproval' | 'resolveApproval' | 'cancelApproval'>;
  parseBody(request: Request): Promise<Record<string, unknown> | Response | null>;
  actor(request: Request): string;
  record(request: Request, path: string, response: Response): Response;
}

/** The facade's explicit interactive button path, not a generic callback report. */
export async function handleInteractiveApprovalAction(
  context: InteractiveApprovalContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const body = await context.parseBody(req);
  const payload = body instanceof Response || body === null ? {} : body;
  const actor = context.actor(req);
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  if (action === 'claim') {
    const approval = await context.broker.claimApproval(approvalId, actor, 'web', note);
    return approval
      ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  if (action === 'cancel') {
    const approval = await context.broker.cancelApproval(approvalId, actor, 'web', note);
    return approval
      ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  const approval = await context.broker.resolveApproval(approvalId, {
    approved: action === 'approve',
    // This path is reached from a known button action. The separate HTTP
    // route also accepts legacy generic callback reports and cannot infer it.
    disposition: action === 'approve' ? 'approved' : 'denied',
    remember: typeof payload.remember === 'boolean' ? payload.remember : false,
    actor,
    actorSurface: 'web',
    note,
  });
  return approval
    ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
    : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
}
