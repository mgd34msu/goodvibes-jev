import { ToolError } from '../types/errors.js';

/** A missing model-selected tool is a recoverable call failure, never admission. */
export class UnknownPreparedToolError extends ToolError {
  constructor(toolName: string) {
    super('Unknown tool in autonomous preparation', toolName);
  }
}
