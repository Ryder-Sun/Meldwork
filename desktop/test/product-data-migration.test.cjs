const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { migrateLegacyProductData } = require('../src/product-data-migration.cjs')

const LEGACY_STEM = ['round', 'relay'].join('')
const MIGRATION_SUFFIXES = [
  'workspace.json', 'run-ledger.json', 'custom-agents.json',
  'knowledge-base.json', 'private',
]

function legacyPath(directory, suffix) {
  return path.join(directory, `${LEGACY_STEM}-${suffix}`)
}

function currentPath(directory, suffix) {
  return path.join(directory, `meldwork-${suffix}`)
}

function writeLegacyData(directory, suffix) {
  const target = legacyPath(directory, suffix)
  if (suffix === 'private') {
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'outcomes.json'), '{}')
  } else {
    fs.writeFileSync(target, JSON.stringify({ suffix }))
  }
}

test('migrates legacy product data to Meldwork names without overwriting current data', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-data-migration-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const legacyWorkspace = path.join(directory, `${LEGACY_STEM}-workspace.json`)
  const legacyPrivate = path.join(directory, `${LEGACY_STEM}-private`)
  fs.writeFileSync(legacyWorkspace, '{"groups":[]}')
  fs.mkdirSync(legacyPrivate)
  fs.writeFileSync(path.join(legacyPrivate, 'outcomes.json'), '{}')
  const migrated = migrateLegacyProductData(directory)

  assert.deepEqual(migrated.sort(), [
    path.join(directory, 'meldwork-private'),
    path.join(directory, 'meldwork-workspace.json'),
  ].sort())
  assert.equal(fs.existsSync(legacyWorkspace), false)
  assert.equal(fs.readFileSync(path.join(directory, 'meldwork-workspace.json'), 'utf8'), '{"groups":[]}')
  assert.equal(fs.readFileSync(path.join(directory, 'meldwork-private', 'outcomes.json'), 'utf8'), '{}')
})

test('rolls back every completed rename when any migration position fails', async (t) => {
  for (let failurePosition = 1; failurePosition <= MIGRATION_SUFFIXES.length; failurePosition += 1) {
    await t.test(`rename ${failurePosition}`, () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-data-rollback-'))
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
      for (const suffix of MIGRATION_SUFFIXES) writeLegacyData(directory, suffix)
      let forwardRenameCount = 0
      const renameSync = (source, destination) => {
        if (path.basename(source).startsWith(`${LEGACY_STEM}-`)) {
          forwardRenameCount += 1
          if (forwardRenameCount === failurePosition) {
            throw Object.assign(new Error(`TEST_RENAME_${failurePosition}`), { code: 'EIO' })
          }
        }
        fs.renameSync(source, destination)
      }

      assert.throws(
        () => migrateLegacyProductData(directory, { renameSync }),
        error => error.code === 'MELDWORK_PRODUCT_DATA_MIGRATION_FAILED'
          && error.diagnostic?.status === 'rolled-back'
          && error.diagnostic?.failedStep === failurePosition,
      )
      for (const suffix of MIGRATION_SUFFIXES) {
        assert.equal(fs.existsSync(legacyPath(directory, suffix)), true, suffix)
        assert.equal(fs.existsSync(currentPath(directory, suffix)), false, suffix)
      }

      assert.equal(migrateLegacyProductData(directory).length, MIGRATION_SUFFIXES.length)
      assert.deepEqual(migrateLegacyProductData(directory), [])
    })
  }
})

test('completes a mixed migration state without overwriting existing Meldwork targets', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-data-mixed-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(currentPath(directory, 'workspace.json'), '{"current":true}')
  fs.mkdirSync(currentPath(directory, 'private'))
  fs.writeFileSync(path.join(currentPath(directory, 'private'), 'current.json'), '{}')
  for (const suffix of MIGRATION_SUFFIXES.slice(1, -1)) writeLegacyData(directory, suffix)

  const migrated = migrateLegacyProductData(directory)

  assert.equal(migrated.length, 3)
  assert.equal(fs.readFileSync(currentPath(directory, 'workspace.json'), 'utf8'), '{"current":true}')
  assert.equal(fs.readFileSync(path.join(currentPath(directory, 'private'), 'current.json'), 'utf8'), '{}')
  assert.deepEqual(migrateLegacyProductData(directory), [])
})

test('reports rollback failure and a second launch recovers the remaining mixed state', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-data-recovery-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const suffix of MIGRATION_SUFFIXES) writeLegacyData(directory, suffix)
  let forwardRenameCount = 0
  const renameSync = (source, destination) => {
    if (path.basename(source).startsWith(`${LEGACY_STEM}-`)) {
      forwardRenameCount += 1
      if (forwardRenameCount === 3) throw Object.assign(new Error('TEST_FORWARD_FAILURE'), { code: 'EIO' })
    } else if (path.basename(source) === 'meldwork-run-ledger.json') {
      throw Object.assign(new Error('TEST_ROLLBACK_FAILURE'), { code: 'EBUSY' })
    }
    fs.renameSync(source, destination)
  }

  assert.throws(
    () => migrateLegacyProductData(directory, { renameSync }),
    error => error.code === 'MELDWORK_PRODUCT_DATA_MIGRATION_RECOVERY_REQUIRED'
      && error.diagnostic?.status === 'recovery-required'
      && error.diagnostic?.rollbackFailures?.length === 1,
  )
  assert.equal(fs.existsSync(currentPath(directory, 'run-ledger.json')), true)
  assert.equal(fs.existsSync(legacyPath(directory, 'run-ledger.json')), false)
  assert.equal(fs.existsSync(legacyPath(directory, 'workspace.json')), true)
  assert.equal(fs.existsSync(currentPath(directory, 'workspace.json')), false)

  assert.equal(migrateLegacyProductData(directory).length, 4)
  for (const suffix of MIGRATION_SUFFIXES) {
    assert.equal(fs.existsSync(currentPath(directory, suffix)), true, suffix)
    assert.equal(fs.existsSync(legacyPath(directory, suffix)), false, suffix)
  }
  assert.deepEqual(migrateLegacyProductData(directory), [])
})
