import fs from 'node:fs'
import path from 'node:path'

// opencode chain steps are pools (`@free`, `@go`) that route() expands from the
// live catalog in discovery.json (model-policy.mjs). Tests that expect an
// opencode candidate seed this catalog so `@free` resolves to a known model.
// One timestamp per test process, so two seeded homes compare equal.
const SEEDED_AT = new Date().toISOString()

export const SEEDED_FREE_MODEL = 'opencode/muse-spark-1.3-contributor-free'

export function seedOpencodeCatalog(home, models = [{ id: SEEDED_FREE_MODEL, cost: [{ input: 0, output: 0 }] }]) {
  const file = path.join(home, 'discovery.json')
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  current.opencode = { binPath: '/bin/opencode', version: 'test', checkedAt: SEEDED_AT, error: null, models }
  fs.writeFileSync(file, JSON.stringify(current))
  return home
}

// startJob rejects an opencode model the policy does not allow (model_blocked).
// Tests that launch opencode jobs for unrelated reasons record the user's
// "allowed" decision for the models they use.
export function allowOpencodeModels(home, models) {
  const decidedAt = new Date().toISOString()
  const decisions = Object.fromEntries(models.map((id) => [id, { allowed: true, decidedAt }]))
  fs.writeFileSync(path.join(home, 'model-policy.json'), JSON.stringify({ opencode: { decisions } }))
  return home
}
