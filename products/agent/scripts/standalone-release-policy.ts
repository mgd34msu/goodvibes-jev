/** Retained registry-release tools must never operate on the private workspace. */
export function assertStandaloneReleaseAllowed(manifest: Record<string, unknown>, operation: string): void {
  const hasWorkspaceDependency = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .some((group) => {
      const dependencies = manifest[group];
      return dependencies !== null && typeof dependencies === 'object'
        && Object.values(dependencies).some((pin) => typeof pin === 'string' && pin.startsWith('workspace:'));
    });
  if (manifest.private === true || hasWorkspaceDependency) {
    throw new Error(`${operation} refuses a private/workspace package (${String(manifest.name ?? 'unnamed')}); the retained standalone registry release flow does not apply.`);
  }
}
