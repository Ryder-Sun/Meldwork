function taskPermissionGroup(group, state, taskId, contextPackId = '', getContextPack = null) {
  const task = state?.messages?.find(message => (
    message.id === taskId && message.groupId === group.id && message.role === 'user'
  ))
  let readOnly = task?.routingDecision?.permissionCap === 'read-only'
  if (contextPackId && typeof getContextPack === 'function') {
    const pack = getContextPack(contextPackId)
    if (pack.contextPackId !== contextPackId || pack.taskId !== taskId || pack.groupId !== group.id) {
      throw new Error('LOCAL_RUN_CONTEXT_INVALID')
    }
    readOnly ||= pack.permissionMode === 'read-only'
  }
  return group.allowWrite === true && readOnly
    ? { ...group, allowWrite: false }
    : group
}

module.exports = { taskPermissionGroup }
