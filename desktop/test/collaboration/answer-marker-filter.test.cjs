const test = require('node:test')
const assert = require('node:assert/strict')
const { createAnswerMarkerFilter } = require('../../src/collaboration/answer-marker-filter.cjs')

function streamed(filter, chunks, finalText = chunks.join('')) {
  return chunks.map(chunk => filter.push(chunk)).join('') + filter.flush(finalText)
}

test('plain answers pass through untouched', () => {
  const filter = createAnswerMarkerFilter()
  assert.equal(streamed(filter, ['[[not a marker', ' at all]]']), '[[not a marker at all]]')
})

test('receipt mode hides the receipt however the stream is chunked', () => {
  const receipt = '[[MELDWORK_COLLABORATION:{"summary":"done"}]]'
  const text = `Here is the answer.\n\n${receipt}`
  for (let size = 1; size <= text.length; size += 1) {
    const chunks = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'))
    const filter = createAnswerMarkerFilter({ mode: 'receipt' })
    assert.equal(
      streamed(filter, chunks, 'Here is the answer.'),
      'Here is the answer.\n\n',
      `chunk size ${size}`,
    )
  }
})

test('receipt mode removes consensus markers but keeps the surrounding text', () => {
  const filter = createAnswerMarkerFilter({ mode: 'receipt' })
  assert.equal(
    streamed(filter, ['Agreed.', ' [[MELDWORK_CONSENSUS:agree]]', ' Next steps follow.']),
    'Agreed.  Next steps follow.',
  )
})

test('marker matching is case-insensitive and never shifts on special characters', () => {
  const filter = createAnswerMarkerFilter({ mode: 'receipt' })
  // "ß" upper-cases to two letters, which used to misalign the cut position.
  assert.equal(
    streamed(filter, ['Straße im Süden. [[meldwork_collaboration:{"summary":"x"}]]'], 'Straße im Süden.'),
    'Straße im Süden. ',
  )
})

test('a held fragment that turns out to be real text is released at the end', () => {
  const filter = createAnswerMarkerFilter({ mode: 'receipt' })
  assert.equal(streamed(filter, ['Use brackets like [[MELD']), 'Use brackets like [[MELD')
  const dropped = createAnswerMarkerFilter({ mode: 'receipt' })
  assert.equal(streamed(dropped, ['Answer.', '[[MELDWORK_COLL'], 'Answer.'), 'Answer.')
})

test('auto mode hides consensus markers only', () => {
  const filter = createAnswerMarkerFilter({ mode: 'auto' })
  assert.equal(
    streamed(filter, ['One.', ' [[MELDWORK_CONSENS', 'US:continue]]', ' Two.']),
    'One.  Two.',
  )
  const receiptText = createAnswerMarkerFilter({ mode: 'auto' })
  assert.equal(
    streamed(receiptText, ['[[MELDWORK_COLLABORATION:{}]] stays']),
    '[[MELDWORK_COLLABORATION:{}]] stays',
  )
})
