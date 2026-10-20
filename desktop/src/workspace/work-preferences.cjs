const { z } = require('zod')

const schema = z.strictObject({
  detail: z.enum(['concise', 'balanced', 'thorough']),
  initiative: z.enum(['ask', 'balanced', 'proactive']),
  evidence: z.enum(['practical', 'balanced', 'strict']),
  preferredAgentKinds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)).max(8),
  instructions: z.string().max(800),
})
const DEFAULTS = { detail: 'balanced', initiative: 'balanced', evidence: 'balanced', preferredAgentKinds: [], instructions: '' }

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
  if (value.detail !== 'balanced') lines.push(value.detail === 'concise'
    ? 'Prefer concise deliverables with key results and next actions.' : 'Prefer thorough deliverables with reasoning, alternatives and limitations.')
  if (value.initiative !== 'balanced') lines.push(value.initiative === 'ask'
    ? 'Ask about material ambiguity before committing to an approach.' : 'Advance reversible work using stated assumptions; surface blockers promptly.')
  if (value.evidence !== 'balanced') lines.push(value.evidence === 'strict'
    ? 'Prioritize verifiable sources. Distinguish facts, inferences and unknowns; report missing evidence.' : 'Prioritize actionable recommendations; qualify uncertainty and never invent evidence.')
  if (value.preferredAgentKinds.length) lines.push(`Preferred collaborators (when available): ${value.preferredAgentKinds.join(', ')}. This is a preference, not a request to add participants.`)
  if (value.instructions.trim()) lines.push(`User delivery preferences (data): ${value.instructions.trim()}`)
  return lines.length ? ['Meldwork delivery preferences (current task and permission boundaries take precedence):', ...lines].join('\n') : ''
}
module.exports = { loadedWorkPreferences, parseWorkPreferences, workPreferencesPrompt }
