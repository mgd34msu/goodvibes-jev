import * as calendar from '../../sdk/src/platform/calendar/index.js';

// A real consumer retains the complete exported surface in the browser bundle.
(globalThis as unknown as { calendarBundleProbe: typeof calendar }).calendarBundleProbe = calendar;
