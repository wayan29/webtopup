type AckIdentity = { userId: string; sessionId: string };
type AckLog = { warn(details: Record<string, unknown>, message: string): void };

type AckState = { state: 'in-flight' | 'succeeded'; expiresAt: number };
const acknowledgments = new Map<string, AckState>();
const MAX_ACKNOWLEDGMENTS = 128;
const SUCCESS_TTL_MS = 10 * 60 * 1000;

function prune(now: number) {
    for (const [key, value] of acknowledgments) {
        if (value.expiresAt <= now) acknowledgments.delete(key);
    }
}

export const scheduleLegacyMigrationAcknowledgment = (
    identity: AckIdentity,
    log: AckLog,
    send: (identity: AckIdentity) => Promise<void> = sendAcknowledgment,
    now: () => number = Date.now
) => {
    const timestamp = now();
    prune(timestamp);
    const key = `${identity.userId}:${identity.sessionId}`;
    if (acknowledgments.has(key) || acknowledgments.size >= MAX_ACKNOWLEDGMENTS) return;
    acknowledgments.set(key, { state: 'in-flight', expiresAt: timestamp + SUCCESS_TTL_MS });
    void send(identity).then(() => {
        // Retain local success so every protected request does not repeat the network proof.
        acknowledgments.set(key, { state: 'succeeded', expiresAt: now() + SUCCESS_TTL_MS });
    }).catch((error: unknown) => {
        // A failed proof remains retryable on the next authenticated request.
        acknowledgments.delete(key);
        log.warn({ reason: error instanceof Error ? error.name.slice(0, 64) : 'unknown' }, 'legacy migration acknowledgment failed');
    });
};

async function sendAcknowledgment(identity: AckIdentity) {
    const secret = process.env.API_V2_PROXY_SECRET?.trim();
    if (!secret || secret.length < 32) return;
    const upstream = (process.env.API_V2_UPSTREAM_URL?.trim() || 'http://127.0.0.1:9010').replace(/\/+$/, '');
    const response = await fetch(`${upstream}/v2/internal/auth/legacy-migration/acknowledge`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-v2-proxy-secret': secret,
            'x-webtopup-user-id': identity.userId,
            'x-webtopup-session-id': identity.sessionId,
        },
        body: JSON.stringify(identity),
        redirect: 'manual',
    });
    if (!response.ok && response.status !== 401) throw new Error(`ack-${response.status}`);
}
