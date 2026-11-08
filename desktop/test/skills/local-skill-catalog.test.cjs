const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  DISPLAY_LIMIT,
  LocalSkillCatalog,
  MAX_SKILLS,
  listLocalAgentSkills,
} = require('../../src/skills/local-skill-catalog.cjs')

function fixture(t, prefix = 'meldwork-skills-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

function writeSkill(root, directoryName, contents = '') {
  const directory = path.join(root, directoryName)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'SKILL.md'), contents || `# ${directoryName}\n`)
  return directory
}

test('supported Agent scans stay isolated and return targetKind-safe global metadata', (t) => {
  const home = fixture(t)
  const roots = {
    codex: ['.codex', 'skills'],
    hermes: ['.hermes', 'skills'],
    openclaw: ['.openclaw', 'workspace', 'skills'],
    workbuddy: ['.workbuddy', 'skills'],
    kimi: ['.kimi-code', 'skills'],
    claude: ['.claude', 'skills'],
    qwen: ['.qwen', 'skills'],
    gemini: ['.gemini', 'skills'],
    opencode: ['.config', 'opencode', 'skills'],
  }
  for (const [kind, parts] of Object.entries(roots)) {
    writeSkill(path.join(home, ...parts), `${kind}-skill`)
  }

  for (const kind of Object.keys(roots)) {
    const result = listLocalAgentSkills(kind, { home })
    assert.equal(result.supported, true)
    assert.equal(result.total, 1)
    assert.deepEqual(result.skills, [{
      targetKind: kind,
      namespace: 'global',
      slug: `${kind}-skill`,
      name: `${kind}-skill`,
    }])
  }
  assert.deepEqual(listLocalAgentSkills('unknown', { home }), {
    supported: false, total: 0, limit: DISPLAY_LIMIT, skills: [],
  })
  assert.equal(JSON.stringify(listLocalAgentSkills('codex', { home })).includes(home), false)
})

test('frontmatter names are optional, sanitized, bounded, and deduplicated by coordinate', (t) => {
  const home = fixture(t)
  writeSkill(path.join(home, '.codex', 'skills'), 'My Skill', [
    '---',
    'name: "Research [Planner]"',
    'description: must not be returned',
    '---',
    'PRIVATE BODY CONTENT',
  ].join('\n'))
  writeSkill(path.join(home, '.agents', 'skills'), 'My Skill', [
    '---',
    'name: Duplicate Name',
    '---',
  ].join('\n'))
  writeSkill(path.join(home, '.codex', 'skills'), 'Unsafe `Skill`', [
    '---',
    `name: ${home}/must-not-leak`,
    '---',
  ].join('\n'))
  writeSkill(path.join(home, '.codex', 'skills'), 'Fallback Name', '---\nname: "unterminated\n---\n')

  const result = listLocalAgentSkills('codex', { home })

  assert.equal(result.total, 3)
  assert.deepEqual(result.skills.find(skill => skill.slug === 'my-skill'), {
    targetKind: 'codex', namespace: 'global', slug: 'my-skill', name: 'Research Planner',
  })
  assert.equal(result.skills.find(skill => skill.slug === 'unsafe-skill').name, 'Unsafe Skill')
  assert.equal(result.skills.find(skill => skill.slug === 'fallback-name').name, 'Fallback Name')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(home), false)
  assert.equal(serialized.includes('PRIVATE BODY CONTENT'), false)
  assert.equal(serialized.includes('must not be returned'), false)
  for (const skill of result.skills) {
    assert.deepEqual(Object.keys(skill).sort(), ['name', 'namespace', 'slug', 'targetKind'])
    assert.ok(skill.name.length <= 100)
  }
})

test('selection validation accepts only current skills for the requested Agent', (t) => {
  const home = fixture(t)
  writeSkill(path.join(home, '.codex', 'skills'), 'review', '---\nname: Review code\n---\n')
  writeSkill(path.join(home, '.hermes', 'skills'), 'research', '---\nname: Research\n---\n')
  const catalog = new LocalSkillCatalog({ home })
  const review = catalog.list('codex').skills[0]

  assert.deepEqual(catalog.validateSelections('codex', [review, review]), [review])
  assert.throws(
    () => catalog.validateSelections('hermes', [review]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID', code: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.throws(
    () => catalog.validateSelections('codex', [{ ...review, name: 'Forged name' }]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID', code: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
  assert.throws(
    () => catalog.validateSelections('codex', Array.from({ length: 5 }, () => review)),
    { message: 'LOCAL_SKILL_LIMIT', code: 'LOCAL_SKILL_LIMIT' },
  )
  fs.rmSync(path.join(home, '.codex', 'skills', 'review'), { recursive: true })
  assert.throws(
    () => catalog.validateSelections('codex', [review]),
    { message: 'LOCAL_SKILL_SELECTION_INVALID', code: 'LOCAL_SKILL_SELECTION_INVALID' },
  )
})

test('main-only selection resolution returns the current source without leaking it from list', (t) => {
  const home = fixture(t)
  const sourceDirectory = writeSkill(
    path.join(home, '.codex', 'skills'),
    'review',
    '---\nname: Review code\n---\n',
  )
  const catalog = new LocalSkillCatalog({ home })
  const selection = catalog.list('codex').skills[0]

  assert.equal(JSON.stringify(catalog.list('codex')).includes(sourceDirectory), false)
  assert.deepEqual(catalog.resolveSelections('codex', [selection]), [{
    ...selection,
    sourceDirectory: fs.realpathSync(sourceDirectory),
  }])
})

test('catalog caches each Agent scan until TTL expiry without exposing cached objects', (t) => {
  const home = fixture(t)
  const root = path.join(home, '.codex', 'skills')
  let currentTime = 1000
  writeSkill(root, 'review')
  const catalog = new LocalSkillCatalog({
    home,
    now: () => currentTime,
    cacheTtlMs: 100,
  })

  const first = catalog.list('codex')
  first.total = 99
  first.skills[0].name = 'Mutated name'
  first.skills.push({ targetKind: 'codex', namespace: 'global', slug: 'forged', name: 'Forged' })
  writeSkill(root, 'research')

  currentTime = 1099
  const cached = catalog.list('codex')
  assert.notStrictEqual(cached, first)
  assert.notStrictEqual(cached.skills[0], first.skills[0])
  assert.deepEqual(cached, {
    supported: true,
    total: 1,
    limit: DISPLAY_LIMIT,
    skills: [{ targetKind: 'codex', namespace: 'global', slug: 'review', name: 'review' }],
  })

  currentTime = 1100
  const refreshed = catalog.list('codex')
  assert.equal(refreshed.total, 2)
  assert.deepEqual(refreshed.skills.map(skill => skill.slug), ['research', 'review'])
})

test('catalog invalidation refreshes one Agent or all cached Agent scans', (t) => {
  const home = fixture(t)
  const codexRoot = path.join(home, '.codex', 'skills')
  const hermesRoot = path.join(home, '.hermes', 'skills')
  writeSkill(codexRoot, 'review')
  writeSkill(hermesRoot, 'research')
  const catalog = new LocalSkillCatalog({ home, cacheTtlMs: 60_000 })

  assert.equal(catalog.list('codex').total, 1)
  assert.equal(catalog.list('hermes').total, 1)
  writeSkill(codexRoot, 'planning')
  writeSkill(hermesRoot, 'writing')

  catalog.invalidate('CODEX')
  assert.equal(catalog.list('codex').total, 2)
  assert.equal(catalog.list('hermes').total, 1)

  catalog.invalidate()
  assert.equal(catalog.list('hermes').total, 2)
})

test('Codex cache and enabled WorkBuddy plugins use stable source namespaces', (t) => {
  const home = fixture(t)
  writeSkill(
    path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'reviewer', '1.9.0', 'skills'),
    'deep-review',
    '---\nname: Old Reviewer\n---\n',
  )
  writeSkill(
    path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'reviewer', '2.0.0', 'skills'),
    'deep-review',
    '---\nname: Current Reviewer\n---\n',
  )

  const workBuddy = path.join(home, '.workbuddy')
  const marketplace = path.join(home, 'workbuddy-marketplace')
  fs.mkdirSync(path.join(workBuddy, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(workBuddy, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'docs@builtin': true, 'disabled@builtin': false },
  }))
  fs.writeFileSync(path.join(workBuddy, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    builtin: { installLocation: marketplace },
  }))
  writeSkill(path.join(marketplace, 'docs', 'skills'), 'document-tools', '---\nname: Document Tools\n---\n')
  writeSkill(path.join(marketplace, 'disabled', 'skills'), 'disabled-skill')

  const codex = listLocalAgentSkills('codex', { home })
  const workbuddy = listLocalAgentSkills('workbuddy', { home })

  assert.deepEqual(codex.skills, [{
    targetKind: 'codex',
    namespace: 'plugin.vendor.reviewer',
    slug: 'deep-review',
    name: 'Current Reviewer',
  }])
  assert.deepEqual(workbuddy.skills, [{
    targetKind: 'workbuddy',
    namespace: 'marketplace.builtin.docs',
    slug: 'document-tools',
    name: 'Document Tools',
  }])
  assert.equal(JSON.stringify(workbuddy).includes(marketplace), false)
  assert.equal(JSON.stringify(workbuddy).includes('disabled-skill'), false)
})

test('WorkBuddy dot plugin identifiers cannot scan outside their install roots', (t) => {
  const home = fixture(t)
  const workBuddy = path.join(home, '.workbuddy')
  const marketplace = path.join(home, 'marketplaces', 'installed')
  fs.mkdirSync(path.join(workBuddy, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(workBuddy, 'settings.json'), JSON.stringify({
    enabledPlugins: { '.@builtin': true, '..@builtin': true },
  }))
  fs.writeFileSync(path.join(workBuddy, 'plugins', 'known_marketplaces.json'), JSON.stringify({
    builtin: { installLocation: marketplace },
  }))
  writeSkill(marketplace, 'unrelated-inside-install-root')
  writeSkill(path.dirname(marketplace), 'private-sibling')

  assert.deepEqual(listLocalAgentSkills('workbuddy', { home }), {
    supported: true, total: 0, limit: DISPLAY_LIMIT, skills: [],
  })
})

test('large catalogs return and validate skills after the first 100 within the scan limit', (t) => {
  const home = fixture(t)
  const root = path.join(home, '.hermes', 'skills')
  for (let index = 0; index < MAX_SKILLS + 5; index += 1) {
    writeSkill(root, `skill-${String(index).padStart(4, '0')}`)
  }

  const catalog = new LocalSkillCatalog({ home })
  const result = catalog.list('hermes')

  assert.equal(result.total, MAX_SKILLS)
  assert.equal(result.limit, MAX_SKILLS)
  assert.equal(result.skills.length, MAX_SKILLS)
  assert.equal(result.skills[0].slug, 'skill-0000')
  assert.equal(result.skills[100].slug, 'skill-0100')
  assert.equal(result.skills.at(-1).slug, `skill-${String(MAX_SKILLS - 1).padStart(4, '0')}`)
  assert.deepEqual(
    catalog.validateSelections('hermes', [result.skills[100]]),
    [result.skills[100]],
  )
})

test('symbolic-link cycles, aliases, and broken links do not duplicate or stall scans', (t) => {
  const home = fixture(t)
  const root = path.join(home, '.openclaw', 'skills')
  const skill = writeSkill(root, 'cycle-safe')
  try {
    fs.symlinkSync(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(skill, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'broken'))
  } catch (error) {
    t.skip(`symbolic links unavailable: ${error.code || error.message}`)
    return
  }

  const result = listLocalAgentSkills('openclaw', { home })

  assert.equal(result.total, 1)
  assert.deepEqual(result.skills, [{
    targetKind: 'openclaw', namespace: 'global', slug: 'cycle-safe', name: 'cycle-safe',
  }])
})

test('catalog links cannot escape approved global or plugin roots', (t) => {
  const home = fixture(t)
  const globalRoot = path.join(home, '.codex', 'skills')
  const pluginCache = path.join(home, '.codex', 'plugins', 'cache')
  const outsideGlobal = writeSkill(path.join(home, 'private-global'), 'escaped-global')
  const outsidePlugin = path.join(home, 'private-plugin')
  writeSkill(path.join(outsidePlugin, 'skills'), 'escaped-plugin')
  writeSkill(globalRoot, 'inside')
  fs.mkdirSync(pluginCache, { recursive: true })
  try {
    fs.symlinkSync(
      outsideGlobal,
      path.join(globalRoot, 'escaped'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    fs.symlinkSync(
      outsidePlugin,
      path.join(pluginCache, 'escaped-plugin'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    t.skip(`symbolic links unavailable: ${error.code || error.message}`)
    return
  }

  const result = listLocalAgentSkills('codex', { home })

  assert.deepEqual(result.skills, [{
    targetKind: 'codex', namespace: 'global', slug: 'inside', name: 'inside',
  }])
})

test('dsh reads its skill root and skips symlinks leaving the root', (t) => {
  const home = fixture(t)
  const real = writeSkill(path.join(home, '.dsh', 'skills'), 'real-skill')
  const outside = writeSkill(path.join(home, 'outside'), 'outside-skill')
  const dshSkills = path.join(home, '.dsh', 'skills')
  fs.symlinkSync(real, path.join(dshSkills, 'real-skill-link'))
  fs.symlinkSync(outside, path.join(dshSkills, 'outside-skill'))

  const result = listLocalAgentSkills('dsh', { home })
  assert.equal(result.supported, true)
  // A symlinked skill inside the root resolves normally; a link pointing
  // outside the root is skipped by the traversal boundary.
  assert.deepEqual(result.skills.map(skill => skill.slug), ['real-skill'])
})
