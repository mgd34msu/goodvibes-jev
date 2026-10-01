/**
 * useIsPhoneViewport, true at phone width (≤980px), the same breakpoint the
 * views' CSS uses to collapse to a single pane. Drives the "confirm on phone"
 * decision: a mutation that runs bare on desktop is routed through a confirm
 * sheet on a phone, where a stray tap is easy and the target is small.
 *
 * Reads matchMedia once at mount and subscribes to changes. In the test env the
 * matchMedia stub reports matches:false, so a unit test renders as desktop
 * (bare, un-gated) unless it overrides the stub.
 */
import { useEffect, useState } from 'react';

const PHONE_QUERY = '(max-width: 980px)';

function readIsPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(PHONE_QUERY).matches;
  } catch {
    return false;
  }
}

export function useIsPhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState<boolean>(readIsPhone);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = (): void => setIsPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isPhone;
}
