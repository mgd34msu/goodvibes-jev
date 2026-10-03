import manifest from '../../package.json';

/** A private workspace product has no separately published binary update channel. */
export const IS_WORKSPACE_DISTRIBUTION = manifest.private === true
  && manifest.dependencies['@goodvibes-jev/engine'] === 'workspace:*';
export const WORKSPACE_REBUILD_COMMAND = 'bun run --filter @goodvibes-jev/tui build';
export const WORKSPACE_UPDATE_GUIDANCE = `This TUI is built from a private Jev workspace. Update the workspace and build the engine, then run ${WORKSPACE_REBUILD_COMMAND} from the workspace root.`;
