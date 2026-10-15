/** Shared options and legacy defaults of Agent main-conversation reads. */
export const AGENT_READ_IMAGE_MODES = ['default', 'metadata-only', 'thumbnail-only', 'unoptimized'] as const;
/** @deprecated Reads use bounded concurrency, not a per-call batch rejection. */
export const AGENT_MAX_READ_FILES = 10;
export const AGENT_MAX_READ_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
