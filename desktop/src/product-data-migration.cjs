const fs = require('node:fs')
const path = require('node:path')

const LEGACY_PRODUCT_STEM = ['round', 'relay'].join('')

const MIGRATIONS = Object.freeze([
  ['workspace.json', 'workspace.json'],
  ['run-ledger.json', 'run-ledger.json'],
  ['custom-agents.json', 'custom-agents.json'],
  ['knowledge-base.json', 'knowledge-base.json'],
  ['private', 'private'],
])

function migrationFailure({ cause, failedStep, failedMove, completed, rolledBack, rollbackFailures }) {
  const recoveryRequired = rollbackFailures.length > 0
  const code = recoveryRequired
    ? 'MELDWORK_PRODUCT_DATA_MIGRATION_RECOVERY_REQUIRED'
    : 'MELDWORK_PRODUCT_DATA_MIGRATION_FAILED'
  const error = new Error(code, { cause })
  error.code = code
  error.diagnostic = Object.freeze({
    status: recoveryRequired ? 'recovery-required' : 'rolled-back',
    failedStep,
    failed: Object.freeze({
      source: failedMove.source,
      destination: failedMove.destination,
      code: String(cause?.code || ''),
    }),
    completed: Object.freeze(completed.map(move => Object.freeze({ ...move }))),
    rolledBack: Object.freeze(rolledBack.map(move => Object.freeze({ ...move }))),
    rollbackFailures: Object.freeze(rollbackFailures.map(item => Object.freeze({
      source: item.move.source,
      destination: item.move.destination,
      code: String(item.error?.code || ''),
    }))),
  })
  return error
}

function migrateLegacyProductData(userData, options = {}) {
  const root = path.resolve(String(userData || ''))
  const renameSync = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync
  const plan = MIGRATIONS.map(([legacySuffix, currentSuffix]) => ({
    source: path.join(root, `${LEGACY_PRODUCT_STEM}-${legacySuffix}`),
    destination: path.join(root, `meldwork-${currentSuffix}`),
  }))
  const migrated = []
  const completed = []
  for (let index = 0; index < plan.length; index += 1) {
    const move = plan[index]
    if (!fs.existsSync(move.source) || fs.existsSync(move.destination)) continue
    try {
      renameSync(move.source, move.destination)
      completed.push(move)
      migrated.push(move.destination)
    } catch (cause) {
      const rolledBack = []
      const rollbackFailures = []
      for (const completedMove of [...completed].reverse()) {
        try {
          const sourceExists = fs.existsSync(completedMove.source)
          const destinationExists = fs.existsSync(completedMove.destination)
          if (!sourceExists && destinationExists) {
            renameSync(completedMove.destination, completedMove.source)
          } else if (!(sourceExists && !destinationExists)) {
            throw Object.assign(new Error('MELDWORK_PRODUCT_DATA_MIGRATION_ROLLBACK_CONFLICT'), {
              code: 'MELDWORK_PRODUCT_DATA_MIGRATION_ROLLBACK_CONFLICT',
            })
          }
          rolledBack.push(completedMove)
        } catch (error) {
          rollbackFailures.push({ move: completedMove, error })
        }
      }
      throw migrationFailure({
        cause,
        failedStep: index + 1,
        failedMove: move,
        completed,
        rolledBack,
        rollbackFailures,
      })
    }
  }
  return migrated
}

module.exports = { migrateLegacyProductData }
