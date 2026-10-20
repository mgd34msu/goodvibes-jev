/** A fleet slot is temporarily unavailable; no agent was admitted. */
export class AgentCapacityError extends Error {
  override readonly name = 'AgentCapacityError';
}
