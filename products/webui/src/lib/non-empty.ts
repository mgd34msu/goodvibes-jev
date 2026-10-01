/**
 * The string when it has content, else undefined, so a fallback written as
 * `nonEmpty(value) ?? fallback` also covers the empty string (which `??`
 * alone would keep). Dependency-free so router.ts can use it.
 */
export function nonEmpty(value: string | null | undefined): string | undefined {
  if (value) return value;
  return undefined;
}
