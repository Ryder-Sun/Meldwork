const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAX_SKILLS = 1000
const DISPLAY_LIMIT = MAX_SKILLS
const MAX_DIRECTORIES = 5000
const MAX_DEPTH = 8
const MAX_PLUGIN_CACHE_DEPTH = 6
const MAX_PLUGIN_ROOTS = 500
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_SKILL_HEADER_BYTES = 64 * 1024
const MAX_SELECTIONS = 4
const DEFAULT_CACHE_TTL_MS = 5000

const AGENT_SKILL_ROOTS = Object.freeze({
  codex: [
    ['.codex', 'skills'],
    ['.agents', 'skills'],
  ],
  hermes: [['.hermes', 'skills']],
  openclaw: [
    ['.openclaw', 'workspace', 'skills'],
    ['.openclaw', 'skills'],
  ],
  workbuddy: [['.workbuddy', 'skills']],
  kimi: [
    ['.kimi-code', 'skills'],
    ['.kimi', 'skills'],
  ],
  deepseek: [
    ['.dsh', 'skills'],
    ['.agents', 'skills'],
  ],
  claude: [
    ['.claude', 'skills'],
    ['.agents', 'skills'],
  ],
  qwen: [['.qwen', 'skills']],
  gemini: [['.gemini', 'skills']],
  opencode: [
    ['.config', 'opencode', 'skills'],
    ['.config', 'opencode', 'skill'],
  ],
})

const SUPPORTED_KINDS = new Set(Object.keys(AGENT_SKILL_ROOTS))
const SIMPLE_IDENTIFIER = /^[a-zA-Z0-9._-]+$/

function skillError(code) {
  return Object.assign(new Error(code), { code })
}

function selectionKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',')
    : ''
}

function realpath(directory) {
  return fs.realpathSync.native ? fs.realpathSync.native(directory) : fs.realpathSync(directory)
}

function isInsideOrEqual(root, candidate) {
  if (candidate === root) return true
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative))
}

function readJson(filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function readPrefix(filename) {
  let descriptor
  try {
    descriptor = fs.openSync(filename, 'r')
    const size = Math.min(fs.fstatSync(descriptor).size, MAX_SKILL_HEADER_BYTES)
    const buffer = Buffer.alloc(size)
    const bytesRead = fs.readSync(descriptor, buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
    }
  }
}

function frontmatterName(contents) {
  const lines = String(contents || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return ''
  let raw = ''
  let closed = false
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^(---|\.\.\.)\s*$/.test(line.trim())) {
      closed = true
      break
    }
    const match = line.match(/^\s*name\s*:\s*(.*?)\s*$/i)
    if (match) raw = match[1]
  }
  if (!closed || !raw || raw === '|' || raw === '>') return ''
  if (raw.startsWith('"') || raw.endsWith('"')) {
    if (!raw.startsWith('"') || !raw.endsWith('"')) return ''
    try { return JSON.parse(raw) } catch { return '' }
  }
  if (raw.startsWith("'") || raw.endsWith("'")) {
    if (!raw.startsWith("'") || !raw.endsWith("'")) return ''
    return raw.slice(1, -1).replaceAll("''", "'")
  }
  return raw.replace(/\s+#.*$/, '').trim()
}

function safeSegment(value, fallback = '') {
  const segment = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
  return segment || fallback
}

function safeDisplayName(value, fallback) {
  const raw = String(value || '').trim()
  const source = !raw || path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) ? fallback : raw
  const clean = String(source || '')
    .normalize('NFKC')
    .replace(/[\\/\u2215\u2044]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>\[\]`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return clean || 'skill'
}

function sourceNamespace(prefix, parts) {
  const segments = parts.slice(0, 2).map(part => safeSegment(part)).filter(Boolean)
  return segments.length ? `${prefix}.${segments.join('.')}` : prefix
}

function directoryEntryKind(entry, filename) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return ''
  try {
    const stat = fs.statSync(filename)
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
  } catch { /* broken or unreadable link */ }
  return ''
}

function globalRoots(kind, home, configDirectory = '') {
  return (AGENT_SKILL_ROOTS[kind] || []).map(parts => {
    const directory = configDirectory && ['codex', 'hermes', 'claude'].includes(kind) && parts[0] === `.${kind}`
      ? path.join(configDirectory, ...parts.slice(1)) : path.join(home, ...parts)
    return { directory, boundary: directory, namespace: 'global' }
  })
}

function safePluginRoot(installLocation, ...parts) {
  const base = path.resolve(installLocation)
  const candidate = path.resolve(base, ...parts)
  const relative = path.relative(base, candidate)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) return ''
  return candidate
}

function workBuddyPluginRoots(home) {
  const workBuddy = path.join(home, '.workbuddy')
  const settings = readJson(path.join(workBuddy, 'settings.json'))
  const marketplaces = readJson(path.join(workBuddy, 'plugins', 'known_marketplaces.json'))
  const enabled = settings?.enabledPlugins
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled) || !marketplaces) return []

  const roots = []
  for (const identifier of Object.keys(enabled).sort()) {
    if (enabled[identifier] !== true) continue
    const separator = identifier.lastIndexOf('@')
    if (separator <= 0) continue
    const pluginName = identifier.slice(0, separator)
    const marketplaceName = identifier.slice(separator + 1)
    if (!SIMPLE_IDENTIFIER.test(pluginName) || !SIMPLE_IDENTIFIER.test(marketplaceName)
        || pluginName === '.' || pluginName === '..'
        || marketplaceName === '.' || marketplaceName === '..') continue
    const installLocation = marketplaces[marketplaceName]?.installLocation
    if (typeof installLocation !== 'string' || !path.isAbsolute(installLocation)) continue
    const directRoot = safePluginRoot(installLocation, pluginName)
    const nestedRoot = safePluginRoot(installLocation, 'plugins', pluginName)
    if (!directRoot || !nestedRoot) continue
    const namespace = sourceNamespace('marketplace', [marketplaceName, pluginName])
    roots.push(
      { directory: directRoot, boundary: installLocation, namespace },
      { directory: nestedRoot, boundary: installLocation, namespace },
    )
  }
  return roots
}

function codexPluginRoots(home, configDirectory = '') {
  const cacheRoot = path.join(configDirectory || path.join(home, '.codex'), 'plugins', 'cache')
  const roots = []
  const visited = new Set()
  let directoryCount = 0
  let boundary

  try { boundary = realpath(cacheRoot) } catch { return [] }

  function visit(directory, depth, relativeParts) {
    if (depth > MAX_PLUGIN_CACHE_DEPTH || directoryCount >= MAX_DIRECTORIES
        || roots.length >= MAX_PLUGIN_ROOTS) return
    let resolved
    let entries
    try {
      resolved = realpath(directory)
      if (!isInsideOrEqual(boundary, resolved) || visited.has(resolved)) return
      visited.add(resolved)
      directoryCount += 1
      entries = fs.readdirSync(resolved, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    for (const entry of entries) {
      if (roots.length >= MAX_PLUGIN_ROOTS) break
      if (entry.name.startsWith('.')) continue
      const filename = path.join(resolved, entry.name)
      if (directoryEntryKind(entry, filename) !== 'directory') continue
      if (entry.name.toLowerCase() === 'skills') {
        roots.push({
          directory: filename,
          boundary: cacheRoot,
          namespace: sourceNamespace('plugin', relativeParts),
        })
      } else {
        visit(filename, depth + 1, [...relativeParts, entry.name])
      }
    }
  }

  visit(cacheRoot, 0, [])
  return roots.sort((left, right) => (
    left.namespace.localeCompare(right.namespace)
      || right.directory.localeCompare(left.directory, undefined, { numeric: true })
  ))
}

function skillRoots(kind, home, configDirectory = '') {
  const roots = globalRoots(kind, home, configDirectory)
  if (kind === 'codex') roots.push(...codexPluginRoots(home, configDirectory))
  if (kind === 'workbuddy') roots.push(...workBuddyPluginRoots(home))
  return roots
}

function collectSkills(targetKind, roots) {
  const skills = new Map()
  const visited = new Set()
  let directoryCount = 0

  function visit(directory, boundary, namespace, depth) {
    if (depth > MAX_DEPTH || directoryCount >= MAX_DIRECTORIES || skills.size >= MAX_SKILLS) return
    let resolved
    let entries
    try {
      resolved = realpath(directory)
      if (!isInsideOrEqual(boundary, resolved) || visited.has(resolved)) return
      visited.add(resolved)
      directoryCount += 1
      entries = fs.readdirSync(resolved, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
    const skillEntry = entries.find((entry) => {
      if (entry.name.toLowerCase() !== 'skill.md') return false
      return directoryEntryKind(entry, path.join(resolved, entry.name)) === 'file'
    })
    if (skillEntry) {
      const directoryName = path.basename(resolved)
      const slug = safeSegment(directoryName)
      if (slug) {
        const name = safeDisplayName(
          frontmatterName(readPrefix(path.join(resolved, skillEntry.name))),
          directoryName,
        )
        const key = `${namespace}\u0000${slug}`
        if (!skills.has(key)) {
          skills.set(key, { targetKind, namespace, slug, name, sourceDirectory: resolved })
        }
      }
      return
    }

    for (const entry of entries) {
      if (skills.size >= MAX_SKILLS) break
      if (entry.name.startsWith('.')) continue
      const filename = path.join(resolved, entry.name)
      if (directoryEntryKind(entry, filename) === 'directory') {
        visit(filename, boundary, namespace, depth + 1)
      }
    }
  }

  for (const root of roots) {
    if (skills.size >= MAX_SKILLS || directoryCount >= MAX_DIRECTORIES) break
    let boundary
    try { boundary = realpath(root.boundary || root.directory) } catch { continue }
    visit(root.directory, boundary, root.namespace, 0)
  }
  return [...skills.values()]
}

function compareSkills(left, right) {
  const leftSource = left.namespace === 'global' ? 0 : 1
  const rightSource = right.namespace === 'global' ? 0 : 1
  return leftSource - rightSource
    || left.namespace.localeCompare(right.namespace)
    || left.name.localeCompare(right.name, undefined, { numeric: true })
    || left.slug.localeCompare(right.slug, undefined, { numeric: true })
}

function publicSkill(skill) {
  return {
    targetKind: skill.targetKind,
    namespace: skill.namespace,
    slug: skill.slug,
    name: skill.name,
  }
}

function copyResult(result) {
  return {
    ...result,
    skills: result.skills.map(publicSkill),
  }
}

class LocalSkillCatalog {
  constructor({ home = os.homedir(), now = Date.now, cacheTtlMs = DEFAULT_CACHE_TTL_MS, configDirectoryForKind = () => '' } = {}) {
    this.home = path.resolve(String(home || os.homedir()))
    this.now = now
    this.cacheTtlMs = cacheTtlMs
    this.configDirectoryForKind = configDirectoryForKind
    this.cache = new Map()
  }

  load(kind) {
    const targetKind = String(kind || '').trim().toLowerCase()
    if (!SUPPORTED_KINDS.has(targetKind)) {
      return { supported: false, total: 0, limit: DISPLAY_LIMIT, skills: [] }
    }
    const now = this.now()
    const cached = this.cache.get(targetKind)
    if (cached && now < cached.expiresAt) return cached.result

    const configDirectory = this.configDirectoryForKind(targetKind)
    const skills = collectSkills(targetKind, skillRoots(targetKind, this.home, configDirectory)).sort(compareSkills)
    const result = {
      supported: true,
      total: skills.length,
      limit: DISPLAY_LIMIT,
      skills: skills.slice(0, DISPLAY_LIMIT),
    }
    this.cache.set(targetKind, { expiresAt: now + this.cacheTtlMs, result })
    return result
  }

  list(kind) {
    return copyResult(this.load(kind))
  }

  invalidate(kind) {
    const targetKind = String(kind || '').trim().toLowerCase()
    if (targetKind) this.cache.delete(targetKind)
    else this.cache.clear()
  }

  validateSelections(kind, selections) {
    if (!Array.isArray(selections)) throw skillError('LOCAL_SKILL_SELECTION_INVALID')
    if (selections.length > MAX_SELECTIONS) throw skillError('LOCAL_SKILL_LIMIT')
    if (!selections.length) return []

    const targetKind = String(kind || '').trim().toLowerCase()
    this.invalidate(targetKind)
    const available = new Map(this.load(targetKind).skills.map(skill => (
      [`${skill.namespace}\u0000${skill.slug}`, skill]
    )))
    const validated = []
    const seen = new Set()
    for (const selection of selections) {
      if (selectionKeys(selection) !== 'name,namespace,slug,targetKind') {
        throw skillError('LOCAL_SKILL_SELECTION_INVALID')
      }
      const coordinate = `${selection.namespace}\u0000${selection.slug}`
      const skill = available.get(coordinate)
      if (!skill || selection.targetKind !== targetKind
          || selection.namespace !== skill.namespace || selection.slug !== skill.slug
          || selection.name !== skill.name) {
        throw skillError('LOCAL_SKILL_SELECTION_INVALID')
      }
      if (seen.has(coordinate)) continue
      seen.add(coordinate)
      validated.push(publicSkill(skill))
    }
    return validated
  }

  resolveSelections(kind, selections) {
    const validated = this.validateSelections(kind, selections)
    if (!validated.length) return []
    const targetKind = String(kind || '').trim().toLowerCase()
    const available = new Map(this.load(targetKind).skills.map(skill => (
      [`${skill.namespace}\u0000${skill.slug}`, skill]
    )))
    return validated.map((skill) => {
      const resolved = available.get(`${skill.namespace}\u0000${skill.slug}`)
      if (!resolved?.sourceDirectory) throw skillError('LOCAL_SKILL_SELECTION_INVALID')
      return { ...skill, sourceDirectory: resolved.sourceDirectory }
    })
  }
}

function listLocalAgentSkills(kind, options = {}) {
  return new LocalSkillCatalog(options).list(kind)
}

module.exports = {
  DISPLAY_LIMIT,
  LocalSkillCatalog,
  MAX_DIRECTORIES,
  MAX_SKILLS,
  listLocalAgentSkills,
}
