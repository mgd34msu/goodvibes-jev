/**
 * Compatibility path for the Agent's local-turn owner-terminal posture.
 * The engine gate owns the value; composeAgentToolRegistry passes this same
 * enforced posture to the real exec tool, including turns run without a host.
 */
export { AGENT_OWNER_TERMINAL_GUARD } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
