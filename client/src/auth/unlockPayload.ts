export function buildUnlockPayload(password: string, otp?: string): {
    password: string;
    otpCode?: string;
} {
    const otpCode = otp?.trim().replace(/\s+/g, '');
    return {
        password,
        ...(otpCode ? { otpCode } : {}),
    };
}
