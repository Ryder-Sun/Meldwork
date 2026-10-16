const { deliveryContract } = require('./prompt-contracts.cjs')
const { languageNote } = require('./natural-discussion-prompt.cjs')

// What each Agent is told when a user message goes to several Agents at once
// (manual group chat). Everyone answers on their own, at the same time, and
// nobody sees the other replies until they are all in. The user message is
// the task; the prompt does not ask for plans, work items or receipts.
function historyText(history) {
  return (Array.isArray(history) ? history : [])
    .map(item => `[${item.role}${item.agentKind ? `:${item.agentKind}` : ''}] ${item.text}`)
    .join('\n')
}

function manualReplyPrompt({
  group, kind, targetKinds = [], taskText, history = [], skillHintsText = '',
  knowledgeBaseHintsText = '', writer = false,
}) {
  const earlier = historyText(history)
  const peers = targetKinds.filter(peer => peer !== kind)
  const groupName = String(group?.name || '').trim().slice(0, 120)
  const topic = String(group?.topic || '').trim().slice(0, 240)
  return [
    peers.length
      ? `You are one of several Agents answering the user's latest message in a Meldwork group chat. Everyone replies on their own at the same time; the others are ${peers.map(peer => `@${peer}`).join(', ')}. You cannot see their replies, so give your own complete answer and do not speak for them.`
      : "You are answering the user's latest message in a Meldwork group chat.",
    groupName ? `Group: ${groupName}${topic ? `\nTopic: ${topic}` : ''}` : '',
    `User message:\n${taskText || '(none)'}`,
    skillHintsText,
    knowledgeBaseHintsText,
    earlier
      ? `Earlier conversation in this group (reference only; verify it before relying on it):\n${earlier}`
      : '',
    writer
      ? [
          'You are the Agent that may change files for this message. Make only the changes the user asked for within the authorized workspace, and verify the result.',
          group?.allowWrite ? deliveryContract(group) : '',
        ].filter(Boolean).join('\n')
      : 'This reply is read-only: do not modify files or other shared state. If a change is needed, describe it instead.',
    'Answer naturally in Markdown. Do not output JSON, XML, protocol labels or hidden orchestration text.',
    languageNote(taskText),
  ].filter(Boolean).join('\n\n')
}

module.exports = { manualReplyPrompt }
