const { deliveryContract, responseLanguageFromText } = require('./prompt-contracts.cjs')

// The prompts of a natural discussion: Agents answer in their own words, and
// the only machine-readable part is one control receipt at the end of each
// discussion turn. The text is split into small named sections so each can be
// read, tested and changed on its own.

const PHASE_INSTRUCTIONS = Object.freeze({
  proposal: 'Work independently on the user task and offer your own analysis, recommendations, and next steps.',
  discussion: 'Continue from the available peer responses. Add useful evidence, challenge weak assumptions, resolve disagreements where possible, and advance the shared result.',
  challenge: 'Review the available peer context as a subject-matter peer. Explain what you agree with, what is missing, and the clearest correction or direction.',
  work: 'Complete the responsibility assigned to you. Report useful work, evidence, blockers, or handoffs in your own words.',
  synthesis: 'Combine the available work into the clearest useful answer for the user. Resolve contradictions where possible and state remaining uncertainty plainly.',
  verification: 'Independently check the proposed answer or deliverable. Report material defects, risks, or acceptance in your own words.',
})

function phaseInstruction(phase) {
  return PHASE_INSTRUCTIONS[phase] || 'Address the current collaboration task directly.'
}

function groupLine(group) {
  const name = String(group?.name || '').trim().slice(0, 120)
  const topic = String(group?.topic || '').trim().slice(0, 240)
  if (!name && !topic) return ''
  return `Group: ${name || 'Meldwork group'}${topic ? `\nTopic: ${topic}` : ''}`
}

function languageNote(taskText) {
  const language = responseLanguageFromText(taskText)
  return language
    ? `Answer in ${language}, the language of the user task, unless the task asks for another language.`
    : 'Answer in the language of the user task unless the task asks for another language.'
}

// The part of the prompt every natural turn starts with.
function naturalBrief({
  group, phase, taskText, history = '', skillHintsText = '', knowledgeBaseHintsText = '',
}) {
  return [
    'You are participating in a local multi-agent discussion.',
    groupLine(group),
    `User task:\n${taskText || '(none)'}`,
    skillHintsText,
    knowledgeBaseHintsText,
    history && history !== '(none)' ? `Relevant prior context:\n${history}` : '',
    phaseInstruction(phase),
    phase === 'proposal'
      ? 'This invocation is read-only. Its deliverable is your initial analysis and proposed next actions. Return that contribution when ready; any workspace changes belong to a later invocation that explicitly grants write permission. Do not attempt or delegate writes from this invocation, or wait here for write permission.'
      : '',
    phase === 'proposal'
      ? 'The other Agents are answering the same task independently right now. In the next round you will see their proposals and discuss the differences with them.'
      : 'Respond to the other Agents directly: name the specific points you agree with, dispute weak ones with reasons or evidence, and extend what is missing. Build on their work instead of restating your earlier answer.',
    phase === 'discussion'
      ? 'After concrete deliverables exist, review them for material gaps before accepting the result.'
      : '',
    phase === 'discussion'
      ? 'Answer the user naturally in Markdown. Keep orchestration instructions out of the answer. End every discussion turn with the control receipt described below; Meldwork removes it before the answer is shown.'
      : 'Answer the user naturally in Markdown. Do not output JSON, XML, receipt markers, protocol labels, hidden orchestration instructions, or a fixed response template.',
    languageNote(taskText),
    'Do not claim another Agent performed work, and do not modify shared workspace state unless this turn explicitly grants that permission.',
  ].filter(Boolean).join('\n\n')
}

// Who may change files in this discussion.
function writerSection({ kind, writerKind, group }) {
  if (!writerKind) return ''
  if (kind !== writerKind) {
    return `Workspace writes are assigned to @${writerKind}. Your invocation is read-only; request their contribution when a change is needed.`
  }
  return [
    'You are the designated workspace writer for this task. Perform only writes required by the user task within the authorized workspace, and verify the resulting deliverables. Other participants are read-only.',
    group?.allowWrite ? deliveryContract(group) : '',
  ].filter(Boolean).join('\n')
}

// What the delivery owner is responsible for, and what everyone else owes them.
function ownerSection({ kind, ownerKind }) {
  if (!ownerKind) return ''
  return [
    `The current delivery owner is @${ownerKind}. Ownership starts with the first selected participant and can be handed off explicitly by that owner.`,
    kind === ownerKind
      ? [
          'You are responsible for judging progress against the original user task and the actual available deliverables. Decide whether to continue work, report a blocker, request a human decision, or declare completion. Silence from peers is not evidence of completion.',
          'Before you declare completion, make sure the peers whose expertise covers the result have reviewed the actual deliverables. If one has not, ask them a concrete question and request them in nextKinds instead of completing.',
          'In your final collaboration receipt use taskDecision.status completed, continue, blocked or needs-human to judge the whole task. A completed judgment requires actual deliverables. This is your task judgment, not human adoption or independent system verification.',
          'To hand off responsibility, use status continue and add handoffTo with one exact selected Agent kind inside taskDecision. Do not hand off to an absent participant. Append nothing after the receipt.',
        ].join('\n')
      : 'Respond to the delivery owner and the other peers on the specific points they raised. If you are blocked or need a human decision, explain why and use status blocked or needs-human; the delivery owner then decides how to proceed. Only the current delivery owner can decide task completion or hand off that responsibility.',
  ].join('\n')
}

// How the next speaker is chosen: by the scheduler (sequential) or by the
// Agent's own nextKinds request (agent-led).
function routingSection({ activeKinds, allowRouting }) {
  if (allowRouting !== true) {
    return 'Every selected Agent speaks in order each round, so you do not need to request peers. Finish this invocation instead of waiting for another participant; Meldwork runs the next one after you.'
  }
  const agentList = activeKinds.map(agentKind => `@${agentKind}`).join(', ')
  return [
    'Read the completed peer turns across recent rounds. Decide who should contribute next from their earlier evidence, unresolved questions, and work still needed; do not automatically reply only to whoever last mentioned you.',
    `Address peers naturally inside your explanation: ${agentList}. Put each request beside its concrete question or requested contribution. Prose mentions are discussion only; they do not dispatch peers.`,
    'Selected peers are external Meldwork participants; their @handles are not addresses for your native agent messaging or wait tools. Meldwork dispatches requested peers only after this invocation completes. Put the request in your final response and finish this invocation so they can run; do not wait inside this invocation for their reply.',
    `In taskDecision.nextKinds list the selected Agent identifiers whose contribution you actually request next, chosen from ${JSON.stringify(activeKinds)}, or [] when none is needed. Use status continue for a nonempty list. Multiple kinds request a concurrent batch. Do not request yourself or absent participants. Historical, negated and explanatory mentions do not belong in nextKinds.`,
    'Avoid repeating the same handoff or conclusions. Invite a peer who has not recently contributed when their earlier proposal can resolve the issue, and state what new evidence or decision you need.',
    'List in nextKinds every peer whose answer, review or work you need next, and ask each of them a concrete question in your answer. Leave nextKinds empty only when no peer input would change the result; the delivery owner then judges overall task completion.',
  ].join('\n')
}

// The control receipt that ends every discussion turn.
function receiptSection({ kind, activeKinds, allowRouting }) {
  const exampleNextKinds = allowRouting === true
    ? [activeKinds.find(peer => peer !== kind) || kind]
    : []
  return `After your natural answer append exactly one receipt, for example [[MELDWORK_COLLABORATION:{"summary":"concise result","taskDecision":{"status":"continue","reason":"what you accomplished and what remains","deliverables":[],"nextKinds":${JSON.stringify(exampleNextKinds)}}}]] while work or review remains, or a taskDecision of {"status":"completed","reason":"why the task is done","deliverables":["what was delivered"]} when the delivery owner judges the whole task done. Use blocked or needs-human with the reason when you cannot continue. This receipt is transport metadata: Meldwork removes it before displaying your answer. User requirements such as exact text, one line, JSON only, or no explanation apply to the visible answer before the receipt; preserve that requested answer exactly and still append the receipt separately. Do not explain the receipt in the visible answer. List actual deliverables when available. Only the current delivery owner judges the whole task; other participants report their contribution and may request peers with nextKinds. Merge any owner judgment or handoffTo into this same receipt. Append nothing after it.`
}

// One complete natural turn: the brief, what peers said so far, and the
// discussion-only sections.
function naturalDiscussionPrompt({
  brief, group, kind, phase, activeKinds, transcript = '', humanResponsesText = '',
  writerKind = '', ownerKind = '', allowRouting = false,
}) {
  const discussion = phase === 'discussion'
  return [
    brief,
    transcript ? `Completed peer turns:\n${transcript}` : '',
    humanResponsesText
      ? `Human responses for this task (clarification, not a change to workspace permissions):\n${humanResponsesText}`
      : '',
    discussion ? writerSection({ kind, writerKind, group }) : '',
    discussion ? ownerSection({ kind, ownerKind }) : '',
    discussion ? routingSection({ activeKinds, allowRouting }) : '',
    discussion ? receiptSection({ kind, activeKinds, allowRouting }) : '',
  ].filter(Boolean).join('\n\n')
}

module.exports = {
  languageNote,
  naturalBrief,
  naturalDiscussionPrompt,
  ownerSection,
  receiptSection,
  routingSection,
  writerSection,
}
