const { stagedAgentInputPrompt } = require('../agents/agent-input-staging.cjs')
const { directPromptFor } = require('./local-workspace-context.cjs')
const { cleanText } = require('./local-workspace-inputs.cjs')

const RESPONSE_SCOPE_INSTRUCTION = [
  'Final response scope:',
  'Answer only the current user task stated above.',
  'Use earlier messages only as supporting evidence when they help answer that current task.',
  'Do not separately mention, summarize, continue, or complete any previous user task.',
  'Do not append an answer to an older task after the current-task conclusion.',
].join('\n')

// Builds the prompt one Agent receives for one turn.
//  - frozen / isolated invocations send exactly the approved prompt.
//  - direct chats lead with the user's request; a resumed native session
//    already holds the conversation, a new or rebuilt one gets the history.
//  - group turns use the V4 prompt when the orchestrator supplied one, else
//    the workspace prompt for the current mode.
// Staged attachments and harness recovery instructions are appended to both.
function assembleInvocationPrompt({
  group, kind, mode, threadRootId, context, activeRun, isolated, frozen,
  v4Prompt, promptMode, afterKind, packed, session, stagedInputs, promptFor, agentLabel,
}) {
  if (isolated || frozen) return v4Prompt
  const runtimeInstruction = cleanText(context.runtimeInstruction, 3000)
  const regenerationInstruction = cleanText(context.regenerationInstruction, 3000)
  const additions = [
    stagedAgentInputPrompt(stagedInputs),
    runtimeInstruction ? `Harness recovery task:\n${runtimeInstruction}` : '',
    regenerationInstruction ? `Fresh response instruction:\n${regenerationInstruction}` : '',
  ]
  if (group.conversationType === 'direct') {
    return [
      directPromptFor({
        group,
        label: agentLabel(kind),
        packed,
        skillHints: context.skillHints || [],
        knowledgeBaseHints: context.knowledgeBaseHints || [],
        includeHistory: session.rotated || !session.ref,
      }),
      ...additions,
    ].filter(Boolean).join('\n\n')
  }
  return [
    context.v4 === true && v4Prompt
      ? v4Prompt
      : promptFor(
        group, kind, context.completionPolicy === 'typed' ? 'manual' : mode,
        threadRootId, context.skillHints || [],
        context.knowledgeBaseHints || [], afterKind, packed, promptMode,
        activeRun?.unlimitedRounds === true,
      ),
    ...additions,
    RESPONSE_SCOPE_INSTRUCTION,
  ].filter(Boolean).join('\n')
}

module.exports = { assembleInvocationPrompt }
