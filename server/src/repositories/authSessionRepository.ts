import mongoose, { Connection, Schema, Types } from 'mongoose';

export type AccessSessionProjection = Readonly<{
    sessionId: string;
    userId: string;
    role: string;
    sessionVersionAtIssue: number;
    status: string;
    absoluteExpiresAt: Date;
    idleExpiresAt?: Date;
    revokedAt?: Date;
    /**
     * Authoritative predecessor refresh generation.
     * Required for exact security-change recovery admission binding.
     */
    refreshGeneration?: number;
    /** Present when revoked by a security-change operation; used for exact recovery admission only. */
    securityChangeOperationId?: string;
}>;

export type AccessSessionLookup =
    (canonicalSid: string) => Promise<AccessSessionProjection | null>;

const ACCESS_SESSION_PROJECTION = Object.freeze({
    _id: 0,
    sessionId: 1,
    userId: 1,
    role: 1,
    sessionVersionAtIssue: 1,
    status: 1,
    absoluteExpiresAt: 1,
    idleExpiresAt: 1,
    revokedAt: 1,
    refreshGeneration: 1,
    securityChangeOperationId: 1,
});

export function createAccessSessionLookup(connection: Connection): AccessSessionLookup {
    const schema = new Schema({}, {
        collection: 'authsessions',
        strict: true,
        autoCreate: false,
        autoIndex: false,
        versionKey: false,
    });
    const model = connection.models.GatewayAccessSession
        ?? connection.model('GatewayAccessSession', schema);

    return async (canonicalSid: string) => {
        const row = await model.findOne(
            { sessionId: new Types.ObjectId(canonicalSid) },
            ACCESS_SESSION_PROJECTION
        ).lean().exec() as Record<string, unknown> | null;
        if (!row) return null;
        const objectIdString = (value: unknown) =>
            value instanceof Types.ObjectId ? value.toHexString() : String(value);
        const refreshGenerationRaw = row.refreshGeneration;
        let refreshGeneration: number | undefined;
        if (typeof refreshGenerationRaw === 'number'
            && Number.isInteger(refreshGenerationRaw)
            && refreshGenerationRaw >= 0) {
            refreshGeneration = refreshGenerationRaw;
        } else if (
            typeof refreshGenerationRaw === 'object'
            && refreshGenerationRaw !== null
            && typeof (refreshGenerationRaw as { toString?: unknown }).toString === 'function'
            && /^(?:0|[1-9]\d*)$/.test(String(refreshGenerationRaw))
        ) {
            // BSON Long / numeric-like values that serialize to a non-negative integer string.
            const asNumber = Number(String(refreshGenerationRaw));
            if (Number.isSafeInteger(asNumber) && asNumber >= 0) {
                refreshGeneration = asNumber;
            }
        }
        return Object.freeze({
            sessionId: objectIdString(row.sessionId),
            userId: objectIdString(row.userId),
            role: String(row.role),
            sessionVersionAtIssue: Number(row.sessionVersionAtIssue),
            status: String(row.status),
            absoluteExpiresAt: new Date(row.absoluteExpiresAt as Date),
            ...(row.idleExpiresAt ? { idleExpiresAt: new Date(row.idleExpiresAt as Date) } : {}),
            ...(row.revokedAt ? { revokedAt: new Date(row.revokedAt as Date) } : {}),
            ...(refreshGeneration !== undefined ? { refreshGeneration } : {}),
            ...(row.securityChangeOperationId
                ? { securityChangeOperationId: objectIdString(row.securityChangeOperationId) }
                : {}),
        });
    };
}

export const lookupAccessSession: AccessSessionLookup =
    createAccessSessionLookup(mongoose.connection);
