import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ERROR_MESSAGE_KEYS,
  messageKeys,
  setLocale,
  t,
  translateError,
  translateSystemMessage,
} from '../../i18n.js'

describe('Meldwork i18n', () => {
  it('keeps English and Chinese keys in sync', () => {
    expect(messageKeys('en')).toEqual(messageKeys('zh'))
  })

  it('interpolates values in both languages', () => {
    setLocale('en')
    expect(t('home.readyCount', { ready: 3, installed: 5 })).toBe('3 ready, 5 installed')

    setLocale('zh')
    expect(t('home.readyCount', { ready: 3, installed: 5 })).toBe('3 个可用，5 个已安装')
  })

  it('states attempt injection and Session provenance limits in both languages', () => {
    setLocale('en')
    expect(t('trace.contextIncluded', { count: 3 }))
      .toBe('3 messages injected for this attempt')
    expect(t('trace.contextMode.continuation')).toBe('Continuation payload')
    expect(t('trace.sourceFingerprint', { count: 4 })).toBe('Sources (4):')
    expect(t('trace.sessionReuseWarning')).toContain('Earlier native Session context may exist')
    expect(t('trace.sessionUnknownLegacyWarning'))
      .toContain('injected message IDs for this attempt are not the complete context')
    expect(t('trace.contextPackLegacyUnavailable')).toContain('cannot be reconstructed')

    setLocale('zh')
    expect(t('trace.contextIncluded', { count: 3 })).toBe('本次尝试注入 3 条消息')
    expect(t('trace.contextMode.continuation')).toBe('续跑外发')
    expect(t('trace.sourceFingerprint', { count: 4 })).toBe('来源（4 项）：')
    expect(t('trace.sessionReuseWarning')).toContain('Session 中可能还存在更早的上下文')
    expect(t('trace.sessionUnknownLegacyWarning')).toContain('消息 ID 并不代表完整上下文')
    expect(t('trace.contextPackLegacyUnavailable')).toContain('无法还原完整输入')
  })

  it('localizes Human Gates, Agent controls, and budget metadata', () => {
    setLocale('en')
    expect(t('humanGate.waiting')).toBe('Waiting for your decision')
    expect(t('humanGate.option.allowOnce')).toBe('Allow once')
    expect(t('humanGate.summary.decision')).toBe('This run requires your decision.')
    expect(t('humanGate.summary.retry')).toContain('may already have changed')
    expect(t('humanGate.summary.stalledCandidate')).toContain('unchanged for two rounds')
    expect(t('humanGate.summary.unknownWriteSynthesis')).toContain('result is unknown')
    expect(t('humanGate.option.retryOnce')).toBe('Retry once')
    expect(t('humanGate.option.continueDiscussion')).toBe('Continue discussion')
    expect(t('humanGate.option.stopDiscussion')).toBe('Stop discussion')
    expect(t('humanGate.option.retryOriginalWriter')).toBe('Retry original writer')
    expect(t('humanGate.option.replaceNextWriter')).toBe('Use next writer')
    expect(t('humanGate.option.acceptArtifact')).toBe('Accept Artifact')
    expect(t('humanGate.type.input')).toBe('Input')
    expect(t('humanGate.inputPlaceholder')).toBe('Enter your response')
    expect(t('trace.retryAgent')).toBe('Retry Agent')
    expect(t('trace.budgetDimension.toolCalls')).toBe('Tool calls')
    expect(t('trace.budgetExhaustion')).toBe('Hard budget stop')
    expect(t('run.phase.prepare')).toBe('Preparing orchestration')
    expect(t('run.phase.dispatch')).toBe('Dispatching Agents')
    expect(t('run.phase.running')).toBe('Running')
    expect(t('run.phase.reconcile')).toBe('Reconciling results')
    expect(t('run.phase.commit')).toBe('Committing delivery')
    expect(t('run.phase.failed')).toBe('Failed')
    // Status text says what happened instead of naming the mechanism.
    expect(t('run.status.circuitBreaker')).toBe('Stopped after repeated failures')
    expect(t('system.agentBudgetExhausted', { agent: 'Codex' })).toContain('usage limit')

    setLocale('zh')
    expect(t('humanGate.waiting')).toBe('等待你的决定')
    expect(t('humanGate.option.allowOnce')).toBe('允许一次')
    expect(t('humanGate.summary.decision')).toBe('该运行需要你做出决定。')
    expect(t('humanGate.summary.retry')).toContain('可能已经修改')
    expect(t('humanGate.summary.stalledCandidate')).toContain('连续两轮没有变化')
    expect(t('humanGate.summary.unknownWriteSynthesis')).toContain('结果未知')
    expect(t('humanGate.option.retryOnce')).toBe('重试一次')
    expect(t('humanGate.option.continueDiscussion')).toBe('继续讨论')
    expect(t('humanGate.option.stopDiscussion')).toBe('停止讨论')
    expect(t('humanGate.option.retryOriginalWriter')).toBe('重试原写入者')
    expect(t('humanGate.option.replaceNextWriter')).toBe('改由下一位写入者执行')
    expect(t('humanGate.option.acceptArtifact')).toBe('接受产物')
    expect(t('humanGate.type.input')).toBe('补充输入')
    expect(t('humanGate.inputPlaceholder')).toBe('请输入回复内容')
    expect(t('trace.retryAgent')).toBe('重试 Agent')
    expect(t('trace.budgetDimension.toolCalls')).toBe('工具调用')
    expect(t('trace.budgetExhaustion')).toBe('硬预算停止')
    expect(t('run.phase.commit')).toBe('提交交付结果')
    expect(t('run.phase.reconcile')).toBe('汇总结果')
    expect(t('run.phase.prepare')).toBe('准备编排')
    expect(t('run.phase.dispatch')).toBe('分发 Agent')
    expect(t('run.phase.running')).toBe('运行中')
    expect(t('run.phase.failed')).toBe('失败')
    // User-facing status avoids engineering terms like 熔断器 and 硬预算.
    expect(t('run.status.circuitBreaker')).toBe('失败过多，已自动停止')
    expect(t('system.agentBudgetExhausted', { agent: 'Codex' })).toContain('用量上限')
  })

  it('maps every stable desktop error code from direct and wrapped errors', () => {
    for (const language of ['en', 'zh']) {
      setLocale(language)
      for (const [code, key] of Object.entries(DESKTOP_ERROR_MESSAGE_KEYS)) {
        expect(translateError({ code }), code).toBe(t(key))
        expect(translateError(new Error(`Error invoking remote method: Error: ${code}`)), code).toBe(t(key))
      }
    }
  })

  it('covers every renderer-facing installer error code', () => {
    const expectedCodes = [
      'INSTALL_AGENT_ALREADY_INSTALLED',
      'INSTALL_AGENT_BUSY',
      'INSTALL_AGENT_COMMAND_BLOCKED',
      'INSTALL_AGENT_DOWNLOAD_BLOCKED',
      'INSTALL_AGENT_DOWNLOAD_FAILED',
      'INSTALL_AGENT_FAILED',
      'INSTALL_AGENT_NODE_REQUIRED',
      'INSTALL_AGENT_PLATFORM_UNSUPPORTED',
      'INSTALL_AGENT_PROCESS_FAILED',
      'INSTALL_AGENT_UNSUPPORTED',
      'INSTALL_AGENT_VERIFY_FAILED',
    ]

    expect(expectedCodes.filter(code => !DESKTOP_ERROR_MESSAGE_KEYS[code])).toEqual([])
  })

  it('maps stable desktop errors and localizes system message parameters', () => {
    const systemMessage = reason => ({
      content: `Hermes failed: ${reason}`,
      system: {
        key: 'system.agentCallFailed',
        params: { agent: 'Hermes', reason },
      },
    })

    setLocale('en')
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Sign in to this Agent or configure its credentials, then try again.')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('The Agent process failed before completing the task.')
    expect(translateError(new Error('LOCAL_AGENT_REPEATED_OUTPUT')))
      .toContain('kept repeating the same response')
    expect(translateError(new Error('LOCAL_AGENT_TIMEOUT')))
      .toBe('This Agent took too long to respond. Try again or start a new conversation.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes failed: Agent execution stopped.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_TIMEOUT')))
      .toBe('Hermes failed: This Agent took too long to respond. Try again or start a new conversation.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes failed: Sign in to this Agent or configure its credentials, then try again.')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes failed: The Agent process failed before completing the task.')
    expect(translateSystemMessage(systemMessage('MEDIA_GENERATION_MODEL_UNAVAILABLE')))
      .toContain('configured Providers do not offer the required media model')

    setLocale('zh')
    expect(translateError(new Error('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateError(new Error('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Agent 进程在任务完成前执行失败。')
    expect(translateError(new Error('LOCAL_AGENT_REPEATED_OUTPUT')))
      .toContain('持续重复相同回复')
    expect(translateError(new Error('LOCAL_AGENT_TIMEOUT')))
      .toBe('该 Agent 响应超时，请重试或新建会话后继续。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_EXECUTION_STOPPED')))
      .toBe('Hermes 调用失败：Agent 执行已停止。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_TIMEOUT')))
      .toBe('Hermes 调用失败：该 Agent 响应超时，请重试或新建会话后继续。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_AUTH_REQUIRED')))
      .toBe('Hermes 调用失败：请先登录该 Agent 或完成凭据配置后再试。')
    expect(translateSystemMessage(systemMessage('LOCAL_AGENT_PROCESS_FAILED')))
      .toBe('Hermes 调用失败：Agent 进程在任务完成前执行失败。')
    expect(translateSystemMessage(systemMessage('MEDIA_GENERATION_MODEL_UNAVAILABLE')))
      .toContain('当前配置的 Provider 未提供所需媒体模型')
  })

  it('localizes automatic discussion limits and falls back for unknown system keys', () => {
    const roundLimit = {
      content: 'Automatic discussion reached its round limit.',
      system: { key: 'system.autoRoundLimit', params: { rounds: 3 } },
    }
    const timeout = {
      content: 'Automatic discussion reached its total runtime limit.',
      system: { key: 'system.autoTimeout', params: {} },
    }
    const unknown = {
      content: 'Readable fallback from the desktop process.',
      system: { key: 'system.futureMessage', params: {} },
    }

    setLocale('en')
    expect(translateSystemMessage(roundLimit))
      .toBe('Automatic discussion reached its 3-round limit. The latest replies above are the current result; raise the round limit or send a follow-up to continue.')
    expect(translateSystemMessage(timeout))
      .toBe('Automatic discussion stopped after a runtime timeout before consensus.')
    expect(translateSystemMessage(timeout)).not.toContain('30')
    expect(translateSystemMessage(unknown)).toBe(unknown.content)

    setLocale('zh')
    expect(translateSystemMessage(roundLimit)).toBe('自动讨论已达到 3 轮上限，以上最新回复即为当前结果；如需继续，可调高轮数上限或追加消息。')
    expect(translateSystemMessage(timeout)).toBe('自动讨论在达成共识前因运行超时而停止。')
    expect(translateSystemMessage(timeout)).not.toContain('30')
    expect(translateSystemMessage(unknown)).toBe(unknown.content)
  })
})
