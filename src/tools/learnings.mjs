import { proposeLearning } from '../learnings.mjs'
import { startLearningProbe, learningProbeResult } from '../learning-probes.mjs'

/**
 * MCP tool handler for learning_propose. Always stores as pending — a human
 * must approve it in the dashboard before selectLearnings can ever return it.
 *
 * @param {import('../schemas.mjs').LearningInput} input
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Environment configuration holding AGENT_HUB_HOME.
 */
export function learningProposeTool(input, { env = process.env } = {}) {
  const learning = proposeLearning(input, env, { source: 'mcp' })
  return {
    learning,
    note: 'Stored as pending. A human must approve it in the dashboard (#/approvals?tab=learnings) before it is used.',
  }
}

/**
 * MCP tool handler for learning_probe: runs the same read task as a control
 * job (approved learnings only) and a treatment job (plus this pending
 * learning), in parallel. Never changes the learning's status.
 * Returns `{ probeId, controlJobId, treatmentJobId }`.
 */
export function learningProbeTool(input, { env = process.env, startJobFn } = {}) {
  return startLearningProbe(input, { env, ...(startJobFn ? { startJobFn } : {}) })
}

/** MCP tool handler for learning_probe_result: non-blocking; `done:false` until both jobs are terminal. */
export function learningProbeResultTool(input, { env = process.env } = {}) {
  return learningProbeResult(input, { env })
}
