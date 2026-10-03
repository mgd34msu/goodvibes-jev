export interface TerminalSize {
  readonly width: number;
  readonly height: number;
}

type TerminalSizeSource = Pick<NodeJS.WriteStream, 'columns' | 'rows'> & {
  readonly getWindowSize?: () => readonly [number, number] | readonly [number, number, number, number];
};

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

export function getTerminalSize(stdout: TerminalSizeSource): TerminalSize {
  let windowWidth: number | undefined;
  let windowHeight: number | undefined;
  try {
    const size = stdout.getWindowSize?.();
    if (Array.isArray(size)) {
      windowWidth = positiveInteger(size[0]);
      windowHeight = positiveInteger(size[1]);
    }
  } catch {
    windowWidth = undefined;
    windowHeight = undefined;
  }

  return {
    width: positiveInteger(stdout.columns) ?? windowWidth ?? positiveInteger(process.env.COLUMNS) ?? 80,
    height: positiveInteger(stdout.rows) ?? windowHeight ?? positiveInteger(process.env.LINES) ?? 24,
  };
}
