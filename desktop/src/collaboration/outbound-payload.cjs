const crypto = require('node:crypto')

const wireBytesByPayload = new WeakMap()

function canonicalJson(value) {
  const normalized = JSON.parse(JSON.stringify(value))
  function serialize(item) {
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`
    if (item && typeof item === 'object') {
      return `{${Object.keys(item).sort().map(key => (
        `${JSON.stringify(key)}:${serialize(item[key])}`
      )).join(',')}}`
    }
    return JSON.stringify(item)
  }
  return serialize(normalized)
}

function payloadWithBytes(fields, value) {
  const bytes = Buffer.from(value)
  const payload = Object.freeze({
    ...fields,
    wirePayloadHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    wirePayloadBytes: bytes.length,
  })
  wireBytesByPayload.set(payload, bytes)
  return payload
}

function payloadWithFingerprint(fields, wirePayload) {
  return payloadWithBytes(fields, Buffer.from(canonicalJson(wirePayload), 'utf8'))
}

function cliWirePayload(command, args, cwd, stdin) {
  return {
    command,
    args: [...args],
    cwd,
    stdin,
  }
}

function createLegacyOutboundPayload({
  prompt, command, args, cwd, stdin, promptMode, destination = '',
}) {
  return payloadWithFingerprint({
    prompt,
    transport: 'legacy',
    serialization: 'cli-argv-stdin-v1',
    promptMode,
    ...(destination ? { destination } : {}),
  }, cliWirePayload(command, args, cwd, stdin))
}

function createAcpOutboundPayload({ prompt, wireBytes }) {
  return payloadWithBytes({
    prompt,
    transport: 'acp',
    serialization: 'acp-session-prompt-v1',
    promptMode: 'acp',
  }, wireBytes)
}

function createCustomOutboundPayload({ prompt, command, args, cwd, stdin, promptMode }) {
  return payloadWithFingerprint({
    prompt,
    transport: 'custom',
    serialization: 'custom-cli-argv-stdin-v1',
    promptMode,
  }, cliWirePayload(command, args, cwd, stdin))
}

function outboundWirePayloadBytes(payload) {
  const bytes = payload && typeof payload === 'object' ? wireBytesByPayload.get(payload) : null
  return bytes ? Buffer.from(bytes) : null
}

module.exports = {
  createAcpOutboundPayload,
  createCustomOutboundPayload,
  createLegacyOutboundPayload,
  outboundWirePayloadBytes,
}
