const { outboundWirePayloadBytes } = require('../collaboration/outbound-payload.cjs')

// What the Agent was sent: wire bytes are reported, tokens are an estimate.
function recordOutboundUsage(budget, outbound) {
  if (!budget) return
  const bytes = outboundWirePayloadBytes(outbound)
  // A payload that was not built by the transport has no recorded wire size;
  // skipping it is better than failing the Agent's turn over bookkeeping.
  if (!bytes) return
  budget.addUsageBatch([
    { dimension: 'outboundBytes', amount: bytes.length, source: 'reported' },
    { dimension: 'inputTokens', amount: Math.ceil(bytes.length / 4), source: 'estimated' },
  ])
}

// What the Agent produced: prefer the usage the CLI reported over an estimate.
function recordReplyUsage(budget, { usage, replyText, toolCallCount }) {
  if (!budget) return
  const reportedOutputTokens = Number(usage?.outputTokens)
  const hasReportedOutputTokens = Number.isSafeInteger(reportedOutputTokens)
    && reportedOutputTokens >= 0
  const reportedCostMicros = Number(usage?.costMicros)
  budget.addUsageBatch([
    {
      dimension: 'outputTokens',
      amount: hasReportedOutputTokens ? reportedOutputTokens : Math.ceil(replyText.length / 4),
      source: hasReportedOutputTokens ? 'reported' : 'estimated',
    },
    { dimension: 'toolCalls', amount: toolCallCount, source: 'estimated' },
    ...(Number.isSafeInteger(reportedCostMicros) && reportedCostMicros >= 0
      ? [{ dimension: 'costMicros', amount: reportedCostMicros, source: 'reported' }]
      : []),
    { dimension: 'elapsedMs', value: budget.elapsedValue(), source: 'reported' },
  ])
}

module.exports = { recordOutboundUsage, recordReplyUsage }
