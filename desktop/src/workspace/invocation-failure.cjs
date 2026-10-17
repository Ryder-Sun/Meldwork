const { agentStoppedError } = require('./local-workspace-inputs.cjs')

// Marks how far an invocation got before it failed, so the run can decide
// whether the operation may be retried safely.
function attachInvocationFailure(error, input) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  const existing = error.invocationFailure && typeof error.invocationFailure === 'object'
    ? error.invocationFailure
    : {}
  Object.defineProperty(error, 'invocationFailure', {
    value: Object.freeze({
      outcomeCertainty: existing.outcomeCertainty || input.outcomeCertainty,
      sideEffectsPossible: existing.sideEffectsPossible === true || input.sideEffectsPossible === true,
      operationId: existing.operationId || input.operationId,
      idempotencyMode: existing.idempotencyMode || input.idempotencyMode,
    }),
    enumerable: false,
    configurable: true,
  })
  return error
}

// Hidden properties on an error that downstream code reads but that must not
// leak into serialised error messages.
function attachErrorMetadata(error, metadata) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  for (const [name, value] of Object.entries(metadata)) {
    if (!value) continue
    Object.defineProperty(error, name, { value, enumerable: false, configurable: true })
  }
  return error
}

// Why an invocation ended and how to report it:
//  - the parent run was stopped, timed out or is shutting down;
//  - the watchdog cut a silent Agent off;
//  - the Agent was cancelled on its own (e.g. a superseded attempt);
//  - or it simply failed with `caughtError`.
// `settleOutstanding` tells the caller to wait briefly for capture and run
// promises that may still be winding down.
function resolveInvocationStop({
  caughtError, signal, parentAbortObserved, activeRun, agentController, watchdog,
}) {
  const parentTimedOut = Boolean(signal?.aborted && activeRun?.stopReason === 'timeout')
  const parentStopped = Boolean(signal?.aborted || parentAbortObserved)
  const parentInterrupted = parentStopped && activeRun?.stopReason === 'shutdown'
  const agentCancelled = agentController.signal.aborted && !parentStopped && !watchdog.timedOut
  let error = caughtError
  let status = 'failed'
  if (parentTimedOut) {
    error = new Error('LOCAL_AGENT_TIMEOUT')
    status = 'timeout'
  } else if (parentStopped) {
    error = caughtError?.message === 'LOCAL_AGENT_EXECUTION_STOPPED'
      ? caughtError
      : agentStoppedError()
    status = parentInterrupted ? 'interrupted' : 'stopped'
  } else if (watchdog.timedOut) {
    error = watchdog.error || new Error('LOCAL_AGENT_TIMEOUT')
    status = 'timeout'
  } else if (agentCancelled) {
    error = agentStoppedError()
    status = 'stopped'
  }
  return {
    error,
    status,
    settleOutstanding: parentStopped || watchdog.timedOut || agentCancelled,
  }
}

module.exports = { attachErrorMetadata, attachInvocationFailure, resolveInvocationStop }
