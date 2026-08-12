/**
 * Canonical IPC channel names. Both sides import these so a typo becomes a
 * compile error rather than a silently dead channel.
 */

export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetApiKey: 'settings:setApiKey',
  settingsClearApiKey: 'settings:clearApiKey',

  // gateway
  gatewayTest: 'gateway:test',
  gatewayModels: 'gateway:models',

  // workspace
  workspaceOpen: 'workspace:open',
  workspaceCurrent: 'workspace:current',
  workspaceList: 'workspace:list',
  workspaceRead: 'workspace:read',
  workspaceWrite: 'workspace:write',
  workspaceCreate: 'workspace:create',
  workspaceDelete: 'workspace:delete',
  workspaceRename: 'workspace:rename',
  workspaceSearch: 'workspace:search',

  // agent
  agentSend: 'agent:send',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentReset: 'agent:reset',
  agentEvent: 'agent:event', // main -> renderer push
  processesList: 'processes:list',
  processesStop: 'processes:stop',

  // terminal
  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',
  terminalEvent: 'terminal:event', // main -> renderer push
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
