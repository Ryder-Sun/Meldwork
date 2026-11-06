function taskPermissionGroup(group, state, taskId) {
  const task = state?.messages?.find(message => (
    message.id === taskId && message.groupId === group.id && message.role === 'user'
  ))
  return group.allowWrite === true && task?.routingDecision?.permissionCap === 'read-only'
    ? { ...group, allowWrite: false }
    : group
}

module.exports = { taskPermissionGroup }
