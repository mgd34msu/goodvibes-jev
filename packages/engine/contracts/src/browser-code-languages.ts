/** Closed renderer grammar identities, not content classification. */
export const WEBUI_CODE_LANGUAGES = ['bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'ini', 'java', 'javascript', 'json', 'markdown', 'php', 'plaintext', 'python', 'ruby', 'rust', 'shell', 'sql', 'typescript', 'wasm', 'xml', 'yaml'] as const;
export type WebuiCodeLanguage = typeof WEBUI_CODE_LANGUAGES[number];
