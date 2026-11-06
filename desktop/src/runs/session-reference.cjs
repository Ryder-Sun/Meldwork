const SESSION_REF = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/
const SECRET_LIKE_SESSION_REF = /^(?:sk|rk|pk|ghp|github_pat|xox[baprs]?)[_-][A-Za-z0-9_-]{12,}$/i

function normalizeSessionRef(value) {
  const sessionRef = String(value || '')
  return SESSION_REF.test(sessionRef) && !SECRET_LIKE_SESSION_REF.test(sessionRef) ? sessionRef : ''
}

module.exports = { normalizeSessionRef }
