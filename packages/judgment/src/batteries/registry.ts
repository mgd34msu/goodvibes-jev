import type { NamedDecision } from './decision.ts';

/**
 * Every named decision a package defines (fixed-question batteries and
 * pattern instances), by name. Calibration walks a registry to run every
 * fixture, and the decision log resolves names through it.
 */
export class BatteryRegistry {
  readonly #batteries = new Map<string, NamedDecision>();

  register<D extends NamedDecision>(battery: D): D {
    if (this.#batteries.has(battery.name)) {
      throw new RangeError(`battery "${battery.name}" is already registered`);
    }
    this.#batteries.set(battery.name, battery);
    return battery;
  }

  get(name: string): NamedDecision | undefined {
    return this.#batteries.get(name);
  }

  list(): readonly NamedDecision[] {
    return [...this.#batteries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A registry holding every battery of the given registries; names must not collide. */
  static merge(...registries: readonly BatteryRegistry[]): BatteryRegistry {
    const merged = new BatteryRegistry();
    for (const registry of registries) for (const battery of registry.list()) merged.register(battery);
    return merged;
  }
}
