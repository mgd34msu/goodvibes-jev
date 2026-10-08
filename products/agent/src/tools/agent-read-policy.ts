/** Agent read compatibility surface; the engine owns both observations and admission checks. */
export {
  AGENT_READ_IMAGE_MODES,
  AGENT_MAX_READ_FILES,
  AGENT_MAX_READ_IMAGE_SIZE_BYTES,
  AGENT_READ_POLICY_DENIAL_MESSAGE,
  isBlockedReadPath,
  validateReadToolInvocationForAgentPolicy,
  validateAgentReadMechanics,
  wrapReadToolForAdmittedAgentPolicy as wrapReadToolForAgentPolicy,
} from '@goodvibes-jev/engine/sdk/platform/gate/policy';
