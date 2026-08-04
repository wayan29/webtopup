import { FastifyReply, FastifyRequest } from 'fastify';
import { Settings } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';

type MarginTier = 'basic' | 'gold' | 'platinum';

interface MarginAuditUser {
    id: string;
    email: string;
    role: string;
}

interface MarginMeta {
    updatedAt: string | null;
    updatedBy: MarginAuditUser | null;
}

interface NormalizedMarginSetting {
    basic: number;
    gold: number;
    platinum: number;
    note: string;
    meta: MarginMeta;
}

class MarginControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const DEFAULT_MARGINS = {
    basic: 10,
    gold: 5,
    platinum: 0
} satisfies Record<MarginTier, number>;

const MAX_MARGIN_PERCENT = 500;
const MAX_NOTE_LENGTH = 500;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizeStoredMarginValue = (value: unknown, fallback: number) => {
    const normalized = Number(value);

    if (!Number.isFinite(normalized) || normalized < 0 || normalized > MAX_MARGIN_PERCENT) {
        return fallback;
    }

    return normalized;
};

const normalizeMarginInput = (value: unknown, label: string) => {
    const normalized = Number(value);

    if (!Number.isFinite(normalized)) {
        throw new MarginControllerError(400, `${label} harus berupa angka yang valid`);
    }

    if (normalized < 0) {
        throw new MarginControllerError(400, `${label} tidak boleh negatif`);
    }

    if (normalized > MAX_MARGIN_PERCENT) {
        throw new MarginControllerError(400, `${label} tidak boleh lebih dari ${MAX_MARGIN_PERCENT}%`);
    }

    return normalized;
};

const normalizeNote = (value: unknown, fallback = '') => {
    const normalized = normalizeText(value ?? fallback);

    if (normalized.length > MAX_NOTE_LENGTH) {
        throw new MarginControllerError(400, `Catatan tidak boleh lebih dari ${MAX_NOTE_LENGTH} karakter`);
    }

    return normalized;
};

const normalizeAuditUser = (value: unknown): MarginAuditUser | null => {
    if (!isRecord(value)) {
        return null;
    }

    const id = normalizeText(value.id);
    const email = normalizeText(value.email);
    const role = normalizeText(value.role);

    if (!id || !email || !role) {
        return null;
    }

    return { id, email, role };
};

const normalizeMarginSetting = (setting: { value?: unknown; updatedAt?: Date } | null): NormalizedMarginSetting => {
    const rawValue = isRecord(setting?.value) ? setting?.value : {};
    const basic = normalizeStoredMarginValue(rawValue.basic, DEFAULT_MARGINS.basic);
    const gold = normalizeStoredMarginValue(rawValue.gold, DEFAULT_MARGINS.gold);
    const platinum = normalizeStoredMarginValue(rawValue.platinum, DEFAULT_MARGINS.platinum);
    const note = normalizeText(rawValue.note);
    const updatedAt = normalizeText(rawValue.updatedAt) || (setting?.updatedAt ? setting.updatedAt.toISOString() : null);
    const updatedBy = normalizeAuditUser(rawValue.updatedBy);

    return {
        basic,
        gold,
        platinum,
        note,
        meta: {
            updatedAt,
            updatedBy
        }
    };
};

const formatMarginResponse = (setting: NormalizedMarginSetting) => ({
    success: true,
    data: {
        basic: setting.basic,
        gold: setting.gold,
        platinum: setting.platinum,
        note: setting.note
    },
    meta: setting.meta,
    limits: {
        maxPercent: MAX_MARGIN_PERCENT,
        tiers: Object.keys(DEFAULT_MARGINS)
    }
});

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof MarginControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

export const getMargins = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const setting = await Settings.findOne({ key: 'margins' }).select('value updatedAt').lean();
        const normalizedSetting = normalizeMarginSetting(setting);

        return reply.send(formatMarginResponse(normalizedSetting));
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updateMargins = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const payload = request.body;
        if (!isRecord(payload)) {
            throw new MarginControllerError(400, 'Payload margin tidak valid');
        }

        const currentSetting = normalizeMarginSetting(
            await Settings.findOne({ key: 'margins' }).select('value updatedAt')
        );

        const nextSetting = {
            basic: Object.prototype.hasOwnProperty.call(payload, 'basic')
                ? normalizeMarginInput(payload.basic, 'Margin Basic')
                : currentSetting.basic,
            gold: Object.prototype.hasOwnProperty.call(payload, 'gold')
                ? normalizeMarginInput(payload.gold, 'Margin Gold')
                : currentSetting.gold,
            platinum: Object.prototype.hasOwnProperty.call(payload, 'platinum')
                ? normalizeMarginInput(payload.platinum, 'Margin Platinum')
                : currentSetting.platinum,
            note: Object.prototype.hasOwnProperty.call(payload, 'note')
                ? normalizeNote(payload.note)
                : currentSetting.note,
            updatedAt: new Date().toISOString(),
            updatedBy: request.user
                ? {
                    id: request.user.id,
                    email: request.user.email,
                    role: request.user.role
                }
                : null
        };

        const savedSetting = await Settings.findOneAndUpdate(
            { key: 'margins' },
            {
                $set: {
                    key: 'margins',
                    value: nextSetting,
                    description: 'Global membership product margins'
                }
            },
            {
                new: true,
                upsert: true
            }
        ).select('value updatedAt');

        return reply.send({
            message: 'Margin updated successfully',
            ...formatMarginResponse(normalizeMarginSetting(savedSetting))
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
