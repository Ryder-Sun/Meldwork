const { createHash } = require('node:crypto')
const { sessionKey } = require('./local-workspace-context.cjs')
const { SESSION_KEY, normalizeSessionRef } = require('./local-workspace-inputs.cjs')
const { normalizeSessionMeta } = require('../runs/run-harness.cjs')

const PROFILE_KEY = /^[a-f0-9]{64}$/
const KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/
const MAX_ARCHIVED_SESSIONS = 10000

function profileKey(directory) {
  return createHash('sha256').update(String(directory || '')).digest('hex')
}

function parseNativeSessionProfiles(input) {
  if (input == null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
  const result = Object.create(null)
  let count = 0
  for (const [kind, profiles] of Object.entries(input)) {
    if (!KIND.test(kind) || !profiles || typeof profiles !== 'object' || Array.isArray(profiles)) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
    result[kind] = Object.create(null)
    for (const [profile, snapshot] of Object.entries(profiles)) {
      if (++count > MAX_ARCHIVED_SESSIONS || !PROFILE_KEY.test(profile) || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
          || !snapshot.sessions || typeof snapshot.sessions !== 'object' || Array.isArray(snapshot.sessions)
          || !snapshot.sessionMeta || typeof snapshot.sessionMeta !== 'object' || Array.isArray(snapshot.sessionMeta)) {
        throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
      }
      const sessions = Object.create(null)
      const sessionMeta = Object.create(null)
      for (const [key, value] of Object.entries(snapshot.sessions)) {
        const ref = normalizeSessionRef(value)
        if (!SESSION_KEY.test(key) || !ref || ref !== value || ++count > MAX_ARCHIVED_SESSIONS) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
        sessions[key] = ref
      }
      for (const [key, value] of Object.entries(snapshot.sessionMeta)) {
        if (!SESSION_KEY.test(key) || ++count > MAX_ARCHIVED_SESSIONS) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
        sessionMeta[key] = normalizeSessionMeta(value)
      }
      result[kind][profile] = { sessions, sessionMeta }
    }
  }
  return result
}

function switchNativeSessionProfile(state, kind, oldDirectory, newDirectory) {
  if (oldDirectory === newDirectory) return
  const profiles = parseNativeSessionProfiles(state.nativeSessionProfiles)
  const oldKey = profileKey(oldDirectory)
  const newKey = profileKey(newDirectory)
  const keys = new Set()
  const prefixes = []
  for (const group of state.groups || []) {
    keys.add(sessionKey(group.id, kind))
    prefixes.push([`${group.id}:${kind}:thread:`, `${group.id}:task:`])
    for (const message of state.messages || []) {
      if (message.groupId === group.id && message.role === 'user') keys.add(sessionKey(group.id, kind, message.id))
    }
  }
  const belongs = key => keys.has(key) || prefixes.some(([thread, task]) => key.startsWith(thread)
    || (key.startsWith(task) && key.endsWith(`:${kind}`)))
  const sessions = { ...(state.sessions || {}) }
  const sessionMeta = { ...(state.sessionMeta || {}) }
  const archived = { sessions: {}, sessionMeta: {} }
  for (const key of Object.keys(sessions)) {
    if (!belongs(key)) continue
    archived.sessions[key] = sessions[key]
    delete sessions[key]
  }
  for (const key of Object.keys(sessionMeta)) {
    if (!belongs(key)) continue
    archived.sessionMeta[key] = sessionMeta[key]
    delete sessionMeta[key]
  }
  profiles[kind] ||= Object.create(null)
  const previousArchive = profiles[kind][oldKey] || { sessions: {}, sessionMeta: {} }
  for (const field of ['sessions', 'sessionMeta']) {
    for (const [key, value] of Object.entries(archived[field])) {
      if (Object.hasOwn(previousArchive[field], key)
          && JSON.stringify(previousArchive[field][key]) !== JSON.stringify(value)) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
      previousArchive[field][key] = value
    }
  }
  profiles[kind][oldKey] = previousArchive
  const restored = profiles[kind][newKey]
  if (restored) {
    for (const [key, value] of Object.entries(restored.sessions)) {
      if (!belongs(key)) continue
      sessions[key] = value
      delete restored.sessions[key]
    }
    for (const [key, value] of Object.entries(restored.sessionMeta)) {
      if (!belongs(key)) continue
      sessionMeta[key] = value
      delete restored.sessionMeta[key]
    }
    if (!Object.keys(restored.sessions).length && !Object.keys(restored.sessionMeta).length) delete profiles[kind][newKey]
  }
  if (Object.keys(sessions).length > 1000 || Object.keys(sessionMeta).length > 1000) throw new Error('LOCAL_NATIVE_SESSION_PROFILES_INVALID')
  state.nativeSessionProfiles = parseNativeSessionProfiles(profiles)
  state.sessions = sessions
  state.sessionMeta = sessionMeta
}

module.exports = { parseNativeSessionProfiles, switchNativeSessionProfile }
