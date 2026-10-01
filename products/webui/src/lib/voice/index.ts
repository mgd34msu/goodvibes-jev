/**
 * Voice surface public exports, TTS playback (request policy + Web Audio player),
 * the ONE browser microphone path and the arbiter that keeps it single, wake-word
 * detection inside the tab, the shared voice config reads, and the React glue. See
 * each module for the honest-state and single-sink design notes.
 */
export * from './request-policy';
export * from './tts-player';
export * from './capture';
export * from './mic-arbiter';
export * from './wake-config';
export * from './wake-chime';
export * from './wake-models';
export * from './wake-runtime';
export * from './wake-host';
export * from './voice-config';
export * from './useVoice';
export * from './useWake';
