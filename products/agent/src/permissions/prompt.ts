import { activeTokens } from '../renderer/theme.ts';
import { beginModal, finishModal, wrapLines, type KitHint, type SurfaceLayer } from '../renderer/surface-kit.ts';
import { button, buttonWidth, type ButtonTone } from '../renderer/surface-kit-parts.ts';
import { modalHeightFor, modalTextWidth } from '../renderer/surface-kit-extra.ts';
import type { PermissionCategory, PermissionRequestAnalysis } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { buildPermissionApprovalBrief, getDisplayArg } from '@goodvibes-jev/engine/sdk/platform/permissions';

import type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/**
 * PermissionPromptUI - Renders a permission prompt as a kit modal layer.
 *
 * Stamped over the dimmed screen, above every other modal, while a request
 * is pending. The prompt blocks orchestrator execution until the user responds.
 *
 * Keys:
 *   y / Y  -> Allow once
 *   a / A  -> Allow always (this session)
 *   n / N  -> Deny
 *   Escape -> Deny
 */
export class PermissionPromptUI {
  private static fallbackAnalysis(request: PermissionPromptRequest): PermissionRequestAnalysis {
    return request.analysis ?? {
      classification: request.category,
      riskLevel: request.category === 'read' ? 'low' : request.category === 'write' ? 'medium' : 'high',
      summary: `Review ${request.tool} request`,
      reasons: ['Inspect the target and intent before approving this action.'],
      target: getDisplayArg(request.tool, request.args),
      targetKind: 'generic',
    };
  }

  /**
   * "Who is asking" line for the two attribution kinds (SDK 1.6.1) that have
   * no OTHER rendered channel for it. `background-agent` attribution is
   * deliberately excluded here: it already flows into the fleet
   * ProcessRegistry via `metadata.agentId` (see
   * bootstrap-core.ts's approvalMetadataForRequest), so a spawned agent's
   * pending ask is attributed on its own ProcessNode. An MCP server
   * elicitation or a sandbox host-access escalation has no ProcessNode to
   * attach to, this prompt is the ONLY place a user learns who/what is
   * asking, so those two kinds render an explicit line. Returns null for
   * `background-agent` and for no-attribution (foreground) requests.
   */
  private static attributionLine(request: PermissionPromptRequest): string | null {
    const attribution = request.attribution;
    if (!attribution) return null;
    if (attribution.kind === 'mcp-server') {
      return `MCP server: ${attribution.serverName}`;
    }
    if (attribution.kind === 'sandbox-escalation') {
      return `Sandbox ${attribution.sandbox}: ${attribution.escalations.join(', ')}`;
    }
    return null;
  }

  /** Returns the key argument to display for a given tool invocation. */
  static getDisplayArg(tool: string, args: Record<string, unknown>): string {
    return getDisplayArg(tool, args);
  }

  /** Returns the category label and the active-theme color for display. */
  static getCategoryLabel(category: PermissionCategory): { label: string; color: string } {
    const p = activeTokens();
    switch (category) {
      case 'write':    return { label: 'WRITE',    color: p.warning };
      case 'execute':  return { label: 'EXECUTE',  color: p.error };
      case 'delegate': return { label: 'DELEGATE', color: p.blocked };
      default:         return { label: 'PERMISSION', color: p.textMuted };
    }
  }

  static getPromptTitle(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).title;
  }

  static getSubjectLabel(request: PermissionPromptRequest): string {
    return buildPermissionApprovalBrief(request).subjectLabel;
  }

  /** The facts of a request as label / value pairs, every one shown in full. */
  static promptFacts(request: PermissionRequest): Array<{ label: string; value: string; fg: string }> {
    const tokens = activeTokens();
    const analysis = this.fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { color } = this.getCategoryLabel(request.category);
    const facts: Array<{ label: string; value: string; fg: string }> = [];
    const add = (label: string, value: string, fg: string = tokens.textMuted): void => { facts.push({ label, value, fg }); };
    add('Tool', request.tool, tokens.text);
    const attribution = this.attributionLine(request);
    if (attribution) add('Asked by', attribution);
    add(brief.subjectLabel, this.getDisplayArg(request.tool, request.args), tokens.text);
    add('Directory', request.workingDirectory ?? '(unknown)');
    add('Risk', `${analysis.riskLevel} (${analysis.classification})`, color);
    if (analysis.surface || analysis.blastRadius) add('Surface', `${analysis.surface ?? 'generic'}${analysis.blastRadius ? `  radius=${analysis.blastRadius}` : ''}`);
    if (analysis.host) add('Host', analysis.host);
    add('Summary', analysis.summary, tokens.text);
    add('Decision', brief.decisionModeLabel);
    if (analysis.sideEffects && analysis.sideEffects.length > 0) add('Effects', analysis.sideEffects.join(', '));
    for (const reason of analysis.reasons) add('Review', reason);
    add('Checklist', brief.checklist);
    return facts;
  }

  /**
   * The permission dialog as a kit modal layer: an amber cap (red for a high
   * risk), the request's title, every fact wrapped in full, and the three
   * choices. Drawn above every other modal; the keys (y / a / n, Esc denies)
   * live in shell/blocking-input.ts.
   */
  static createPromptLayer(screenWidth: number, screenHeight: number, request: PermissionRequest): SurfaceLayer {
    const tokens = activeTokens();
    const analysis = this.fallbackAnalysis(request);
    const brief = buildPermissionApprovalBrief(request);
    const { label, color } = this.getCategoryLabel(request.category);
    const high = analysis.riskLevel === 'high' || analysis.riskLevel === 'critical';
    const width = modalTextWidth(screenWidth, screenHeight);
    const labelW = 11;
    const valueW = Math.max(8, width - labelW - 1);
    const facts = this.promptFacts(request);
    const factRows = facts.reduce((n, fact) => n + wrapLines(fact.value, valueW).length, 0);
    const body = factRows + 2;
    const height = modalHeightFor(screenWidth, screenHeight, { hints: PROMPT_HINTS }, body);
    const f = beginModal(screenWidth, screenHeight, {
      title: brief.title,
      sub: label.toLowerCase(),
      hints: PROMPT_HINTS,
      height,
      center: true,
      cap: high ? 'danger' : 'warning',
      titleGlyph: { char: '△', fg: color },
      escKey: false,
    });
    let y = f.top;
    for (const fact of facts) {
      if (y > f.bottom - 2) break;
      f.canvas.put(f.l, y, fact.label, { fg: tokens.textFaint });
      for (const part of wrapLines(fact.value, valueW)) {
        if (y > f.bottom - 2) break;
        f.canvas.put(f.l + labelW + 1, y++, part, { fg: fact.fg });
      }
    }
    // The choices, as chips on the last body row.
    let x = f.l;
    const by = f.bottom;
    for (const [key, text, tone] of PROMPT_CHOICES) {
      if (x + buttonWidth(`${text} ${key}`) > f.r) break;
      x = button(f.canvas, x, by, `${text} ${key}`, false, tone) + 2;
    }
    return finishModal(f);
  }
}

/** Keycap hints of the permission dialog (the keys live in shell/blocking-input.ts). */
const PROMPT_HINTS: readonly KitHint[] = [['y', 'allow once'], ['a', 'allow for this session'], ['n', 'deny'], ['esc', 'deny']];
const PROMPT_CHOICES: ReadonlyArray<readonly [key: string, text: string, tone: ButtonTone]> = [
  ['y', 'Allow once', 'primary'],
  ['a', 'Allow for session', 'warning'],
  ['n', 'Deny', 'danger'],
];
