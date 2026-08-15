export const PROVIDER_CHOICES = {
  addProvider: 'add provider',
  custom: 'custom',
} as const;

export const PROVIDER_ACTIONS = {
  useProvider: 'use provider',
  addModels: 'add models',
  manageAccess: 'set API key',
  signInChatGpt: 'sign in with ChatGPT',
  markImageCapable: 'mark image-capable',
  clearImageCapable: 'clear image-capable',
  removeModels: 'remove models',
  removeProvider: 'remove provider',
} as const;

export const MODEL_CHOICES = {
  addModels: 'add models',
  enterModelNames: 'enter model names',
} as const;

export const SERVER_CHOICES = {
  addServer: 'add server',
  custom: 'custom',
} as const;

export const COMMON_ACTIONS = {
  enable: 'enable',
  disable: 'disable',
} as const;

export const LSP_ACTIONS = {
  removeServer: 'remove server',
} as const;

export const MCP_ACTIONS = {
  manageAccess: 'set API key',
  removeServer: 'remove server',
} as const;

export const MCP_TRANSPORTS = {
  http: 'http',
  sse: 'sse',
  stdio: 'stdio',
} as const;

export const SKILL_CHOICES = {
  addSkill: 'add skill',
} as const;

export const SKILL_ACTIONS = {
  showInfo: 'show info',
  validate: 'validate',
  removeSkill: 'remove skill',
} as const;

export const YES_CONFIRMATION = 'yes';
