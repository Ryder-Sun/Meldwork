const {
  MAX_MESSAGE_ATTACHMENTS,
  abortableOperation,
  normalizeAttachmentMetadata,
} = require('./local-workspace-inputs.cjs')

// Absolute paths an Agent mentions in its reply. Quoted, backticked or
// Markdown-linked paths may contain spaces; bare paths end at whitespace.
function extractReportedOutputPaths(text) {
  if (typeof text !== 'string') return []
  const root = '\\/(?:Users|home|tmp|private\\/tmp|Volumes)\\/'
  const delimited = [...text.matchAll(new RegExp(`[\`"'(<](${root}[^\`"'<>\\n)]+)[\`"')>]`, 'g'))]
    .map(match => match[1])
  const bare = (text.match(new RegExp(`${root}[^\\s"'<>\`\\]\\[)]+`, 'g')) || [])
    .filter(value => !delimited.some(full => full !== value && full.startsWith(value)))
  return [...new Set([...delimited, ...bare].map(value => value.trim().replace(/[.,;:!?]+$/, '')))]
}

// Files a writable Agent turn leaves behind: a snapshot of the workspace is
// taken before the turn and compared afterwards to import generated media and
// to describe produced artifacts. Capturing is best effort; only a stop
// request is allowed to interrupt it.
class InvocationOutputs {
  constructor({ enabled, workdir, signal, agentKind, startedAt, deps }) {
    this.enabled = enabled === true
    this.workdir = workdir
    this.signal = signal
    this.agentKind = agentKind
    this.startedAt = startedAt
    this.deps = deps
    this.baseline = null
    this.artifactBaseline = null
    this.capturePromise = null
    this.artifactCapturePromise = null
    this.importPromise = null
    this.outcomePromise = null
  }

  // Promises that may still be running when the invocation is cut short.
  pending() {
    return [
      this.capturePromise,
      this.artifactCapturePromise,
      this.importPromise,
      this.outcomePromise,
    ].filter(Boolean)
  }

  async tolerate(operation) {
    try {
      return await abortableOperation(operation, this.signal)
    } catch (error) {
      if (this.signal.aborted) throw error
      return undefined
    }
  }

  async begin() {
    if (!this.enabled) return
    this.artifactCapturePromise = Promise.resolve().then(
      () => this.deps.captureArtifactOutputs(this.workdir, { signal: this.signal }),
    )
    this.artifactCapturePromise.catch(() => {})
    try {
      this.capturePromise = Promise.resolve().then(
        () => this.deps.captureAgentOutputs(this.workdir, { signal: this.signal }),
      )
      this.capturePromise.catch(() => {})
      this.baseline = await abortableOperation(() => this.capturePromise, this.signal)
    } catch (error) {
      if (this.signal.aborted) throw error
    }
    this.artifactBaseline = (await this.tolerate(() => this.artifactCapturePromise)) ?? null
  }

  // Media the Agent produced during this turn, as message attachments.
  async importMedia(replyText) {
    if (!this.enabled) return []
    this.importPromise = Promise.resolve().then(() => this.deps.importAgentOutputs({
      workdir: this.workdir,
      baseline: this.baseline,
      startedAt: this.startedAt,
      agentKind: this.agentKind,
      reportedPaths: extractReportedOutputPaths(replyText),
      signal: this.signal,
    }))
    this.importPromise.catch(() => {})
    const imported = await this.tolerate(() => this.importPromise)
    return (Array.isArray(imported) ? imported : [])
      .slice(0, MAX_MESSAGE_ATTACHMENTS)
      .map(normalizeAttachmentMetadata)
      .filter(Boolean)
  }

  // Descriptors of the artifacts the Agent wrote, for the evidence record.
  async describeOutcomes({ runId, agentRunId }) {
    if (!this.enabled || !this.artifactBaseline) return []
    this.outcomePromise = Promise.resolve().then(() => this.deps.captureAgentOutcomeDescriptors({
      workdir: this.workdir,
      baseline: this.artifactBaseline,
      startedAt: this.startedAt,
      agentKind: this.agentKind,
      runId,
      agentRunId,
      signal: this.signal,
    }))
    this.outcomePromise.catch(() => {})
    const captured = await this.tolerate(() => this.outcomePromise)
    return Array.isArray(captured) ? captured : []
  }
}

module.exports = { InvocationOutputs, extractReportedOutputPaths }
