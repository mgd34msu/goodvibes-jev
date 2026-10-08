import { useRef, useState } from 'react';

interface DraftState {
  readonly source: string;
  /** Last observed or acknowledged value; an ack can precede its prop echo. */
  readonly baseline: string;
  readonly refresh: number;
  readonly edit: number;
  readonly text: string;
  readonly dirty: boolean;
  readonly conflicted: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

/**
 * A config input owns only text the user actually edited. Refetches update clean
 * fields immediately, but cannot turn old rendered text into a new config.set.
 * Dirty refetch conflicts require an explicit choice; a successful write retires
 * its draft without rolling back a newer config snapshot or a canceled edit.
 */
export function useSettingsDraft<T>(
  source: string,
  parse: (text: string) => { value: T; text: string },
  onCommit: (value: T) => void | Promise<void>,
) {
  const [state, setState] = useState<DraftState>({
    source, baseline: source, refresh: 0, edit: 0, text: source, dirty: false,
    conflicted: false, saving: false, error: null,
  });
  // React state alone does not guard two blur/Enter events in the same batch.
  const inFlight = useRef(false);

  if (source !== state.source) {
    if (source === state.baseline) {
      // A late echo of an acknowledged write is not a newer value. In
      // particular, it must not conflict with or retire the user's next edit.
      setState({ ...state, source });
    } else {
      const dirty = state.dirty && state.text !== source;
      setState({
        ...state, source, baseline: source, refresh: state.refresh + 1,
        text: dirty ? state.text : source,
        dirty, conflicted: dirty, error: null,
      });
    }
  }

  function change(text: string): void {
    if (inFlight.current) return;
    setState((current) => ({
      ...current, text, edit: current.edit + 1,
      dirty: text !== current.baseline,
      conflicted: current.conflicted && text !== current.baseline,
      error: null,
    }));
  }

  function reset(): void {
    setState((current) => ({
      ...current, text: current.baseline, edit: current.edit + 1,
      dirty: false, conflicted: false, error: null,
    }));
  }

  async function submit(overwrite = false): Promise<void> {
    if (inFlight.current || !state.dirty) return;
    let parsed: { value: T; text: string };
    try {
      parsed = parse(state.text);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    // Formatting-only edits (e.g. "$100" or "100.00") are not writes.
    if (parsed.text === state.baseline) {
      reset();
      return;
    }
    if (state.conflicted && !overwrite) return;
    inFlight.current = true;
    setState((current) => ({ ...current, saving: true, error: null }));
    try {
      await onCommit(parsed.value);
      setState((current) => current.edit !== state.edit ? current : ({
        ...current,
        text: current.refresh === state.refresh ? parsed.text : current.source,
        baseline: current.refresh === state.refresh ? parsed.text : current.source,
        dirty: false, conflicted: false, error: null,
      }));
    } catch (error) {
      setState((current) => current.edit !== state.edit ? current : ({
        ...current, error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      inFlight.current = false;
      setState((current) => ({ ...current, saving: false }));
    }
  }

  return { ...state, change, reset, submit };
}
