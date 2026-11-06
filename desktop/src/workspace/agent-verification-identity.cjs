const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { NATIVE_CONFIG_DIRECTORIES } = require('../agents/native-config-directory.cjs')

function fileIdentity(filename) {
  try {
    const stat = fs.statSync(filename)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
  } catch { return null }
}

function selectedConfigurationIdentity(agent, preferences) {
  const directory = preferences?.[agent.kind]?.nativeConfigDirectory
  const spec = Object.hasOwn(NATIVE_CONFIG_DIRECTORIES, agent.kind) ? NATIVE_CONFIG_DIRECTORIES[agent.kind] : null
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !spec) return null
  const entries = spec.files.map(name => [name, fileIdentity(path.join(directory, name))])
  for (const name of spec.directories || []) {
    const root = path.join(directory, name)
    let children = []
    try {
      children = fs.readdirSync(root).sort()
      if (children.length > 256) return ['unbounded-directory', randomBytes(32).toString('hex')]
    } catch (error) {
      if (error.code !== 'ENOENT') return ['unreadable-directory', randomBytes(32).toString('hex')]
    }
    entries.push([name, fileIdentity(root), children.map(child => {
      const childPath = path.join(root, child)
      const nested = agent.kind === 'deepseek' && name === 'profiles'
        ? ['cordis.yml', 'cordis.patch.yml', '.credentials.yaml']
          .map(file => [file, fileIdentity(path.join(childPath, file))]) : null
      return [child, fileIdentity(childPath), nested]
    })])
  }
  return entries
}

function agentVerificationIdentity(agent, preferences = {}) {
  if (!agent?.kind) return ''
  let executableStat = null
  if (agent.executable) {
    try {
      const stat = fs.statSync(agent.executable)
      executableStat = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
    } catch { /* unavailable paths are still bound to their detected identity */ }
  }
  const identity = [
    agent.kind, agent.executable || '', agent.version || '', executableStat,
    agent.connectorId || '', agent.connectorVersion || '', agent.upstreamVersion || '',
    preferences?.[agent.kind]?.nativeConfigDirectory || '',
  ]
  const configuration = selectedConfigurationIdentity(agent, preferences)
  if (configuration !== null) identity.push(configuration)
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

module.exports = { agentVerificationIdentity }
