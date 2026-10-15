const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { DISPLAY_LIMIT, listLocalAgentSkills } = require('../../skills/local-skill-catalog.cjs')
const {
  installedVersionCurrent,
  AGENT_CATALOG,
  DETECTION_CACHE_TTL_MS,
  abortError,
  abortable,
  defaultFindCommand,
  defaultVerifyNpmIntegrity,
  defaultVerifyScriptIntegrity,
  installRecipe,
  installerError,
  npmPackageSpec,
  prepareInstallCommand,
  publicState,
  validateInstallCommand,
  validateScriptUrl,
  verifiedAgent,
  verifiedRecipeAgent,
} = require('./agent-installer-contract.cjs')
const {
  defaultDownloadScript,
  defaultRemoveDownload,
  defaultRunProcess,
} = require('./agent-installer-runtime.cjs')

const NPM_REGISTRY = 'https://registry.npmjs.org/'
const COMPATIBILITY_REASONS = new Set([
  'LOCAL_AGENT_VERSION_UNSUPPORTED',
  'LOCAL_AGENT_REQUIRED_CAPABILITY_MISSING',
  'LOCAL_AGENT_PROTOCOL_UNAVAILABLE',
])

function publicCompatibility(agent) {
  if (!agent) {
    return {
      resolvedVersion: '',
      versionIdentified: false,
      compatible: false,
      supportedVersionRange: '',
      compatibilityState: 'unknown',
      incompatibilityReason: '',
      incompatibilityProbe: '',
    }
  }
  const compatibilityState = ['compatible', 'incompatible'].includes(agent.compatibilityState)
    ? agent.compatibilityState
    : 'unknown'
  const resolvedVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
    .test(String(agent.resolvedVersion || ''))
    ? agent.resolvedVersion
    : ''
  const supportedVersionRange = /^[0-9A-Za-z.+-]{1,161}$/
    .test(String(agent.supportedVersionRange || ''))
    ? agent.supportedVersionRange
    : ''
  const versionIdentified = typeof agent.versionIdentified === 'boolean'
    ? agent.versionIdentified
    : Boolean(resolvedVersion)
  const compatible = compatibilityState === 'compatible'
  const incompatibilityReason = compatibilityState === 'unknown'
      && agent.incompatibilityReason === 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT'
    ? 'LOCAL_AGENT_CAPABILITY_PROBE_TIMEOUT'
    : compatibilityState === 'incompatible'
    ? (COMPATIBILITY_REASONS.has(agent.incompatibilityReason)
        ? agent.incompatibilityReason
        : 'LOCAL_AGENT_VERSION_UNSUPPORTED')
    : ''
  const incompatibilityProbe = Boolean(incompatibilityReason)
    && /^[a-z0-9-]{1,80}$/.test(String(agent.incompatibilityProbe || ''))
    ? agent.incompatibilityProbe
    : ''
  return {
    resolvedVersion,
    versionIdentified,
    compatible,
    supportedVersionRange,
    compatibilityState,
    incompatibilityReason,
    incompatibilityProbe,
  }
}

class AgentInstaller extends EventEmitter {
  constructor({
    platform = process.platform,
    detectAgents,
    findCommand = command => defaultFindCommand(command, platform),
    downloadScript = defaultDownloadScript,
    removeDownload = defaultRemoveDownload,
    runProcess = defaultRunProcess,
    verifyNpmIntegrity = defaultVerifyNpmIntegrity,
    verifyScriptIntegrity = defaultVerifyScriptIntegrity,
    readCommandFile = filename => fs.readFileSync(filename, 'utf8'),
    commandPathExists = fs.existsSync,
    listSkills = listLocalAgentSkills,
    createId = randomUUID,
    now = Date.now,
  }) {
    super()
    this.platform = platform
    this.detectAgents = detectAgents
    this.findCommand = findCommand
    this.downloadScript = downloadScript
    this.removeDownload = removeDownload
    this.runProcess = runProcess
    this.verifyNpmIntegrity = verifyNpmIntegrity
    this.verifyScriptIntegrity = verifyScriptIntegrity
    this.readCommandFile = readCommandFile
    this.commandPathExists = commandPathExists
    this.listSkills = listSkills
    this.createId = createId
    this.now = now
    this.current = publicState({})
    this.controller = null
    this.starting = null
    this.running = null
    this.detectionCache = null
    this.detectionCacheExpiresAt = 0
    this.detectionGeneration = 0
    this.detectionTask = null
  }

  state() {
    return publicState(this.current)
  }

  setState(next) {
    this.current = publicState({ ...this.current, ...next })
    this.emit('changed', this.state())
  }

  invalidateDetectionCache() {
    this.detectionGeneration += 1
    this.detectionCache = null
    this.detectionCacheExpiresAt = 0
    this.detectionTask = null
  }

  detectedAgents() {
    if (this.detectionCache && this.now() < this.detectionCacheExpiresAt) {
      return Promise.resolve(this.detectionCache)
    }
    if (this.detectionTask) return this.detectionTask

    const generation = this.detectionGeneration
    const task = Promise.resolve().then(() => this.detectAgents()).then((agents) => {
      if (this.detectionGeneration !== generation) return this.detectedAgents()
      this.detectionCache = agents
      this.detectionCacheExpiresAt = this.now() + DETECTION_CACHE_TTL_MS
      return agents
    }).finally(() => {
      if (this.detectionTask === task) this.detectionTask = null
    })
    this.detectionTask = task
    return task
  }

  async catalog() {
    const installed = new Map((await this.detectedAgents())
      .filter(agent => agent?.kind).map(agent => [agent.kind, agent]))
    const npm = await this.findCommand(this.platform === 'win32' ? 'npm.cmd' : 'npm')
    return {
      platform: this.platform,
      agents: AGENT_CATALOG.map(profile => {
        const agent = installed.get(profile.kind)
        const recipe = installRecipe(profile.kind, this.platform)
        const targetVersion = recipe?.detectedVersion || recipe?.version || ''
        const currentVersion = String(agent?.version || '')
        const upToDate = Boolean(agent && targetVersion
          && installedVersionCurrent(currentVersion, targetVersion))
        let installSupported = Boolean(recipe)
        let installErrorCode = ''
        if (!recipe) {
          installSupported = false
          installErrorCode = 'INSTALL_AGENT_PLATFORM_UNSUPPORTED'
        } else if (recipe.type === 'npm' && !npm) {
          installSupported = false
          installErrorCode = 'INSTALL_AGENT_NODE_REQUIRED'
        }
        return {
          ...profile,
          installed: Boolean(agent),
          version: agent?.version || '',
          targetVersion,
          installAction: agent ? (upToDate ? 'current' : 'update') : 'install',
          ...publicCompatibility(agent),
          installSupported,
          installErrorCode,
        }
      }),
    }
  }

  async skills(kind) {
    const installed = await this.detectedAgents()
    if (!installed.some(agent => (
      agent.kind === kind
      && agent.compatibilityState === 'compatible'
      && verifiedAgent(agent)
    ))) {
      return { supported: false, skills: [], total: 0, limit: DISPLAY_LIMIT }
    }
    return this.listSkills(kind)
  }

  async start(kind) {
    if (this.starting || this.running) throw installerError('INSTALL_AGENT_BUSY')
    const profile = AGENT_CATALOG.find(agent => agent.kind === kind)
    if (!profile) throw installerError('INSTALL_AGENT_UNSUPPORTED')
    const recipe = installRecipe(kind, this.platform)
    if (!recipe) throw installerError('INSTALL_AGENT_PLATFORM_UNSUPPORTED')

    const previousState = this.state()
    const controller = new AbortController()
    const taskId = this.createId()
    const task = Promise.resolve()
      .then(() => this.prepareStart({ profile, recipe, signal: controller.signal }))
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          this.setState({ phase: 'cancelled', canCancel: false, errorCode: '' })
          return this.state()
        }
        this.setState(previousState)
        throw error
      })
    this.starting = { task, controller }
    this.controller = controller
    this.setState({ taskId, kind, phase: 'checking', canCancel: true, errorCode: '' })
    return task.finally(() => {
      if (this.starting?.task === task) this.starting = null
      if (!this.running && this.controller === controller) this.controller = null
    })
  }

  async prepareStart({ profile, recipe, signal }) {
    this.invalidateDetectionCache()
    const installed = await abortable(this.detectedAgents(), signal)
    if (signal.aborted) throw abortError()
    const current = installed.find(agent => agent.kind === profile.kind)
    const targetVersion = recipe.detectedVersion || recipe.version
    if (current && (current.compatibilityState !== 'compatible'
      || installedVersionCurrent(current.version, targetVersion))) {
      throw installerError('INSTALL_AGENT_ALREADY_INSTALLED')
    }
    let command = recipe.interpreter || ''
    if (recipe.type === 'npm') {
      command = await abortable(
        this.findCommand(this.platform === 'win32' ? 'npm.cmd' : 'npm'),
        signal,
      )
      if (signal.aborted) throw abortError()
      if (!command) throw installerError('INSTALL_AGENT_NODE_REQUIRED')
    }
    validateInstallCommand(command, recipe, this.platform)
    if (signal.aborted) throw abortError()
    this.running = this.runInstall({ profile, recipe, command, signal })
      .finally(() => {
        if (this.controller?.signal === signal) this.controller = null
        this.running = null
      })
    return this.state()
  }

  async runInstall({ profile, recipe, command, signal }) {
    let downloaded = ''
    try {
      let args
      if (recipe.type === 'script') {
        this.setState({ phase: 'downloading' })
        validateScriptUrl(recipe.url)
        try {
          downloaded = await this.downloadScript(recipe.url, signal)
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error
          if (['INSTALL_AGENT_DOWNLOAD_BLOCKED', 'INSTALL_AGENT_DOWNLOAD_FAILED']
            .includes(error?.code)) throw error
          throw installerError('INSTALL_AGENT_DOWNLOAD_FAILED')
        }
        try {
          await abortable(
            this.verifyScriptIntegrity(downloaded, recipe, { signal }),
            signal,
          )
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error
          if (error?.code === 'INSTALL_AGENT_INTEGRITY_FAILED') throw error
          throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
        }
        args = recipe.args.map(value => value === '$SCRIPT' ? downloaded : value)
      } else {
        try {
          await abortable(
            this.verifyNpmIntegrity(command, recipe, {
              signal,
              platform: this.platform,
              readFileFn: this.readCommandFile,
              existsFn: this.commandPathExists,
            }),
            signal,
          )
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error
          if (error?.code === 'INSTALL_AGENT_INTEGRITY_FAILED') throw error
          throw installerError('INSTALL_AGENT_INTEGRITY_FAILED')
        }
        args = [
          'install', '--global',
          ...(recipe.ignoreScripts ? ['--ignore-scripts'] : []),
          npmPackageSpec(recipe),
          '--registry', NPM_REGISTRY,
        ]
      }
      const prepared = recipe.type === 'npm'
        ? prepareInstallCommand(command, args, {
            platform: this.platform,
            readFileFn: this.readCommandFile,
            existsFn: this.commandPathExists,
          })
        : { command, args }
      this.setState({ phase: 'installing' })
      await this.runProcess(prepared.command, prepared.args, { signal, platform: this.platform })
      this.setState({ phase: 'verifying', canCancel: false })
      this.invalidateDetectionCache()
      const installed = await this.detectedAgents()
      if (!installed.some(agent => (
        agent.kind === profile.kind
        && agent.compatibilityState === 'compatible'
        && verifiedRecipeAgent(agent, recipe)
      ))) {
        throw installerError('INSTALL_AGENT_VERIFY_FAILED')
      }
      this.setState({ phase: 'completed', canCancel: false })
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') {
        this.setState({ phase: 'cancelled', canCancel: false, errorCode: '' })
      } else {
        this.setState({
          phase: 'failed',
          canCancel: false,
          errorCode: String(error?.code || '').startsWith('INSTALL_AGENT_')
            ? error.code
            : 'INSTALL_AGENT_FAILED',
        })
      }
    } finally {
      await this.removeDownload(downloaded).catch(() => {})
    }
  }

  cancel(taskId) {
    if ((!this.starting && !this.running)
      || !this.controller
      || !this.current.canCancel
      || taskId !== this.current.taskId) return false
    this.controller.abort()
    this.setState({ canCancel: false })
    return true
  }

  cancelPending() {
    if (!this.starting) return false
    return this.cancel(this.current.taskId)
  }

  async waitForIdle() {
    const starting = this.starting?.task
    if (starting) await starting
    if (this.running) await this.running
  }
}

module.exports = {
  AgentInstaller,
  defaultDownloadScript,
  defaultFindCommand,
  defaultRunProcess,
  installRecipe,
  prepareInstallCommand,
  validateScriptUrl,
}
