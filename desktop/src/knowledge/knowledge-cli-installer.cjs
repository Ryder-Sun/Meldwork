const { defaultFindCommand, defaultVerifyNpmIntegrity, prepareInstallCommand, validateInstallCommand, installerError } = require('../agents/installer/agent-installer-contract.cjs')
const { defaultRunProcess } = require('../agents/installer/agent-installer-runtime.cjs')

const RECIPES = Object.freeze({
  feishu: { type: 'npm', packageName: '@larksuite/cli', version: '1.0.100', integrity: 'sha512-QsgCZoTL65zUwul/zkgTbPkaCXOGMJn2dqt7qPOB8TAGYbvMsaQinXwnJQXpW3pJR1qJnAFT8TFIoJjmD6EWXQ==' },
  dingtalk: { type: 'npm', packageName: 'dingtalk-workspace-cli', version: '1.0.68', integrity: 'sha512-ONgoyNSUGN9o7M/1UR4ZAjXrLiPn5DaTXN8Y2LsmshVExYNtpU0Ko/DcPl2ulutw6Xfw2CPBSsgZhRCfRzoQqA==' },
})

async function installKnowledgeCli(kind, options = {}) {
  const recipe = Object.hasOwn(RECIPES, kind) ? RECIPES[kind] : null
  if (!recipe) throw installerError('INSTALL_AGENT_UNSUPPORTED')
  const platform = options.platform || process.platform
  const command = await (options.findCommand || defaultFindCommand)(platform === 'win32' ? 'npm.cmd' : 'npm', platform, options)
  if (!command) throw installerError('INSTALL_AGENT_NODE_REQUIRED')
  validateInstallCommand(command, recipe, platform)
  await (options.verifyNpmIntegrity || defaultVerifyNpmIntegrity)(command, recipe, { ...options, platform })
  const prepared = prepareInstallCommand(command, ['install', '--global', `${recipe.packageName}@${recipe.version}`, '--registry', 'https://registry.npmjs.org/'], { ...options, platform })
  await (options.runProcess || defaultRunProcess)(prepared.command, prepared.args, { ...options, platform })
}

module.exports = { installKnowledgeCli }
