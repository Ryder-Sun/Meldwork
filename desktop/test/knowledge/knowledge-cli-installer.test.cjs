const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installKnowledgeCli } = require('../../src/knowledge/knowledge-cli-installer.cjs')

for (const [kind, spec] of [['feishu', '@larksuite/cli@1.0.100'], ['dingtalk', 'dingtalk-workspace-cli@1.0.68']]) {
  test(`${kind} installs only its pinned official package with native environment`, async () => {
    const env = { PATH: '/native/node/bin', HTTPS_PROXY: 'http://localhost:8080' }
    const calls = []
    await installKnowledgeCli(kind, { platform: 'darwin', env,
      findCommand: async (command, platform, options) => { assert.equal(options.env, env); return '/native/node/bin/npm' },
      verifyNpmIntegrity: async (command, recipe, options) => { assert.equal(options.env, env); assert.equal(`${recipe.packageName}@${recipe.version}`, spec); calls.push('verify') },
      runProcess: async (command, args, options) => { assert.equal(options.env, env); assert.equal(command, '/native/node/bin/npm'); assert.deepEqual(args, ['install', '--global', spec, '--registry', 'https://registry.npmjs.org/']); calls.push('install') },
    })
    assert.deepEqual(calls, ['verify', 'install'])
  })
}

test('rejects arbitrary packages and stops on integrity failure', async () => {
  await assert.rejects(installKnowledgeCli('constructor'), { code: 'INSTALL_AGENT_UNSUPPORTED' })
  let ran = false
  await assert.rejects(installKnowledgeCli('feishu', {
    findCommand: async () => '/usr/bin/npm',
    verifyNpmIntegrity: async () => { throw new Error('integrity mismatch') },
    runProcess: async () => { ran = true },
  }), /integrity mismatch/)
  assert.equal(ran, false)
})
