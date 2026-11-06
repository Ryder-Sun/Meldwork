const { createHash } = require('node:crypto')
const fs = require('node:fs')

function agentVerificationIdentity(agent) {
  if (!agent?.kind) return ''
  let executableStat = null
  if (agent.executable) {
    try {
      const stat = fs.statSync(agent.executable)
      executableStat = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
    } catch { /* unavailable paths are still bound to their detected identity */ }
  }
  return createHash('sha256').update(JSON.stringify([
    agent.kind, agent.executable || '', agent.version || '', executableStat,
    agent.connectorId || '', agent.connectorVersion || '', agent.upstreamVersion || '',
  ])).digest('hex')
}

module.exports = { agentVerificationIdentity }
