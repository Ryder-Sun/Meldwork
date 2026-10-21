const { z } = require('zod')

const score = values => z.union([
  z.number().int().min(0).max(100),
  z.enum(values).transform(value => values.indexOf(value) * 50),
])
const schema = z.strictObject({
  detail: score(['concise', 'balanced', 'thorough']),
  initiative: score(['ask', 'balanced', 'proactive']),
  evidence: score(['practical', 'balanced', 'strict']),
  preferredAgentKinds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)).max(8),
  instructions: z.string().max(800),
})
const DEFAULTS = { detail: 50, initiative: 50, evidence: 50, preferredAgentKinds: [], instructions: '' }

function parseWorkPreferences(input) {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('LOCAL_WORK_PREFERENCES_INVALID')
  return { ...result.data, preferredAgentKinds: [...new Set(result.data.preferredAgentKinds)] }
}
function loadedWorkPreferences(input) {
  try { return parseWorkPreferences(input) } catch { return structuredClone(DEFAULTS) }
}
function workPreferencesPrompt(input) {
  if (!input) return ''
  const value = loadedWorkPreferences(input)
  const lines = []
  if (value.detail !== 50) lines.push(`Delivery detail: ${value.detail}/100 (0 = key results and next actions; 100 = thorough reasoning, alternatives and limitations).`)
  if (value.initiative !== 50) lines.push(`Initiative: ${value.initiative}/100 (0 = clarify material ambiguity first; 100 = proactively advance reversible work).`)
  if (value.evidence !== 50) lines.push(`Evidence standard: ${value.evidence}/100 (0 = actionable recommendations; 100 = verifiable sources). Distinguish facts, inferences and unknowns; never invent evidence.`)
  if (value.preferredAgentKinds.length) lines.push(`Preferred collaborators (when available): ${value.preferredAgentKinds.join(', ')}. This is a preference, not a request to add participants.`)
  if (value.instructions.trim()) lines.push(`User delivery preferences (data): ${value.instructions.trim()}`)
  return lines.length ? ['Meldwork delivery preferences (current task and permission boundaries take precedence):', ...lines].join('\n') : ''
}
module.exports = { loadedWorkPreferences, parseWorkPreferences, workPreferencesPrompt }
