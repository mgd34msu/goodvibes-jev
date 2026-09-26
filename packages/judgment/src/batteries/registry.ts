import type { Battery, BatteryItems } from './battery.ts';

// Registries hold batteries of every shape; the item types are erased here.
export type AnyBattery = Battery<any>;

/**
 * Every battery a package defines, by name. Calibration walks a registry to
 * run every fixture, and the decision log resolves names through it.
 */
export class BatteryRegistry {
  readonly #batteries = new Map<string, AnyBattery>();

  register<Items extends BatteryItems>(battery: Battery<Items>): Battery<Items> {
    if (this.#batteries.has(battery.name)) {
      throw new RangeError(`battery "${battery.name}" is already registered`);
    }
    this.#batteries.set(battery.name, battery);
    return battery;
  }

  get(name: string): AnyBattery | undefined {
    return this.#batteries.get(name);
  }

  list(): readonly AnyBattery[] {
    return [...this.#batteries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A registry holding every battery of the given registries; names must not collide. */
  static merge(...registries: readonly BatteryRegistry[]): BatteryRegistry {
    const merged = new BatteryRegistry();
    for (const registry of registries) for (const battery of registry.list()) merged.register(battery);
    return merged;
  }
}
