const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const { LocalSkillTrustStore } = require('../../src/skills/local-skill-trust-store.cjs')

function manifest() {
  return {
    schemaVersion: 1,
    recordType: 'meldwork-skill-manifest',
    identity: { id: 'global/review', version: '1.0.0' },
    origin: { type: 'local-unsigned', publisher: 'Local author' },
    agents: [{ kind: 'codex', minVersion: '0.100.0', maxVersion: '1.0.0' }],
    inputTypes: ['text'],
    tools: ['filesystem'],
    credentials: [],
    permissionMode: 'read-only',
    networkDestinations: [],
    sideEffectClass: 'none',
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-skill-trust-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storagePath = path.join(directory, 'private', 'trust.jsonl')
  let tick = 0
  const store = new LocalSkillTrustStore({
    storagePath,
    now: () => new Date(Date.UTC(2026, 7, 10, 0, 0, tick++)),
  })
  const input = {
    coordinates: {
      targetKind: 'codex', namespace: 'global', slug: 'review', name: 'Review',
    },
    manifest: manifest(),
    contentHash: 'a'.repeat(64),
  }
  return { input, storagePath, store }
}

test('approves exact Agent/content scope, persists reviewable state, and reloads', (t) => {
  const { input, storagePath, store } = fixture(t)
  const binding = store.binding(input)
  const decision = store.approve(binding)

  assert.match(binding.bindingId, /^skill-trust-binding-[a-f0-9]{64}$/)
  assert.match(decision.decisionId, /^skill-trust-decision-[a-f0-9]{64}$/)
  assert.deepEqual(store.approve(binding), decision)
  assert.equal(store.assertApproved(binding).decisionId, decision.decisionId)
  assert.equal(store.list()[0].manifest.origin.type, 'local-unsigned')
  assert.equal(fs.statSync(storagePath).mode & 0o777, 0o600)

  const restored = new LocalSkillTrustStore({ storagePath })
  assert.equal(restored.assertApproved(binding).decisionId, decision.decisionId)
})

test('content or manifest upgrades do not inherit approval and revocation is durable', (t) => {
  const { input, storagePath, store } = fixture(t)
  const binding = store.binding(input)
  store.approve(binding)
  assert.equal(store.decision({ ...input, contentHash: 'b'.repeat(64) }), null)
  assert.equal(store.decision({
    ...input,
    manifest: { ...input.manifest, identity: { ...input.manifest.identity, version: '1.1.0' } },
  }), null)

  store.revoke(binding.bindingId)
  assert.throws(
    () => store.assertApproved(binding),
    { message: 'LOCAL_SKILL_TRUST_REQUIRED' },
  )
  const restored = new LocalSkillTrustStore({ storagePath })
  assert.equal(restored.list()[0].state, 'revoked')
  assert.throws(
    () => restored.assertApproved(binding),
    { message: 'LOCAL_SKILL_TRUST_REQUIRED' },
  )
})

test('a failed revocation sync makes all trust checks unavailable until reload', t => {
  const { input, storagePath, store } = fixture(t)
  const binding = store.binding(input)
  store.approve(binding)
  const original = fs.fsyncSync
  fs.fsyncSync = () => { throw Object.assign(new Error('SYNC_FAILED'), { code: 'EIO' }) }
  try {
    assert.throws(() => store.revoke(binding.bindingId), { message: 'LOCAL_SKILL_TRUST_STORE_UNAVAILABLE' })
  } finally { fs.fsyncSync = original }
  for (const check of [() => store.decision(binding), () => store.assertApproved(binding),
    () => store.approve(binding), () => store.list()]) {
    assert.throws(check, { message: 'LOCAL_SKILL_TRUST_STORE_UNAVAILABLE' })
  }
  const restored = new LocalSkillTrustStore({ storagePath })
  assert.throws(() => restored.assertApproved(binding), { message: 'LOCAL_SKILL_TRUST_REQUIRED' })
})

test('tampered audit state fails closed without throwing during construction', (t) => {
  const { input, storagePath, store } = fixture(t)
  store.approve(input)
  fs.appendFileSync(storagePath, '{"forged":true}\n')

  const restored = new LocalSkillTrustStore({ storagePath })
  assert.equal(restored.diagnostic(), 'LOCAL_SKILL_TRUST_AUDIT_INVALID')
  assert.throws(
    () => restored.list(),
    { message: 'LOCAL_SKILL_TRUST_AUDIT_INVALID' },
  )
})

test('symlinked audit files fail closed without following the target', (t) => {
  const { storagePath } = fixture(t)
  const target = path.join(path.dirname(storagePath), 'outside.jsonl')
  fs.writeFileSync(target, '{}\n')
  fs.symlinkSync(target, storagePath)

  const restored = new LocalSkillTrustStore({ storagePath })
  assert.equal(restored.diagnostic(), 'LOCAL_SKILL_TRUST_AUDIT_INVALID')
})
