/**
 * The kit's toast is the app's existing toast system, restyled to the design
 * document (bottom center, glass, one line, optional action, 5 s, pauses on
 * hover and focus, errors stay until dismissed). Raise one with useToast().
 */
export { Toast, ToastViewport } from '../toast';
export { ToastProvider, useToast, useOptionalToast } from '../../lib/toast';
export type { ToastOptions, ToastTone } from '../../lib/toast';
