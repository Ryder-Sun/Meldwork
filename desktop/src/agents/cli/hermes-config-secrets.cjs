const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const { nativeIdentityDirectory } = require('../native-config-directory.cjs')
const { hermesDotenvAssignments } = require('../hermes-dotenv.cjs')
const { configSecrets, nativeSecretEnvKeys } = require('./native-secret-environment.cjs')

function hermesConfigSecrets({ env, home, platform, declaredKeys }) {
  const root = nativeIdentityDirectory('hermes', env, home, platform)
  if (!root) return []
  const read = name => {
    const file = path.join(root, name)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) return ''
    return fs.readFileSync(file, 'utf8')
  }
  const configs = []
  for (const [name, parse] of [['config.yaml', yaml.load], ['auth.json', JSON.parse]]) {
    try { const content = read(name); if (content) configs.push(parse(content)) } catch { /* CLI reports invalid settings. */ }
  }
  const secrets = new Set(configSecrets(configs))
  const declared = new Set(nativeSecretEnvKeys(declaredKeys))
  try {
    for (const [key, value] of hermesDotenvAssignments(read('.env'), env)) {
      if ((declared.has(key) || /(?:API[_-]?KEY|ACCESS[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key))
          && value && value.length <= 8192) secrets.add(value)
    }
  } catch { /* Missing native environment is normal. */ }
  return [...secrets]
}

module.exports = { hermesConfigSecrets }
