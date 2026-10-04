import { BatteryRegistry } from '@goodvibes-jev/judgment/decisions';
import { editorMessageBlocking } from './editor-message.js';

export const registry = new BatteryRegistry();
registry.register(editorMessageBlocking);
