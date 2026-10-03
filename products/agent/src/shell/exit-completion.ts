/** Await both exit owners before process exit or executable handover. */
export async function settleInteractiveExit(
  shutdown: Promise<void>,
  spokenOutput: Promise<void>,
): Promise<readonly unknown[]> {
  // Neither rejection can short-circuit the other owner's release. Audio owns
  // its existing bounded drain; runtime disposal remains fully awaited.
  const results = await Promise.allSettled([shutdown, spokenOutput]);
  return results.flatMap(result => {
    if (result.status !== 'rejected') return [];
    // Runtime shutdown aggregates independently failed owners. Preserve those
    // original errors as separate diagnostics instead of logging only its title.
    return result.reason instanceof AggregateError ? [...result.reason.errors] : [result.reason];
  });
}
