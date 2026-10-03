/**
 * What a tool declares it can do.
 *
 * Capability posture used to be inferred by scanning every registered tool's
 * name and description for words like "browser" and "desktop". That made
 * documentation load-bearing in a way nobody could see: rewording an unrelated
 * tool's description to mention a browser as an example flipped browser-control
 * readiness from "setup needed" to "ready" across every readiness surface, and
 * it is the same mechanism that once told the model browser tools were ready
 * when nothing could actually be invoked.
 *
 * A capability is now something a tool states about itself at registration.
 * Prose can say anything; it changes no posture.
 */

export type DeclaredToolCapability =
  /** Drives a real browser: opens pages, reads them, and acts on them. */
  'browser-control';

const declarations = new Map<DeclaredToolCapability, Set<string>>();

/** Records that `toolName` provides `capability`. Called where the tool registers. */
export function declareToolCapability(toolName: string, capability: DeclaredToolCapability): void {
  const existing = declarations.get(capability) ?? new Set<string>();
  existing.add(toolName);
  declarations.set(capability, existing);
}

/** Tool names that declared the capability, in a stable order. */
export function toolsDeclaringCapability(capability: DeclaredToolCapability): readonly string[] {
  return [...(declarations.get(capability) ?? new Set<string>())].sort((left, right) => left.localeCompare(right));
}

/** Test seam: clears declarations between cases. */
export function resetToolCapabilityDeclarationsForTests(): void {
  declarations.clear();
}
