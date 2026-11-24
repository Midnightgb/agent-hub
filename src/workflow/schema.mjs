import { z } from 'zod'

export const NodeTypeSchema = z.enum(['delegate', 'fanout', 'fanin', 'notify'])

export const NodeSchema = z
  .object({
    id: z.string().min(1).optional(),
    step_id: z.string().min(1).optional(),
    type: NodeTypeSchema,
    agent: z.string().optional(),
    model: z.string().optional(),
    taskType: z.string().optional(),
    task: z.string().optional(),
    cwd: z.string().optional(),
    mode: z.enum(['read', 'write']).default('read'),
    dependsOn: z.array(z.string()).default([]),
    condition: z.string().optional(),
    maxAttempts: z.number().int().min(1).default(1),
    maxRevisionAttempts: z.number().int().min(0).optional(),
    timeoutS: z.number().positive().optional(),
    onSuccess: z.any().optional(),
    onFailure: z.any().optional(),
    verify: z.any().optional(),
    items: z.union([z.array(z.any()), z.string()]).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    artifacts: z.array(z.string()).optional(),
    handoff: z.any().optional(),
  })
  .transform((data) => {
    const id = data.id || data.step_id
    if (!id) {
      throw new Error('Node must have either id or step_id')
    }
    return {
      ...data,
      id,
      step_id: id,
    }
  })

/**
 * Finds a cycle in a directed graph of nodes.
 * Directed edge: node -> dependency (node depends on dependency).
 * @param {Array<{id: string, dependsOn?: string[]}>} nodes
 * @returns {string[] | null} Cycle path array if a cycle exists, else null.
 */
export function findCycleInGraph(nodes) {
  const adj = new Map()
  for (const node of nodes) {
    adj.set(node.id, node.dependsOn || [])
  }

  // 0 = unvisited, 1 = visiting (in current path stack), 2 = visited
  const visited = new Map()
  for (const node of nodes) {
    visited.set(node.id, 0)
  }

  function dfs(curr, pathStack) {
    visited.set(curr, 1)
    pathStack.push(curr)

    const deps = adj.get(curr) || []
    for (const dep of deps) {
      const state = visited.get(dep)
      if (state === 1) {
        // Cycle detected
        const idx = pathStack.indexOf(dep)
        const cyclePath = pathStack.slice(idx)
        cyclePath.push(dep)
        return cyclePath
      }
      if (state === 0) {
        const cycle = dfs(dep, pathStack)
        if (cycle) return cycle
      }
    }

    pathStack.pop()
    visited.set(curr, 2)
    return null
  }

  for (const node of nodes) {
    if (visited.get(node.id) === 0) {
      const cycle = dfs(node.id, [])
      if (cycle) return cycle
    }
  }

  return null
}

export const WorkflowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string().default(() => new Date().toISOString()),
    nodes: z.array(NodeSchema).min(1, 'Workflow must contain at least one node'),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((wf, ctx) => {
    const nodeIds = new Set()
    for (let i = 0; i < wf.nodes.length; i++) {
      const node = wf.nodes[i]
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate node id "${node.id}" in workflow "${wf.id}"`,
          path: ['nodes', i, 'id'],
        })
        return
      }
      nodeIds.add(node.id)
    }

    for (let i = 0; i < wf.nodes.length; i++) {
      const node = wf.nodes[i]
      for (const dep of node.dependsOn) {
        if (!nodeIds.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Node "${node.id}" depends on unknown node "${dep}"`,
            path: ['nodes', i, 'dependsOn'],
          })
          return
        }
        if (dep === node.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Cycle detected in workflow DAG: ${node.id} -> ${node.id}`,
            path: ['nodes', i, 'dependsOn'],
          })
          return
        }
      }
    }

    const cycle = findCycleInGraph(wf.nodes)
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cycle detected in workflow DAG: ${cycle.join(' -> ')}`,
        path: ['nodes'],
      })
    }
  })

/**
 * Creates and validates a workflow definition.
 * Throws an informative Error if validation fails or if the DAG contains a cycle.
 * @param {object} input
 * @returns {object} Validated workflow object
 */
export function createWorkflow(input) {
  const parsed = WorkflowSchema.safeParse(input)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    const err = new Error(firstIssue?.message || 'Invalid workflow definition')
    err.issues = parsed.error.issues
    err.zodError = parsed.error
    throw err
  }
  return parsed.data
}
