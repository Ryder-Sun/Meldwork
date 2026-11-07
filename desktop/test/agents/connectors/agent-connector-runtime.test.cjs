const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createAgentConnectorManifest } = require('../../../src/agents/connectors/agent-connector-manifest.cjs')
const { AgentConnectorRegistry } = require('../../../src/agents/connectors/agent-connector-registry.cjs')
const { AgentConnectorRuntime } = require('../../../src/agents/connectors/agent-connector-runtime.cjs')
const { recordReplyUsage } = require('../../../src/workspace/invocation-budget.cjs')

function manifestInput(overrides = {}) {
  return {
    connectorId: 'external.review-agent',
    connectorVersion: '1.0.0',
    kind: 'agent',
    label: 'External Review Agent',
    description: 'External structured review sample.',
    transport: { type: 'http', protocol: 'event-stream' },
    upstream: { id: 'review-service', minVersion: '3.0.0', maxVersion: '3.4.0' },
    invocation: { recipeId: 'external.review-agent.run' },
    domains: ['software-review'],
    session: { supported: true, resume: true, cancel: true, checkpoint: true },
    inputTypes: ['text', 'file'],
    permissionModes: ['read-only'],
    eventProtocolVersion: 1,
    eventTypes: [
      'Permission', 'SourceUsed', 'Artifact', 'Evidence', 'Usage',
      'WaitingInput', 'Completed', 'Failed', 'Cancelled',
    ],
    usage: {
      inputTokens: true,
      outputTokens: true,
      costMicros: true,
      toolCalls: true,
      outboundBytes: true,
      elapsedMs: true,
    },
    outboundDestinations: ['https://review.example.com'],
    credentials: {
      mode: 'credential-ref',
      slots: [{ slotId: 'account', type: 'oauth', required: true }],
    },
    license: 'Apache-2.0',
    ...overrides,
  }
}

function runtimeFixture(handler, overrides = {}) {
  const manifest = createAgentConnectorManifest(manifestInput(overrides))
  const registry = new AgentConnectorRegistry({
    approvedRecipeIds: ['external.review-agent.run'],
    approvedExternalManifestIds: [manifest.manifestId],
  })
  registry.registerExternal(manifest)
  registry.registerInstance({
    instanceId: 'custom-aaaaaaaaaaaaaaaa',
    connectorId: manifest.connectorId,
    connectorVersion: manifest.connectorVersion,
    upstreamVersion: '3.2.0',
    label: 'Review account A',
    credentialRef: 'credential-ref:review-account-a',
  })
  return {
    manifest,
    registry,
    runtime: new AgentConnectorRuntime({
      registry,
      recipes: { 'external.review-agent.run': handler },
    }),
  }
}

test('discovers and runs an approved external Connector with trusted durable provenance', async () => {
  const states = []
  const uiEvents = []
  const outbound = []
  const { manifest, runtime } = runtimeFixture(async (input) => {
    assert.equal(input.credentialRefId, 'credential-ref:review-account-a')
    assert.equal(input.connector.connectorVersion, '1.0.0')
    assert.equal(input.connector.upstreamVersion, '3.2.0')
    assert.equal(input.permissionMode, 'read-only')
    assert.deepEqual(input.provenance, {
      connectorId: manifest.connectorId,
      connectorVersion: manifest.connectorVersion,
      manifestId: manifest.manifestId,
      manifestSchemaVersion: manifest.schemaVersion,
      instanceId: 'custom-aaaaaaaaaaaaaaaa',
      recipeId: manifest.invocation.recipeId,
      upstreamId: manifest.upstream.id,
      upstreamVersion: '3.2.0',
      credentialRefId: 'credential-ref:review-account-a',
    })
    assert.equal(Object.hasOwn(input, 'executable'), false)
    assert.equal(Object.isFrozen(input.connector), true)
    assert.equal(input.assertOutboundDestination('https://review.example.com/v1'), 'https://review.example.com')
    await input.onOutboundPayload({
      destination: 'https://review.example.com/v1',
      transport: 'http',
    })
    input.emit({
      eventId: 'event-3', cursor: 'cursor-3', sequence: 3,
      type: 'Completed', outcome: 'completed', summary: 'Review complete.',
    })
    const source = {
      eventId: 'event-1', cursor: 'cursor-1', sequence: 1,
      type: 'SourceUsed', sourceId: 'source-1', sourceType: 'workspace-file',
      contentHash: 'd'.repeat(64), citation: 'src/index.js:10',
    }
    input.emit(source)
    input.emit({
      eventId: 'event-2', cursor: 'cursor-2', sequence: 2,
      type: 'Usage', mode: 'delta', usage: { inputTokens: 12 },
    })
    input.emit(source)
    return { text: 'External review result', sessionRef: 'review-session' }
  })

  const agents = runtime.detectAgents()
  assert.deepEqual(agents.map(agent => agent.kind), ['custom-aaaaaaaaaaaaaaaa'])
  assert.equal(agents[0].connectorInstanceId, 'custom-aaaaaaaaaaaaaaaa')
  assert.equal(agents[0].available, true)
  assert.equal(agents[0].invocable, true)
  assert.equal(Object.hasOwn(agents[0], 'credentialRef'), false)

  const result = await runtime.run(agents[0], 'Review the change', '/tmp/workspace', {
    runId: 'run-1',
    agentRunId: 'agent-run-1',
    sandbox: 'read-only',
    onConnectorState: context => states.push(context),
    onEvent: event => uiEvents.push(event),
    onOutboundPayload: payload => outbound.push(payload),
  })
  assert.equal(result.text, 'External review result')
  assert.equal(result.outcome, 'completed')
  assert.equal(result.connector.manifestId, manifest.manifestId)
  assert.deepEqual(result.connectorEventState.events.map(event => event.type), [
    'SourceUsed', 'Usage', 'Completed',
  ])
  assert.equal(result.connectorEventState.usage.inputTokens, 12)
  assert.deepEqual(result.usage, { inputTokens: 12 })
  assert.equal(states.length, 4)
  assert.deepEqual(states.at(-1).connectorEventState, result.connectorEventState)
  assert.equal(uiEvents.length, 3)
  assert.equal(uiEvents.every(event => !Object.hasOwn(event, 'rawOutput')), true)
  assert.deepEqual(outbound, [{
    destination: 'https://review.example.com/v1',
    transport: 'http',
  }])
})

test('Connector attachment limits match workspace submission', async () => {
  const { MAX_MESSAGE_ATTACHMENTS } = require('../../../src/workspace/local-workspace-message-records.cjs')
  let executed = 0
  const { runtime } = runtimeFixture(async input => {
    executed += 1
    assert.equal(input.attachments.length, MAX_MESSAGE_ATTACHMENTS)
    input.emit({ eventId: 'complete', cursor: 'complete', sequence: 1, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  })
  const agent = runtime.detectAgents()[0]
  const attachments = Array.from({ length: MAX_MESSAGE_ATTACHMENTS }, (_, i) => ({
    path: `/tmp/${i}.pdf`, mimeType: 'application/pdf',
  }))
  const options = { runId: 'run-files', agentRunId: 'agent-files', sandbox: 'read-only' }
  assert.equal((await runtime.run(agent, 'Review', '/tmp/workspace', { ...options, attachments })).outcome, 'completed')
  await assert.rejects(runtime.run(agent, 'Review', '/tmp/workspace', {
    ...options, attachments: [...attachments, attachments[0]],
  }), { message: 'AGENT_CONNECTOR_ATTACHMENTS_INVALID' })
  await assert.rejects(runtime.run(agent, 'Review', '/tmp/workspace', {
    ...options, attachments: [{ type: 'structured-data' }],
  }), { message: 'AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED' })
  assert.equal(executed, 1)
})

test('unreported Connector usage is estimated instead of counted as zero', async () => {
  const { runtime } = runtimeFixture(async input => {
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1,
      type: 'Completed', outcome: 'completed' })
    return { text: 'abcdefgh', outcome: 'completed' }
  })
  const result = await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-no-usage', agentRunId: 'agent-no-usage', sandbox: 'read-only',
  })
  assert.deepEqual(result.usage, {})
  const batches = []
  recordReplyUsage({ addUsageBatch: batch => batches.push(batch), elapsedValue: () => 1 }, {
    usage: result.usage, replyText: result.text, toolCallCount: 0,
  })
  assert.deepEqual(batches[0][0], { dimension: 'outputTokens', amount: 2, source: 'estimated' })
})

test('Connector result usage must be declared and supported by usage events', async () => {
  for (const [usage, expected] of [
    [{ unknown: 1 }, 'AGENT_CONNECTOR_USAGE_UNDECLARED'],
    [{ outputTokens: 4 }, 'AGENT_CONNECTOR_USAGE_UNREPORTED'],
  ]) {
    const { runtime } = runtimeFixture(async input => {
      input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1,
        type: 'Completed', outcome: 'completed' })
      return { text: 'done', outcome: 'completed', usage }
    })
    await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-result-usage', agentRunId: 'agent-result-usage', sandbox: 'read-only',
    }), { message: expected })
  }
  for (const [returned, accepted] of [[3, true], [4, false]]) {
    const { runtime } = runtimeFixture(async input => {
      input.emit({ eventId: 'usage', cursor: 'usage', sequence: 1,
        type: 'Usage', mode: 'delta', usage: { outputTokens: 3 } })
      input.emit({ eventId: 'completed', cursor: 'completed', sequence: 2,
        type: 'Completed', outcome: 'completed' })
      return { text: 'done', outcome: 'completed', usage: { outputTokens: returned } }
    })
    const run = runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-usage-match', agentRunId: 'agent-usage-match', sandbox: 'read-only',
    })
    if (accepted) assert.deepEqual((await run).usage, { outputTokens: 3 })
    else await assert.rejects(run, { message: 'AGENT_CONNECTOR_USAGE_UNREPORTED' })
  }
})

test('rejects every undeclared Connector capability before it crosses the recipe boundary', async () => {
  const terminalTypes = ['Completed', 'Failed', 'Cancelled']
  const hashes = {
    requestHash: 'a'.repeat(64),
    sessionRefHash: 'b'.repeat(64),
    sessionProvenanceHash: 'c'.repeat(64),
  }

  const attachments = runtimeFixture(async () => {
    assert.fail('attachment contract must reject before recipe execution')
  }, { inputTypes: ['text'] }).runtime
  await assert.rejects(attachments.run(
    attachments.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-attachment', agentRunId: 'agent-run-attachment', sandbox: 'read-only',
      attachments: ['/tmp/undeclared.png'],
    },
  ), { message: 'AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED' })

  const noSessions = runtimeFixture(async () => {
    assert.fail('session contract must reject before recipe execution')
  }, { session: { supported: false, resume: false, cancel: false, checkpoint: false } }).runtime
  await assert.rejects(noSessions.run(
    noSessions.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-session', agentRunId: 'agent-run-session', sandbox: 'read-only',
      sessionRef: 'existing-session',
    },
  ), { message: 'AGENT_CONNECTOR_SESSION_UNSUPPORTED' })

  const noResume = runtimeFixture(async () => {
    assert.fail('resume contract must reject before recipe execution')
  }, { session: { supported: true, resume: false, cancel: true, checkpoint: false } }).runtime
  await assert.rejects(noResume.run(
    noResume.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-resume', agentRunId: 'agent-run-resume', sandbox: 'read-only',
      connectorResume: {
        type: 'input', requestId: 'request-input', response: 'continue', ...hashes,
      },
    },
  ), { message: 'AGENT_CONNECTOR_RESUME_UNSUPPORTED' })

  const noCancel = runtimeFixture(async (input) => {
    assert.equal(input.signal, undefined)
    input.emit({
      eventId: 'cancelled', cursor: 'cancelled', sequence: 1,
      type: 'Cancelled', reason: 'user',
    })
  }, { session: { supported: true, resume: true, cancel: false, checkpoint: false } }).runtime
  await assert.rejects(noCancel.run(
    noCancel.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-cancel', agentRunId: 'agent-run-cancel', sandbox: 'read-only',
      signal: new AbortController().signal,
    },
  ), { message: 'AGENT_CONNECTOR_CANCEL_UNSUPPORTED' })

  const undeclaredEvent = runtimeFixture(async (input) => {
    input.emit({
      eventId: 'source', cursor: 'source', sequence: 1,
      type: 'SourceUsed', sourceId: 'source-1', sourceType: 'workspace-file',
      contentHash: 'd'.repeat(64),
    })
  }, { eventTypes: terminalTypes }).runtime
  await assert.rejects(undeclaredEvent.run(
    undeclaredEvent.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-event', agentRunId: 'agent-run-event', sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_EVENT_UNDECLARED' })

  const undeclaredUsage = runtimeFixture(async (input) => {
    input.emit({
      eventId: 'usage', cursor: 'usage', sequence: 1,
      type: 'Usage', mode: 'delta', usage: { inputTokens: 1 },
    })
  }, {
    eventTypes: [...terminalTypes, 'Usage'],
    usage: {
      inputTokens: false, outputTokens: false, costMicros: false,
      toolCalls: false, outboundBytes: false, elapsedMs: false,
    },
  }).runtime
  await assert.rejects(undeclaredUsage.run(
    undeclaredUsage.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-usage', agentRunId: 'agent-run-usage', sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_USAGE_UNDECLARED' })

  const undeclaredDestination = runtimeFixture(async (input) => {
    input.onOutboundPayload({ destination: 'https://untrusted.example.com/v1' })
  }).runtime
  await assert.rejects(undeclaredDestination.run(
    undeclaredDestination.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-destination', agentRunId: 'agent-run-destination', sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_OUTBOUND_DESTINATION_UNSUPPORTED' })

  const missingDestination = runtimeFixture(async (input) => {
    input.onOutboundPayload({ transport: 'http' })
  }).runtime
  await assert.rejects(missingDestination.run(
    missingDestination.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-missing-destination', agentRunId: 'agent-run-missing-destination',
      sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_OUTBOUND_DESTINATION_REQUIRED' })

  const forgedTunnel = runtimeFixture(async input => {
    input.onOutboundPayload({ transport: 'http', tunneled: true })
  }).runtime
  await assert.rejects(forgedTunnel.run(
    forgedTunnel.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-forged-tunnel', agentRunId: 'agent-run-forged-tunnel', sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_OUTBOUND_DESTINATION_REQUIRED' })

  const undeclaredSessionResult = runtimeFixture(async (input) => {
    input.emit({
      eventId: 'completed', cursor: 'completed', sequence: 1,
      type: 'Completed', outcome: 'completed',
    })
    return { text: 'done', sessionRef: 'undeclared-session' }
  }, { session: { supported: false, resume: false, cancel: false, checkpoint: false } }).runtime
  await assert.rejects(undeclaredSessionResult.run(
    undeclaredSessionResult.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-session-result', agentRunId: 'agent-run-session-result', sandbox: 'read-only',
    },
  ), { message: 'AGENT_CONNECTOR_SESSION_UNSUPPORTED' })
})

test('non-legacy Connector results cannot bypass event declarations with raw progress', async () => {
  const handler = async input => {
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1,
      type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed', progress: [{ title: 'undeclared tool call' }] }
  }
  const { runtime, registry } = runtimeFixture(handler)
  await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-raw-progress', agentRunId: 'agent-raw-progress', sandbox: 'read-only',
  }), { message: 'AGENT_CONNECTOR_EVENT_UNDECLARED' })
  const legacy = new AgentConnectorRuntime({ registry, recipes: { 'external.review-agent.run': handler },
    trustedLegacyEventRecipes: ['external.review-agent.run'] })
  const result = await legacy.run(legacy.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-legacy-progress', agentRunId: 'agent-legacy-progress', sandbox: 'read-only',
  })
  assert.deepEqual(result.progress, [{ title: 'undeclared tool call' }])
})

test('Connector session references must be bounded strings without control characters', async () => {
  for (const invalid of [{}, 42, 'session\nnext', 'session\u0000next', 'x'.repeat(257), 'path/session', 'sk_' + 'x'.repeat(16)]) {
    const inputRuntime = runtimeFixture(async () => assert.fail('invalid session reached recipe')).runtime
    await assert.rejects(inputRuntime.run(inputRuntime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-bad-session-input', agentRunId: 'agent-bad-session-input', sandbox: 'read-only', sessionRef: invalid,
    }), { message: 'AGENT_CONNECTOR_SESSION_INVALID' })
    const resultRuntime = runtimeFixture(async input => {
      input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1, type: 'Completed', outcome: 'completed' })
      return { text: 'done', sessionRef: invalid }
    }).runtime
    await assert.rejects(resultRuntime.run(resultRuntime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-bad-session-result', agentRunId: 'agent-bad-session-result', sandbox: 'read-only',
    }), { message: 'AGENT_CONNECTOR_SESSION_INVALID' })
  }
  const valid = 'x'.repeat(256)
  const { runtime } = runtimeFixture(async input => {
    assert.equal(input.sessionRef, valid)
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1, type: 'Completed', outcome: 'completed' })
    return { text: 'done', sessionRef: valid }
  })
  assert.equal((await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-good-session', agentRunId: 'agent-good-session', sandbox: 'read-only', sessionRef: valid,
  })).sessionRef, valid)
})

test('a generic file declaration cannot bypass media input capabilities', async () => {
  const { runtime } = runtimeFixture(async () => {
    assert.fail('unsupported media must not reach the connector recipe')
  })
  for (const mimeType of ['image/png', 'audio/mpeg', 'video/mp4']) {
    await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-media', agentRunId: 'agent-media', sandbox: 'read-only',
      attachments: [{ inputType: 'file', mimeType }],
    }), { message: 'AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED' })
  }
})

test('another input declaration cannot disguise an ordinary file', async () => {
  const { runtime } = runtimeFixture(async () => {
    assert.fail('undeclared file must not reach the connector recipe')
  }, { inputTypes: ['text', 'image', 'audio', 'video', 'structured-data'] })
  for (const inputType of ['image', 'audio', 'video', 'structured-data']) {
    await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-disguised', agentRunId: 'agent-disguised', sandbox: 'read-only',
      attachments: [{ inputType, mimeType: 'application/pdf' }],
    }), { message: 'AGENT_CONNECTOR_ATTACHMENT_UNSUPPORTED' })
  }
})

test('an image-only Connector rejects non-image path inputs before running', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meldwork-connector-image-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const image = path.join(directory, 'image.png')
  const disguised = path.join(directory, 'disguised.png')
  const link = path.join(directory, 'linked.png')
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  fs.writeFileSync(disguised, '%PDF-1.7\n')
  let symlinkAvailable = false
  try { fs.symlinkSync(image, link); symlinkAvailable = true } catch { /* Windows may not permit symlinks. */ }
  let calls = 0
  const { runtime } = runtimeFixture(async input => {
    calls += 1
    assert.deepEqual(input.attachments, [image])
    input.emit({ eventId: 'done', cursor: 'done', sequence: 1, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  }, { inputTypes: ['text', 'image', 'structured-data'] })
  const agent = runtime.detectAgents()[0]
  const options = { runId: 'run-image-path', agentRunId: 'agent-image-path', sandbox: 'read-only' }
  for (const attachment of [disguised, path.join(directory, 'missing.png'), ...(symlinkAvailable ? [link] : []),
    { inputType: 'structured-data', path: disguised }]) {
    await assert.rejects(runtime.run(agent, 'Review', directory, { ...options, attachments: [attachment] }),
      { message: 'AGENT_CONNECTOR_ATTACHMENTS_INVALID' })
  }
  assert.equal((await runtime.run(agent, 'Review', directory, { ...options, attachments: [image] })).outcome, 'completed')
  assert.equal(calls, 1)
})

test('explicit structured data without file MIME retains its declared capability', async () => {
  const { runtime } = runtimeFixture(async input => {
    assert.deepEqual(input.attachments, [{ inputType: 'structured-data', value: { answer: 42 } }])
    input.emit({ eventId: 'done', cursor: 'done', sequence: 1, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  }, { inputTypes: ['text', 'structured-data'] })
  assert.equal((await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-structured', agentRunId: 'agent-structured', sandbox: 'read-only',
    attachments: [{ inputType: 'structured-data', value: { answer: 42 } }],
  })).outcome, 'completed')
})

test('workspace preflight applies the same strict Connector media capabilities', () => {
  const { LocalWorkspaceMessageSubmission } = require('../../../src/workspace/local-workspace-message-submission.cjs')
  const validate = LocalWorkspaceMessageSubmission.prototype.validateAttachmentSupport
  const connector = { attachmentSupport: () => ({ file: 32, image: 0, fileFallback: false }) }
  assert.throws(() => validate.call(connector, ['connector'], [{ mimeType: 'image/png' }]),
    { message: 'LOCAL_AGENT_IMAGE_UNSUPPORTED' })
  assert.doesNotThrow(() => validate.call(connector, ['connector'], [{ mimeType: 'application/pdf' }]))
  const native = { attachmentSupport: () => ({ file: 32, image: 0 }) }
  assert.doesNotThrow(() => validate.call(native, ['native'], [{ mimeType: 'image/png' }]))
})

test('untrusted recipes cannot bypass event or permission capability checks through callbacks', async () => {
  const events = []
  let permissions = 0
  const { runtime } = runtimeFixture(async input => {
    assert.equal(input.onRuntimeEvent, undefined)
    assert.equal(input.onProgress, undefined)
    assert.equal(input.onPermissionRequest, undefined)
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1,
      type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  }, { eventTypes: ['Completed', 'Failed', 'Cancelled'] })
  await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-callback', agentRunId: 'agent-run-callback', sandbox: 'read-only',
    onEvent: event => events.push(event),
    onProgress: () => assert.fail('undeclared raw progress reached the caller'),
    onPermissionRequest: () => { permissions += 1 },
  })
  assert.equal(permissions, 0)
  assert.deepEqual(events.map(event => event.title), ['connector_completed'])
})

test('a recipe declaring Permission retains the permission request callback', async () => {
  let permissions = 0
  const { runtime } = runtimeFixture(async input => {
    assert.equal(typeof input.onPermissionRequest, 'function')
    await input.onPermissionRequest({ permission: 'read' })
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1,
      type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  })
  await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-declared-permission', agentRunId: 'agent-run-declared-permission', sandbox: 'read-only',
    onPermissionRequest: async () => { permissions += 1 },
  })
  assert.equal(permissions, 1)
})

test('workspace write permission events respect the active run mode', async () => {
  const { runtime } = runtimeFixture(async input => {
    input.emit({ eventId: 'write-request', cursor: 'write-request', sequence: 1,
      type: 'Permission', requestId: 'write-request', permission: 'workspace-write', decision: 'requested' })
    return {}
  }, { permissionModes: ['read-only', 'workspace-write'] })
  const agent = runtime.detectAgents()[0]
  await assert.rejects(runtime.run(agent, 'Review', '/tmp/workspace', {
    runId: 'run-read-only-write', agentRunId: 'agent-run-read-only-write', sandbox: 'read-only',
  }), { message: 'AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED' })
  const allowed = await runtime.run(agent, 'Review', '/tmp/workspace', {
    runId: 'run-write', agentRunId: 'agent-run-write', sandbox: 'workspace-write',
  })
  assert.equal(allowed.outcome, 'waiting_permission')
  assert.equal(allowed.waitingRequest.permission, 'workspace-write')
})

test('read-only connector callbacks cannot approve write tool requests', async () => {
  let prompts = 0
  const request = { toolCall: { kind: 'edit' }, options: [
    { optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' },
  ] }
  const { runtime } = runtimeFixture(async input => {
    const decision = await input.onPermissionRequest(request)
    if (input.permissionMode === 'read-only') assert.deepEqual(decision, { status: 'rejected', optionId: 'deny' })
    else assert.deepEqual(decision, { status: 'approved', optionId: 'allow' })
    input.emit({ eventId: 'completed', cursor: 'completed', sequence: 1, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  }, { permissionModes: ['read-only', 'workspace-write'] })
  const agent = runtime.detectAgents()[0]
  for (const sandbox of ['read-only', 'workspace-write']) {
    await runtime.run(agent, 'Review', '/tmp/workspace', {
      runId: `run-${sandbox}`, agentRunId: `agent-run-${sandbox}`, sandbox,
      onPermissionRequest: () => { prompts += 1; return { status: 'approved', optionId: 'allow' } },
    })
  }
  assert.equal(prompts, 1)
})

test('Connector outcome references must come from declared, validated events', async () => {
  const artifactId = `artifact-${'a'.repeat(64)}`
  const evidenceId = `evidence-${'b'.repeat(64)}`
  for (const outcomeRefs of [
    { artifactIds: [artifactId] },
    { evidenceIds: [evidenceId] },
    { findingIds: [`finding-${'c'.repeat(64)}`] },
    { artifactIds: 'not-an-array' },
  ]) {
    const { runtime } = runtimeFixture(async input => {
      input.emit({ eventId: 'done', cursor: 'done', sequence: 1, type: 'Completed', outcome: 'completed' })
      return { text: 'done', outcome: 'completed', outcomeRefs }
    }, { eventTypes: ['Completed', 'Failed', 'Cancelled'] })
    await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-forged-ref', agentRunId: 'agent-run-forged-ref', sandbox: 'read-only',
    }), { message: 'AGENT_CONNECTOR_OUTCOME_UNDECLARED' })
  }
  const { runtime } = runtimeFixture(async input => {
    input.emit({ eventId: 'artifact', cursor: 'artifact', sequence: 1, type: 'Artifact', artifactId })
    input.emit({ eventId: 'evidence', cursor: 'evidence', sequence: 2, type: 'Evidence', evidenceId })
    input.emit({ eventId: 'done', cursor: 'done', sequence: 3, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed', outcomeRefs: { artifactIds: [artifactId] } }
  })
  const result = await runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
    runId: 'run-valid-ref', agentRunId: 'agent-run-valid-ref', sandbox: 'read-only',
  })
  assert.deepEqual(result.outcomeRefs, { artifactIds: [artifactId], evidenceIds: [evidenceId] })
})

test('fails closed when a recipe, permission mode, or terminal event is missing', async () => {
  const missingTerminal = runtimeFixture(async () => ({ text: 'Not terminal' })).runtime
  await assert.rejects(
    missingTerminal.run(missingTerminal.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'read-only',
    }),
    { message: 'AGENT_CONNECTOR_TERMINAL_EVENT_REQUIRED' },
  )
  const permissionStates = []
  await assert.rejects(
    missingTerminal.run(missingTerminal.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-2', agentRunId: 'agent-run-2', sandbox: 'workspace-write',
      onConnectorState: context => permissionStates.push(context),
    }),
    { message: 'AGENT_CONNECTOR_PERMISSION_MODE_UNSUPPORTED' },
  )
  assert.equal(permissionStates.length, 1)
  assert.equal(permissionStates[0].connector.connectorVersion, '1.0.0')
  assert.deepEqual(permissionStates[0].connectorEventState.events, [])

  const { registry } = runtimeFixture(async () => ({ text: 'unused' }))
  const missingRecipe = new AgentConnectorRuntime({ registry })
  const recipeStates = []
  await assert.rejects(
    missingRecipe.run(missingRecipe.detectAgents()[0], 'Review', '/tmp/workspace', {
      runId: 'run-3', agentRunId: 'agent-run-3', sandbox: 'read-only',
      onConnectorState: context => recipeStates.push(context),
    }),
    { message: 'AGENT_CONNECTOR_RECIPE_UNAVAILABLE' },
  )
  assert.equal(recipeStates.length, 1)
  assert.equal(recipeStates[0].connector.connectorVersion, '1.0.0')
})

test('passes one durable operation ID through repeated idempotent Connector calls', async () => {
  const received = []
  const { runtime } = runtimeFixture(async (input) => {
    received.push({
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      mode: input.connector.capabilities.idempotencyMode,
    })
    input.emit({
      eventId: `${input.agentRunId}:completed`,
      cursor: `${input.agentRunId}:completed`,
      sequence: 1,
      type: 'Completed',
      outcome: 'completed',
    })
    return { text: 'done', sessionRef: '' }
  }, {
    invocation: { recipeId: 'external.review-agent.run', idempotencyMode: 'durable' },
    permissionModes: ['read-only', 'workspace-write'],
  })
  const [agent] = runtime.detectAgents()
  const operationId = `agent-operation-${'c'.repeat(64)}`

  await runtime.run(agent, 'Write once', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-1', sandbox: 'workspace-write', operationId,
  })
  await runtime.run(agent, 'Write once', '/tmp/workspace', {
    runId: 'run-1', agentRunId: 'agent-run-2', sandbox: 'workspace-write', operationId,
  })

  assert.deepEqual(received, [
    { operationId, idempotencyKey: operationId, mode: 'durable' },
    { operationId, idempotencyKey: operationId, mode: 'durable' },
  ])
})

test('returns durable waiting input and passes an exactly validated resume response', async () => {
  const received = []
  const { runtime } = runtimeFixture(async (input) => {
    received.push(input.resume)
    if (!input.resume) {
      input.emit({
        eventId: 'input-request', cursor: 'cursor-input', sequence: 1,
        type: 'WaitingInput', requestId: 'request-input', prompt: 'Choose a channel',
      })
      return { sessionRef: 'connector-session' }
    }
    input.emit({
      eventId: 'input-completed', cursor: 'cursor-completed', sequence: 1,
      type: 'Completed', outcome: 'completed',
    })
    return { text: `channel:${input.resume.response}`, sessionRef: 'connector-session' }
  })
  const [agent] = runtime.detectAgents()
  const waiting = await runtime.run(agent, 'Release', '/tmp/workspace', {
    runId: 'run-input', agentRunId: 'agent-run-input', sandbox: 'read-only',
  })
  assert.equal(waiting.outcome, 'waiting_input')
  assert.deepEqual({
    requestId: waiting.waitingRequest.requestId,
    prompt: waiting.waitingRequest.prompt,
  }, { requestId: 'request-input', prompt: 'Choose a channel' })

  const hashes = {
    requestHash: 'a'.repeat(64),
    sessionRefHash: 'b'.repeat(64),
    sessionProvenanceHash: 'c'.repeat(64),
  }
  const completed = await runtime.run(agent, 'Release', '/tmp/workspace', {
    runId: 'run-input', agentRunId: 'agent-run-input-2', sandbox: 'read-only',
    connectorResume: {
      type: 'input', requestId: 'request-input', response: 'stable', ...hashes,
    },
  })
  assert.equal(completed.text, 'channel:stable')
  assert.deepEqual(received, [null, {
    type: 'input', requestId: 'request-input', response: 'stable', ...hashes,
  }])
  await assert.rejects(runtime.run(agent, 'Release', '/tmp/workspace', {
    runId: 'run-input', agentRunId: 'agent-run-input-3', sandbox: 'read-only',
    connectorResume: {
      type: 'input', requestId: 'request-input', response: '', ...hashes,
    },
  }), { message: 'AGENT_CONNECTOR_RESUME_INVALID' })
})

test('a Connector cannot enter an unrecoverable input or permission wait', async () => {
  for (const event of [
    { type: 'WaitingInput', requestId: 'request-input', prompt: 'Choose a channel' },
    { type: 'Permission', requestId: 'request-permission', permission: 'network', decision: 'requested' },
  ]) {
    for (const session of [
      { supported: false, resume: false, cancel: true, checkpoint: false },
      { supported: true, resume: false, cancel: true, checkpoint: false },
    ]) {
      const { runtime } = runtimeFixture(async input => {
        input.emit({ eventId: 'wait', cursor: 'wait', sequence: 1, ...event })
        return {}
      }, { session })
      await assert.rejects(runtime.run(runtime.detectAgents()[0], 'Review', '/tmp/workspace', {
        runId: 'run-wait', agentRunId: 'agent-run-wait', sandbox: 'read-only',
      }), { message: 'AGENT_CONNECTOR_RESUME_UNSUPPORTED' })
    }
  }
})

test('returns durable waiting permission and validates the bound decision', async () => {
  const { runtime } = runtimeFixture(async (input) => {
    if (!input.resume) {
      input.emit({
        eventId: 'permission-request', cursor: 'permission-request', sequence: 1,
        type: 'Permission', requestId: 'network-request', permission: 'network',
        decision: 'requested', summary: 'Allow network access?',
      })
      return { sessionRef: 'permission-session' }
    }
    input.emit({
      eventId: 'permission-completed', cursor: 'permission-completed', sequence: 1,
      type: 'Completed', outcome: 'completed',
    })
    return { text: input.resume.status, sessionRef: 'permission-session' }
  })
  const [agent] = runtime.detectAgents()
  const waiting = await runtime.run(agent, 'Check permission', '/tmp/workspace', {
    runId: 'run-permission', agentRunId: 'agent-run-permission', sandbox: 'read-only',
  })
  assert.equal(waiting.outcome, 'waiting_permission')
  assert.equal(waiting.waitingRequest.requestId, 'network-request')

  const completed = await runtime.run(agent, 'Check permission', '/tmp/workspace', {
    runId: 'run-permission', agentRunId: 'agent-run-permission-2', sandbox: 'read-only',
    connectorResume: {
      type: 'permission', requestId: 'network-request', status: 'approved',
      optionId: 'allow-once', requestHash: 'a'.repeat(64),
      sessionRefHash: 'b'.repeat(64), sessionProvenanceHash: 'c'.repeat(64),
    },
  })
  assert.equal(completed.text, 'approved')
})

test('permission decision events must match the resumed human decision', async () => {
  let event = { eventId: 'decision', cursor: 'decision', sequence: 1, type: 'Permission',
    requestId: 'request-one', permission: 'network', decision: 'approved' }
  const { runtime } = runtimeFixture(async input => {
    input.emit(event)
    input.emit({ eventId: 'done', cursor: 'done', sequence: 2, type: 'Completed', outcome: 'completed' })
    return { text: 'done', outcome: 'completed' }
  })
  const agent = runtime.detectAgents()[0]
  const base = { runId: 'run-bound-permission', agentRunId: 'agent-run-bound-permission', sandbox: 'read-only' }
  const resume = { type: 'permission', requestId: 'request-one', status: 'approved', optionId: 'allow', permission: 'network',
    requestHash: 'a'.repeat(64), sessionRefHash: 'b'.repeat(64), sessionProvenanceHash: 'c'.repeat(64) }
  await assert.rejects(runtime.run(agent, 'Review', '/tmp/workspace', base),
    { message: 'AGENT_CONNECTOR_PERMISSION_DECISION_UNBOUND' })
  for (const bad of [{ ...resume, requestId: 'other' }, { ...resume, status: 'rejected' },
    { ...resume, permission: 'browser' }, { ...resume, permission: undefined }]) {
    await assert.rejects(runtime.run(agent, 'Review', '/tmp/workspace', { ...base, connectorResume: bad }),
      { message: 'AGENT_CONNECTOR_PERMISSION_DECISION_UNBOUND' })
  }
  const result = await runtime.run(agent, 'Review', '/tmp/workspace', { ...base, connectorResume: resume })
  assert.equal(result.outcome, 'completed')
})
