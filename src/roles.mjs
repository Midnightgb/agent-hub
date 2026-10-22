import { CAPABILITY_KEYS } from './capabilities.mjs'
import { resolveHandoffSchema } from './handoff.mjs'

// Local copy of known task types to avoid an import cycle with router.mjs.
// Must match the keys in DELEGATION_MAP in src/router.mjs.
export const KNOWN_TASK_TYPES = Object.freeze([
  'recon',
  'call-chain-trace',
  'research',
  'triage',
  'second-opinion',
  'adversarial-review',
  'github-context',
  'mechanical-edit',
  'implementation-with-repo-rules',
  'architecture',
  'structured-mechanical',
  'ui-test'
])

const rolesObj = {
  TRACE_ANALYST: Object.freeze({
    name: 'TRACE_ANALYST',
    description: 'Traces execution paths and code references to cite findings',
    capabilities: Object.freeze([]),
    handoffSchema: 'ResearchHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['findings cite file:line']),
    defaultTaskType: 'recon'
  }),
  SECURITY_REVIEWER: Object.freeze({
    name: 'SECURITY_REVIEWER',
    description: 'Reviews code for security vulnerabilities, risks, and policy constraints',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'SecurityReviewHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['every finding names the risk and the evidence']),
    defaultTaskType: 'adversarial-review'
  }),
  ARCHITECT: Object.freeze({
    name: 'ARCHITECT',
    description: 'Evaluates architecture and design decisions with explicit tradeoffs',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'BaseHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['decisions list tradeoffs']),
    defaultTaskType: 'architecture'
  }),
  IMPLEMENTER: Object.freeze({
    name: 'IMPLEMENTER',
    description: 'Implements code changes matching diff expectations and requirements',
    capabilities: Object.freeze(['read', 'write']),
    handoffSchema: 'ImplementationHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['changedFiles matches the diff']),
    defaultTaskType: 'mechanical-edit'
  }),
  TEST_ANALYST: Object.freeze({
    name: 'TEST_ANALYST',
    description: 'Analyzes test failures and authors reproduction tests',
    capabilities: Object.freeze(['read', 'write']),
    handoffSchema: 'BaseHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['findings include the failing test']),
    defaultTaskType: 'mechanical-edit'
  }),
  ADVERSARIAL_REVIEWER: Object.freeze({
    name: 'ADVERSARIAL_REVIEWER',
    description: 'Adversarially reviews proposals and code to challenge assumptions',
    capabilities: Object.freeze(['read']),
    handoffSchema: 'ReviewHandoff',
    handoffRequired: true,
    acceptance: Object.freeze(['decisions explain what must change']),
    defaultTaskType: 'adversarial-review'
  })
}

Object.defineProperty(rolesObj, 'PLANNER', {
  value: Object.freeze({
    name: 'PLANNER',
    description: 'Plans workflows and validates task decomposition',
    capabilities: Object.freeze([]),
    handoffSchema: 'BaseHandoff',
    handoffRequired: false,
    acceptance: Object.freeze(['the plan validates against WorkflowPlan']),
    defaultTaskType: 'architecture'
  }),
  enumerable: false,
  writable: false,
  configurable: false
})

export const ROLES = Object.freeze(rolesObj)

export function getRole(name) {
  if (typeof name !== 'string') return null
  return Object.hasOwn(ROLES, name) ? ROLES[name] : null
}

export function listRoles() {
  return Object.keys(ROLES)
}

export function requirementsForRole(name) {
  const role = getRole(name)
  return role ? role.capabilities : []
}

export function validateRoles(roles = ROLES) {
  const errors = []
  const roleNames = roles && typeof roles === 'object'
    ? Object.getOwnPropertyNames(roles)
    : []

  for (const roleName of roleNames) {
    const role = roles[roleName]
    if (!Array.isArray(role?.capabilities)) {
      errors.push({
        role: roleName,
        field: 'capabilities',
        message: 'capabilities must be an array'
      })
    } else {
      for (const cap of role.capabilities) {
        if (!CAPABILITY_KEYS.includes(cap)) {
          errors.push({
            role: roleName,
            field: 'capabilities',
            message: `unknown capability: ${cap}`
          })
        }
      }
    }

    if (!resolveHandoffSchema(role?.handoffSchema)) {
      errors.push({
        role: roleName,
        field: 'handoffSchema',
        message: `unknown handoff schema: ${role?.handoffSchema}`
      })
    }

    if (role?.defaultTaskType !== undefined && !KNOWN_TASK_TYPES.includes(role.defaultTaskType)) {
      errors.push({
        role: roleName,
        field: 'defaultTaskType',
        message: `unknown defaultTaskType: ${role?.defaultTaskType}`
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return { ok: true }
}

const initialValidation = validateRoles(ROLES)
if (!initialValidation.ok) {
  const details = initialValidation.errors
    .map((e) => `${e.role}.${e.field}: ${e.message}`)
    .join('; ')
  throw new Error(`Roles validation failed at module load: ${details}`)
}
