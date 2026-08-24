export const BOT_PROTECTION_FAILED_MESSAGE =
  'Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.';
export const BOT_PROTECTION_UNAVAILABLE_MESSAGE =
  'Verifikasi keamanan sedang tidak tersedia. Coba beberapa saat lagi.';

export function turnstileSiteKey(settings: { turnstileSiteKey?: unknown }): string | null {
  if (typeof settings.turnstileSiteKey !== 'string') return null;
  const trimmed = settings.turnstileSiteKey.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldRenderTurnstile(settings: {
  botProtectionEnabled?: unknown;
  turnstileSiteKey?: unknown;
}): settings is { botProtectionEnabled: true; turnstileSiteKey: string } {
  return settings.botProtectionEnabled === true && turnstileSiteKey(settings) !== null;
}

export function isBotProtectionResponseError(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: { message?: unknown } } } | undefined)?.response;
  const status = response?.status;
  const message = response?.data?.message;
  return (
    (status === 400 || status === 403 || status === 503)
    && (message === BOT_PROTECTION_FAILED_MESSAGE || message === BOT_PROTECTION_UNAVAILABLE_MESSAGE)
  );
}
