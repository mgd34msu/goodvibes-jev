import type { ResolvedCommandCandidate } from './webui-types.js';

/** Public descriptors from upstream WebUI 2.0.0 dadf577; callbacks stay in the browser. */
export const WEBUI_COMMAND_CATALOG_VERSION = 'webui.commands.v1';
const COMMANDS = [
  {"id": "nav.chat", "title": "Go to Chat", "group": "navigation", "keywords": ["chat", "messages", "live"]},
  {"id": "nav.knowledge", "title": "Go to Knowledge", "group": "navigation", "keywords": ["knowledge", "wiki", "docs"]},
  {"id": "nav.work", "title": "Go to Work", "group": "navigation", "keywords": ["work", "sessions", "agents", "processes", "fleet", "approvals", "needs you", "checkpoints", "ci"]},
  {"id": "nav.library", "title": "Go to Library", "group": "navigation", "keywords": ["library", "memory", "knowledge", "review"]},
  {"id": "nav.personal", "title": "Go to Personal", "group": "navigation", "keywords": ["personal", "calendar", "mail", "occasions", "dates"]},
  {"id": "nav.providers", "title": "Models and providers", "group": "settings", "keywords": ["providers", "models", "llm", "ai", "settings"]},
  {"id": "nav.admin", "title": "Open settings", "group": "settings", "keywords": ["admin", "settings", "auth", "account", "preferences"]},
  {"id": "chat.new", "title": "New Chat", "group": "chat", "keywords": ["new", "create", "session"]},
  {"id": "system.palette", "title": "Open Command Palette", "group": "system", "keywords": ["command", "palette", "search"]},
  {"id": "system.shortcuts", "title": "Show Keyboard Shortcuts", "group": "system", "keywords": ["shortcuts", "hotkeys", "help", "cheatsheet"]},
  {"id": "system.toggleTheme", "title": "Toggle Theme", "group": "system", "keywords": ["theme", "dark", "light", "color"]},
  {"id": "view.toggleDensity", "title": "Toggle Density", "group": "view", "keywords": ["density", "compact", "comfortable", "spacious"]},
  {"id": "view.toggleSidebar", "title": "Toggle sidebar", "group": "view", "keywords": ["sidebar", "navigation", "collapse", "rail", "panel"]},
  {"id": "settings.general", "title": "Appearance and behavior", "group": "settings", "keywords": ["settings", "appearance", "theme", "dark", "light", "neon", "density", "compact", "timezone"]},
  {"id": "settings.account", "title": "Sign-in", "group": "settings", "keywords": ["settings", "sign in", "login", "password", "token", "auth", "passkey", "step-up", "profile", "mail", "calendar", "admin"]},
  {"id": "settings.devices", "title": "Devices and pairing", "group": "settings", "keywords": ["settings", "pair", "pairing", "phone", "device", "qr", "revoke", "keep awake", "sleep", "slack", "discord", "telegram"]},
  {"id": "settings.people", "title": "People and channels", "group": "settings", "keywords": ["settings", "principals", "identity", "channel", "binding", "profiles"]},
  {"id": "settings.credentials", "title": "Credentials", "group": "settings", "keywords": ["settings", "secret", "key", "api key", "subscription", "accounts", "store"]},
  {"id": "settings.usage", "title": "Usage", "group": "settings", "keywords": ["settings", "usage", "cost", "spend", "budget", "payment", "card", "tokens"]},
  {"id": "settings.voice", "title": "Voice", "group": "settings", "keywords": ["settings", "speech", "microphone", "mic", "dictation", "wake", "stt", "tts"]},
  {"id": "settings.notifications", "title": "Notifications", "group": "settings", "keywords": ["settings", "push", "install", "alert", "reminder"]},
  {"id": "settings.checkins", "title": "Check-ins", "group": "settings", "keywords": ["settings", "check-in", "checkin", "proactive", "schedule", "quiet hours", "cadence"]},
  {"id": "settings.memory", "title": "Memory", "group": "settings", "keywords": ["settings", "provenance", "consolidation", "remember", "recall", "diagnostics"]},
  {"id": "settings.permissions", "title": "Permissions", "group": "settings", "keywords": ["settings", "approval", "approve", "allow", "deny", "sandbox", "policy", "safety"]},
  {"id": "settings.network", "title": "Network", "group": "settings", "keywords": ["settings", "tailscale", "https", "serve", "lan", "relay", "port", "listener"]},
  {"id": "settings.all", "title": "Advanced", "group": "settings", "keywords": ["settings", "all settings", "config", "raw", "key", "schema"]},
  {"id": "settings.about", "title": "About", "group": "settings", "keywords": ["settings", "version", "status", "daemon", "origin", "realtime", "diagnostics"]},
] as const satisfies readonly (ResolvedCommandCandidate & { readonly id: string })[];
export type WebuiBuiltinCommandId = typeof COMMANDS[number]['id'];
export const WEBUI_BUILTIN_COMMANDS = Object.freeze(COMMANDS.map((command) => Object.freeze({ ...command, keywords: Object.freeze([...command.keywords]) })));
