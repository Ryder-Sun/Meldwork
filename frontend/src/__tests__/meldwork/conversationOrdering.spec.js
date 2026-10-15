import { describe, expect, it } from 'vitest'
import {
  compareSortKeys,
  compareTraceItems,
  timelineSortKey,
  timestampValue,
} from '../../conversationOrdering.js'

function order(messages, topicIndex = 0) {
  return messages
    .map((message, index) => ({ message, key: timelineSortKey(message, { topicIndex, index }) }))
    .sort((left, right) => compareSortKeys(left.key, right.key))
    .map(item => item.message.id)
}

describe('conversation ordering', () => {
  it('parses numeric and ISO timestamps instead of collapsing numbers to zero', () => {
    expect(timestampValue(1760500000000)).toBe(1760500000000)
    expect(timestampValue('2026-10-15T08:00:00.000Z')).toBe(Date.parse('2026-10-15T08:00:00.000Z'))
    expect(timestampValue('not a date')).toBe(0)
  })

  it('orders a topic by dispatch turn regardless of save time', () => {
    const root = { id: 'root', role: 'user' }
    const failure = { id: 'failure', role: 'system', threadRootId: 'root', turnSeq: 2, createdAt: 10 }
    const first = { id: 'first', role: 'agent', threadRootId: 'root', turnSeq: 1, createdAt: 30 }
    const third = { id: 'third', role: 'agent', threadRootId: 'root', turnSeq: 3, createdAt: 20 }
    const limit = { id: 'limit', role: 'system', threadRootId: 'root', turnSeq: 4, createdAt: 15 }
    expect(order([limit, third, failure, first, root])).toEqual(['root', 'first', 'failure', 'third', 'limit'])
  })

  it('keeps a live bubble in the slot of the reply that will replace it', () => {
    const root = { id: 'root', role: 'user' }
    const saved = { id: 'saved', role: 'agent', threadRootId: 'root', turnSeq: 2, createdAt: 50 }
    const live = {
      id: 'live', role: 'agent', threadRootId: 'root', provisional: true,
      createdAt: 99, liveAgentRun: { turnSeq: 1 },
    }
    expect(order([saved, live, root])).toEqual(['root', 'live', 'saved'])
  })

  it('keeps legacy history chronological and before newly numbered turns', () => {
    const root = { id: 'root', role: 'user' }
    const oldReply = { id: 'old', role: 'agent', threadRootId: 'root', createdAt: '2026-01-01T00:00:02Z' }
    const oldNotice = { id: 'notice', role: 'system', threadRootId: 'root', createdAt: '2026-01-01T00:00:01Z' }
    const numbered = { id: 'numbered', role: 'agent', threadRootId: 'root', turnSeq: 1, createdAt: 0 }
    const unnumberedLive = { id: 'live', role: 'agent', threadRootId: 'root', provisional: true, createdAt: 5 }
    expect(order([unnumberedLive, numbered, oldReply, oldNotice, root]))
      .toEqual(['root', 'notice', 'old', 'numbered', 'live'])
  })

  it('orders trace items by round, then turn, then the run target order', () => {
    const targets = new Map([['hermes', 0], ['codex', 1]])
    const items = [
      { agentKind: 'hermes', round: 2, turnSeq: 4 },
      { agentKind: 'codex', round: 2, turnSeq: 3 },
      { agentKind: 'codex', round: 1 },
      { agentKind: 'hermes', round: 1 },
    ]
    expect([...items].sort((left, right) => compareTraceItems(left, right, targets))
      .map(item => `${item.round}:${item.agentKind}`))
      .toEqual(['1:hermes', '1:codex', '2:codex', '2:hermes'])
  })
})
