const HOST_PATTERN = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|0\.0\.0\.0|::)$/u;

export function resolveServerHost(env: NodeJS.ProcessEnv): string {
    if (!Object.prototype.hasOwnProperty.call(env, 'HOST')) return '0.0.0.0';
    const host = env.HOST?.trim();
    if (!host || !HOST_PATTERN.test(host)) throw new Error('HOST must be a valid IP address or localhost');
    return host;
}
