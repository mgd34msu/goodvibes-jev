/** Construction-only bridge from the product graph to completed host registration. */
import type { GatewayMethodCatalog, GatewayScopePolicyOwner } from './method-catalog.js';

type BootstrapPhase = 'facade' | 'boot';
const pending = new WeakMap<GatewayMethodCatalog, (phase: BootstrapPhase) => void>();
const prepared = new WeakSet<GatewayMethodCatalog>();

/** Native policy reads refuse until every initial host registration phase has completed. */
export function prepareGatewayScopePolicyOwner(catalog: GatewayMethodCatalog, beforeMutation: () => void,
  needsBoot = false): GatewayScopePolicyOwner {
  if (prepared.has(catalog)) throw new Error('Gateway scope bootstrap is already owned or retired');
  prepared.add(catalog);
  let active: GatewayScopePolicyOwner | undefined; let closed = false;
  const phases = new Set<BootstrapPhase>();
  const complete = (phase: BootstrapPhase) => {
    if (closed || active) throw new Error('Gateway scope bootstrap is no longer current');
    phases.add(phase);
    if (!phases.has('facade') || (needsBoot && !phases.has('boot'))) return;
    active = catalog.attachScopePolicyOwner(beforeMutation); pending.delete(catalog);
  };
  pending.set(catalog, complete);
  return Object.freeze({
    current() { if (closed || !active) throw new Error('Gateway scope bootstrap is incomplete or retired'); return active.current(); },
    close() { if (closed) return; closed = true; if (pending.get(catalog) === complete) pending.delete(catalog); active?.close(); },
  });
}

/** Idempotent host completion cannot mint an owner or reopen a retired graph. */
export function completeGatewayScopePolicyBootstrap(catalog: GatewayMethodCatalog, phase: BootstrapPhase = 'facade'): void {
  pending.get(catalog)?.(phase);
}
