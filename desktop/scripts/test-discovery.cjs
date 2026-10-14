const fs = require('node:fs')
const path = require('node:path')

const TEST_SUITES = Object.freeze({
  agents: ['agents'],
  attachments: ['attachments'],
  collaboration: ['collaboration'],
  core: ['channels', 'knowledge', 'media', 'skills'],
  runs: ['runs'],
  security: ['security', 'shell'],
  workspace: ['workspace', 'gates'],
})

function collectTestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectTestFiles(filename)
    return entry.isFile() && entry.name.endsWith('.test.cjs') ? [filename] : []
  })
}

function normalizeSuite(suite) {
  const value = String(suite || 'all').trim().toLowerCase()
  if (value === 'all') return null
  if (!Object.hasOwn(TEST_SUITES, value)) {
    throw new Error(`Unknown desktop test suite: ${value}`)
  }
  return new Set(TEST_SUITES[value])
}

function testSuiteForFile(filename, directory = 'test') {
  const relative = path.relative(path.resolve(directory), filename)
  return relative.split(path.sep)[0] || 'core'
}

function discoverTestFiles({ directory = 'test', suite = 'all' } = {}) {
  const selectedRoots = normalizeSuite(suite)
  return collectTestFiles(path.resolve(directory))
    .filter((filename) => !selectedRoots || selectedRoots.has(testSuiteForFile(filename, directory)))
    .sort()
}

module.exports = { TEST_SUITES, discoverTestFiles, normalizeSuite, testSuiteForFile }
