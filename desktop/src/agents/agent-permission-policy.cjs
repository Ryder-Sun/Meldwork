// Tool kinds an Agent may use without approval during a read-only turn.
const READ_ONLY_SAFE_TOOL_KINDS = new Set(['read', 'search', 'fetch', 'think'])

// Automatic answer to an Agent's permission request when the run is not
// waiting for a person. Returns the response to send, `null` when the request
// is refused but the Agent offered nothing to refuse with, or `undefined`
// when no automatic answer exists and the caller must ask the user.
//
// A read-only turn stays read-only even when the Agent asks: only
// side-effect-free tools are approved, while edits, deletes, moves, commands
// and mode switches are refused.
function automaticPermissionResponse(request, { allowWrite }) {
  const options = Array.isArray(request?.options) ? request.options : []
  if (!allowWrite && !READ_ONLY_SAFE_TOOL_KINDS.has(request?.toolCall?.kind)) {
    const rejection = options.find(candidate => candidate?.kind === 'reject_once')
      || options.find(candidate => candidate?.kind === 'reject_always')
    return rejection?.optionId ? { status: 'rejected', optionId: rejection.optionId } : null
  }
  const option = options.find(candidate => candidate?.kind === 'allow_once')
    || options.find(candidate => candidate?.kind === 'allow_always')
    || options[0]
  return option?.optionId ? { status: 'approved', optionId: option.optionId } : undefined
}

module.exports = { READ_ONLY_SAFE_TOOL_KINDS, automaticPermissionResponse }
