const { createHash } = require('node:crypto')
const { canonicalJson } = require('../collaboration/context-pack-records.cjs')

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

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

// A person's decision applies only to the exact request it was made for.
function matchesResumedPermission(request, resumedGate) {
  if (!request || !resumedGate?.request) return false
  try {
    if (canonicalJson(request) !== canonicalJson(resumedGate.request)) return false
  } catch {
    return false
  }
  const selected = request.options?.find(option => option.optionId === resumedGate.optionId)
  if (!selected) return false
  return resumedGate.status === 'approved'
    ? selected.kind.startsWith('allow_')
    : selected.kind.startsWith('reject_')
}

function permissionContinuationRequestId(requestHash, binding) {
  return sha256(canonicalJson({
    requestHash,
    sessionRefHash: binding.sessionRefHash,
    sessionProvenanceHash: binding.sessionProvenanceHash,
  }))
}

// A resumed permission decision must belong to the native session the
// request came from; anything else is refused before the Agent runs.
function assertResumedPermissionBinding(resumed, currentBinding, sessionRef) {
  const requestHash = sha256(canonicalJson(resumed.request))
  const persistedBinding = {
    sessionRefHash: resumed.sessionRefHash,
    sessionProvenanceHash: resumed.sessionProvenanceHash,
  }
  if (resumed.requestId !== permissionContinuationRequestId(requestHash, persistedBinding)
      || resumed.requestHash !== requestHash
      || resumed.sessionProvenanceHash !== currentBinding.sessionProvenanceHash
      || (sessionRef && resumed.sessionRefHash !== currentBinding.sessionRefHash)) {
    throw new Error('LOCAL_RUN_PERMISSION_REQUEST_MISMATCH')
  }
}

module.exports = {
  READ_ONLY_SAFE_TOOL_KINDS,
  assertResumedPermissionBinding,
  automaticPermissionResponse,
  matchesResumedPermission,
  permissionContinuationRequestId,
}
