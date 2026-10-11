export { WEBUI_CODE_LANGUAGES, type WebuiCodeLanguage } from '@goodvibes-jev/engine/contracts';
/** Browser-safe structural catalogs. No provider, source resolver, or decision log. */
export { WEBUI_COMMAND_CATALOG_VERSION, WEBUI_BUILTIN_COMMANDS, type WebuiBuiltinCommandId } from './webui-command-catalog.js';
export { WEBUI_STATUS_CATALOG, readWebuiStatusCatalog, type WebuiStatusLabelId } from './webui-status-catalog.js';
export type { StatusValue } from './webui-types.js';
export { readDeclaredProviderCredential } from './provider-credential-catalog.js';
export { SECRET_BEARING_CONFIG_PATHS, isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
