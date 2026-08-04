export type PublicVerificationCommand = 'setup' | 'up' | 'seed' | 'test' | 'login-return-to' | 'login-return-to-list' | 'public-routes' | 'public-routes-list' | 'reset' | 'down' | 'purge' | 'status';
const PUBLIC_COMMANDS = new Set<PublicVerificationCommand>(['setup', 'up', 'seed', 'test', 'login-return-to', 'login-return-to-list', 'public-routes', 'public-routes-list', 'reset', 'down', 'purge', 'status']);
export const resolvePublicCommand = (value: string | undefined): PublicVerificationCommand | null =>
  value && PUBLIC_COMMANDS.has(value as PublicVerificationCommand) ? value as PublicVerificationCommand : null;
