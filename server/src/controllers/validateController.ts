import { FastifyRequest, FastifyReply } from 'fastify';
import { getRequestClientIp } from '../utils/requestIp';

interface ValidateFreeFireBody {
    userId: string;
}

interface ValidateMobileLegendsBody {
    userId: string;
    zoneId: string;
}

interface CheckOperatorBody {
    phoneNumber: string;
}

interface OperatorInfo {
    name: string;
    prefixes: string[];
    color: string;
}

interface OperatorResult {
    success: boolean;
    phoneNumber: string;
    originalNumber: string;
    operator?: string;
    prefix?: string;
    color?: string;
}

interface NicknameResult {
    isSuccess: boolean;
    nickname?: string;
    message?: string;
    rawResponse?: any;
}

type ValidationKind = 'freefire' | 'mobilelegends' | 'operator';

interface ValidationPayload {
    success: boolean;
    message: string;
    data?: Record<string, unknown>;
}

interface CachedValidationResponse {
    expiresAt: number;
    statusCode: number;
    payload: ValidationPayload;
}

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

interface ProviderJsonResult {
    ok: boolean;
    status: number;
    data: any;
}

const PROVIDER_TIMEOUT_MS = 8000;
const SUCCESS_CACHE_TTL_MS = 30_000;
const FAILURE_CACHE_TTL_MS = 10_000;

const RATE_LIMIT_RULES: Record<ValidationKind, { windowMs: number; max: number }> = {
    freefire: { windowMs: 60_000, max: 20 },
    mobilelegends: { windowMs: 60_000, max: 20 },
    operator: { windowMs: 60_000, max: 90 }
};

const validationCache = new Map<string, CachedValidationResponse>();
const validationRateLimits = new Map<string, RateLimitEntry>();

const pruneValidationStores = () => {
    const now = Date.now();

    for (const [key, entry] of validationCache.entries()) {
        if (entry.expiresAt <= now) {
            validationCache.delete(key);
        }
    }

    for (const [key, entry] of validationRateLimits.entries()) {
        if (entry.resetAt <= now) {
            validationRateLimits.delete(key);
        }
    }
};

const getClientIdentifier = (request: FastifyRequest, kind: ValidationKind) => {
    const ip = getRequestClientIp(request) || 'unknown';
    return `${kind}:${ip}`;
};

const consumeValidationQuota = (request: FastifyRequest, kind: ValidationKind) => {
    pruneValidationStores();

    const rule = RATE_LIMIT_RULES[kind];
    const key = getClientIdentifier(request, kind);
    const now = Date.now();
    const current = validationRateLimits.get(key);

    if (!current || current.resetAt <= now) {
        validationRateLimits.set(key, {
            count: 1,
            resetAt: now + rule.windowMs
        });
        return 0;
    }

    if (current.count >= rule.max) {
        return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    }

    current.count += 1;
    validationRateLimits.set(key, current);
    return 0;
};

const getCachedValidation = (cacheKey: string) => {
    pruneValidationStores();

    const cached = validationCache.get(cacheKey);
    if (!cached) {
        return null;
    }

    if (cached.expiresAt <= Date.now()) {
        validationCache.delete(cacheKey);
        return null;
    }

    return cached;
};

const setCachedValidation = (cacheKey: string, statusCode: number, payload: ValidationPayload) => {
    const ttl = statusCode >= 400 ? FAILURE_CACHE_TTL_MS : SUCCESS_CACHE_TTL_MS;

    validationCache.set(cacheKey, {
        expiresAt: Date.now() + ttl,
        statusCode,
        payload
    });
};

const sendValidationPayload = (
    reply: FastifyReply,
    cacheKey: string,
    statusCode: number,
    payload: ValidationPayload
) => {
    if (statusCode < 500 && statusCode !== 429) {
        setCachedValidation(cacheKey, statusCode, payload);
    }

    return reply.status(statusCode).send(payload);
};

const buildGameCacheKey = (kind: 'freefire' | 'mobilelegends', userId: string, zoneId?: string) =>
    `${kind}:${userId}:${zoneId || ''}`;

const buildOperatorCacheKey = (phoneNumber: string) => `operator:${phoneNumber}`;

const buildRateLimitMessage = (retryAfterSeconds: number) =>
    `Terlalu banyak permintaan validasi. Coba lagi dalam ${retryAfterSeconds} detik.`;

const normalizeDigitInput = (
    value: string | undefined,
    label: string,
    minLength: number,
    maxLength: number
) => {
    const normalized = typeof value === 'string' ? value.trim().replace(/\D/g, '') : '';

    if (!normalized) {
        return { message: `${label} harus diisi` };
    }

    if (normalized.length < minLength || normalized.length > maxLength) {
        return { message: `${label} harus ${minLength}-${maxLength} digit` };
    }

    return { value: normalized };
};

const normalizePhoneInput = (value: string | undefined) => {
    const original = typeof value === 'string' ? value.trim() : '';

    if (!original) {
        return { message: 'Nomor HP harus diisi' };
    }

    let normalized = original.replace(/\D/g, '');

    if (normalized.startsWith('62')) {
        normalized = `0${normalized.slice(2)}`;
    } else if (normalized.startsWith('8')) {
        normalized = `0${normalized}`;
    }

    if (!/^0\d+$/.test(normalized)) {
        return { message: 'Nomor HP harus diawali 08, +62, atau 62' };
    }

    if (normalized.length < 10 || normalized.length > 15) {
        return { message: 'Nomor HP harus 10-15 digit' };
    }

    return {
        value: normalized,
        original
    };
};

async function fetchJsonWithTimeout(
    url: string,
    init: RequestInit,
    providerName: string
): Promise<ProviderJsonResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal
        });

        const rawBody = await response.text();
        let data: any = null;

        if (rawBody) {
            try {
                data = JSON.parse(rawBody);
            } catch {
                throw new Error(`${providerName} mengembalikan response tidak valid`);
            }
        }

        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`${providerName} timeout`);
        }

        throw error instanceof Error ? error : new Error(`Gagal menghubungi ${providerName}`);
    } finally {
        clearTimeout(timeout);
    }
}

// GoPay API Fallback for Free Fire
async function inquireFFViaGoPay(userId: string): Promise<NicknameResult> {
    console.log('Codashop did not return nickname, trying GoPay API fallback for Free Fire...');
    const goPayApiUrl = `https://gopay.co.id/games/v1/order/prepare/FREEFIRE?userId=${encodeURIComponent(userId)}&zoneId=`;

    try {
        const { ok, data: responseData } = await fetchJsonWithTimeout(goPayApiUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
            }
        }, 'GoPay Free Fire');

        if (ok && responseData?.message?.toLowerCase() === 'success' && typeof responseData?.data === 'string') {
            return {
                isSuccess: true,
                nickname: responseData.data,
                message: 'Nickname found.',
                rawResponse: responseData
            };
        }

        console.error('GoPay API Fallback Failed (FF):', responseData);
        return {
            isSuccess: false,
            message: responseData?.message || 'Invalid User ID or unknown error.',
            rawResponse: responseData
        };
    } catch (error) {
        console.error('Error during GoPay API fallback request (FF):', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during GoPay fallback.';
        return {
            isSuccess: false,
            message: `Service error: ${errorMessage}`
        };
    }
}

// Main Free Fire nickname inquiry function
async function inquireFreeFireNickname(userId: string): Promise<NicknameResult> {
    const codashopApiUrl = 'https://order-sg.codashop.com/initPayment.action';
    const datePart = new Date().toLocaleDateString('en-CA');
    const randomPart = Math.floor(Math.random() * 1000);
    const nonce = `${datePart.replace(/-/g, '/')}-${randomPart}`;

    const postData = {
        'voucherPricePoint.id': 8120,
        'voucherPricePoint.price': 50000.0,
        'voucherPricePoint.variablePrice': 0,
        n: nonce,
        email: '',
        userVariablePrice: 0,
        'order.data.profile': 'eyJuYW1lIjoiICIsImRhdGVvZmJpcnRoIjoiIiwiaWRfbm8iOiIifQ==',
        'user.userId': userId,
        'user.zoneId': '',
        msisdn: '',
        voucherTypeName: 'FREEFIRE',
        shopLang: 'id_ID',
        voucherTypeId: 17,
        gvtId: 33,
        checkoutId: '',
        affiliateTrackingId: '',
        impactClickId: '',
        anonymousId: ''
    };

    try {
        const { ok, data: responseData } = await fetchJsonWithTimeout(codashopApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://www.codashop.com',
                Referer: 'https://www.codashop.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36'
            },
            body: JSON.stringify(postData)
        }, 'Codashop Free Fire');

        if (!ok) {
            console.error('Codashop API HTTP error response (FF Nickname):', responseData);
            return await inquireFFViaGoPay(userId);
        }

        if (responseData?.RESULT_CODE === '10001' || responseData?.resultCode === '10001') {
            return {
                isSuccess: false,
                message: 'Too many attempts. Please wait and try again.',
                rawResponse: responseData
            };
        }

        if (responseData?.success && !responseData?.errorMsg) {
            let extractedNickname: string | undefined;

            if (responseData.result && typeof responseData.result === 'string') {
                try {
                    const decodedResultString = decodeURIComponent(responseData.result);
                    const resultData = JSON.parse(decodedResultString);

                    if (resultData.roles && resultData.roles[0] && resultData.roles[0].role) {
                        extractedNickname = decodeURIComponent(resultData.roles[0].role as string);
                    } else if (resultData.username) {
                        extractedNickname = decodeURIComponent(resultData.username as string);
                    }
                } catch (error) {
                    console.warn("Could not parse nickname from 'result' field:", error);
                }
            }

            if (!extractedNickname && responseData.confirmationFields?.roles?.[0]?.role) {
                extractedNickname = decodeURIComponent(responseData.confirmationFields.roles[0].role as string);
            }

            if (!extractedNickname && responseData.confirmationFields?.username) {
                extractedNickname = decodeURIComponent(responseData.confirmationFields.username as string);
            }

            if (extractedNickname) {
                return {
                    isSuccess: true,
                    nickname: extractedNickname,
                    message: 'Nickname inquiry successful.',
                    rawResponse: responseData
                };
            }

            return await inquireFFViaGoPay(userId);
        }

        console.error('Codashop API returned an error (FF Nickname):', responseData);
        if (responseData?.errorMsg) {
            return {
                isSuccess: false,
                message: responseData.errorMsg,
                rawResponse: responseData
            };
        }

        return await inquireFFViaGoPay(userId);
    } catch (error) {
        console.error('Error during Free Fire nickname inquiry (Codashop):', error);
        console.log('Trying GoPay fallback due to Codashop client-side error.');
        return await inquireFFViaGoPay(userId);
    }
}

// GoPay API Fallback for Mobile Legends
async function inquireMLViaGoPay(userId: string, zoneId: string): Promise<NicknameResult> {
    console.log('Codashop did not return nickname, trying GoPay API fallback for Mobile Legends...');
    const goPayApiUrl = 'https://gopay.co.id/games/v1/order/user-account';
    const payload = {
        code: 'MOBILE_LEGENDS',
        data: { userId, zoneId }
    };

    try {
        const { ok, data: responseData } = await fetchJsonWithTimeout(goPayApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(payload)
        }, 'GoPay Mobile Legends');

        if (ok && responseData?.message?.toLowerCase() === 'success' && responseData?.data?.username) {
            return {
                isSuccess: true,
                nickname: responseData.data.username,
                message: 'Nickname found.',
                rawResponse: responseData
            };
        }

        console.error('GoPay API Fallback Failed (ML):', responseData);
        return {
            isSuccess: false,
            message: responseData?.message || 'Invalid User ID/Zone ID or unknown error.',
            rawResponse: responseData
        };
    } catch (error) {
        console.error('Error during GoPay API fallback request (ML):', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during GoPay fallback.';
        return {
            isSuccess: false,
            message: `Service error: ${errorMessage}`
        };
    }
}

// Main Mobile Legends nickname inquiry function
async function inquireMobileLegendsNickname(userId: string, zoneId: string): Promise<NicknameResult> {
    const codashopApiUrl = 'https://order-sg.codashop.com/initPayment.action';
    const datePart = new Date().toLocaleDateString('en-CA');
    const randomPart = Math.floor(Math.random() * 1000);
    const nonce = `${datePart.replace(/-/g, '/')}-${randomPart}`;

    const postData = {
        'voucherPricePoint.id': 1471,
        'voucherPricePoint.price': 84360.0,
        'voucherPricePoint.variablePrice': 0,
        n: nonce,
        email: '',
        userVariablePrice: 0,
        'order.data.profile': 'eyJuYW1lIjoiICIsImRhdGVvZmJpcnRoIjoiIiwiaWRfbm8iOiIifQ==',
        'user.userId': userId,
        'user.zoneId': zoneId,
        msisdn: '',
        voucherTypeName: 'MOBILE_LEGENDS',
        shopLang: 'id_ID',
        voucherTypeId: 5,
        gvtId: 19,
        checkoutId: '',
        affiliateTrackingId: '',
        impactClickId: '',
        anonymousId: ''
    };

    try {
        const { ok, data: responseData } = await fetchJsonWithTimeout(codashopApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://www.codashop.com',
                Referer: 'https://www.codashop.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36'
            },
            body: JSON.stringify(postData)
        }, 'Codashop Mobile Legends');

        if (!ok) {
            console.error('Codashop API HTTP error response (ML Nickname):', responseData);
            return await inquireMLViaGoPay(userId, zoneId);
        }

        if (responseData?.RESULT_CODE === '10001' || responseData?.resultCode === '10001') {
            return {
                isSuccess: false,
                message: 'Too many attempts. Please wait and try again.',
                rawResponse: responseData
            };
        }

        if (responseData?.success && !responseData?.errorMsg) {
            let extractedNickname: string | undefined;

            if (responseData.confirmationFields?.username) {
                extractedNickname = decodeURIComponent(responseData.confirmationFields.username as string);
            }

            if (!extractedNickname && responseData.result && typeof responseData.result === 'string') {
                try {
                    const decodedResultString = decodeURIComponent(responseData.result);
                    const resultData = JSON.parse(decodedResultString);

                    if (resultData.username) {
                        extractedNickname = decodeURIComponent(resultData.username as string);
                    } else if (resultData.roles && resultData.roles[0] && resultData.roles[0].role) {
                        extractedNickname = decodeURIComponent(resultData.roles[0].role as string);
                    }
                } catch (error) {
                    console.warn("Could not parse nickname from 'result' field for ML:", error);
                }
            }

            if (extractedNickname) {
                return {
                    isSuccess: true,
                    nickname: extractedNickname,
                    message: 'Nickname inquiry successful.',
                    rawResponse: responseData
                };
            }

            return await inquireMLViaGoPay(userId, zoneId);
        }

        console.error('Codashop API returned an error (ML Nickname):', responseData);
        if (responseData?.errorMsg) {
            return {
                isSuccess: false,
                message: responseData.errorMsg,
                rawResponse: responseData
            };
        }

        return await inquireMLViaGoPay(userId, zoneId);
    } catch (error) {
        console.error('Error during Mobile Legends nickname inquiry (Codashop):', error);
        console.log('Trying GoPay fallback due to Codashop client-side error.');
        return await inquireMLViaGoPay(userId, zoneId);
    }
}

export const validateFreeFire = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { userId } = request.body as ValidateFreeFireBody;
        const normalizedUserId = normalizeDigitInput(userId, 'User ID', 5, 20);

        if (!normalizedUserId.value) {
            return reply.status(400).send({
                success: false,
                message: normalizedUserId.message
            });
        }

        const cacheKey = buildGameCacheKey('freefire', normalizedUserId.value);
        const cached = getCachedValidation(cacheKey);
        if (cached) {
            return reply.status(cached.statusCode).send(cached.payload);
        }

        const retryAfterSeconds = consumeValidationQuota(request, 'freefire');
        if (retryAfterSeconds > 0) {
            return reply.status(429).send({
                success: false,
                message: buildRateLimitMessage(retryAfterSeconds)
            });
        }

        const result = await inquireFreeFireNickname(normalizedUserId.value);

        if (result.isSuccess) {
            return sendValidationPayload(reply, cacheKey, 200, {
                success: true,
                data: {
                    userId: normalizedUserId.value,
                    nickname: result.nickname
                },
                message: result.message || 'Nickname berhasil ditemukan'
            });
        }

        return sendValidationPayload(reply, cacheKey, 400, {
            success: false,
            message: result.message || 'User ID tidak ditemukan'
        });
    } catch (error) {
        console.error('Validate Free Fire Error:', error);
        return reply.status(500).send({
            success: false,
            message: 'Internal Server Error'
        });
    }
};

export const validateMobileLegends = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { userId, zoneId } = request.body as ValidateMobileLegendsBody;
        const normalizedUserId = normalizeDigitInput(userId, 'User ID', 5, 20);
        const normalizedZoneId = normalizeDigitInput(zoneId, 'Zone ID', 1, 10);

        if (!normalizedUserId.value) {
            return reply.status(400).send({
                success: false,
                message: normalizedUserId.message
            });
        }

        if (!normalizedZoneId.value) {
            return reply.status(400).send({
                success: false,
                message: normalizedZoneId.message
            });
        }

        const cacheKey = buildGameCacheKey('mobilelegends', normalizedUserId.value, normalizedZoneId.value);
        const cached = getCachedValidation(cacheKey);
        if (cached) {
            return reply.status(cached.statusCode).send(cached.payload);
        }

        const retryAfterSeconds = consumeValidationQuota(request, 'mobilelegends');
        if (retryAfterSeconds > 0) {
            return reply.status(429).send({
                success: false,
                message: buildRateLimitMessage(retryAfterSeconds)
            });
        }

        const result = await inquireMobileLegendsNickname(normalizedUserId.value, normalizedZoneId.value);

        if (result.isSuccess) {
            return sendValidationPayload(reply, cacheKey, 200, {
                success: true,
                data: {
                    userId: normalizedUserId.value,
                    zoneId: normalizedZoneId.value,
                    nickname: result.nickname
                },
                message: result.message || 'Nickname berhasil ditemukan'
            });
        }

        return sendValidationPayload(reply, cacheKey, 400, {
            success: false,
            message: result.message || 'User ID/Zone ID tidak ditemukan'
        });
    } catch (error) {
        console.error('Validate Mobile Legends Error:', error);
        return reply.status(500).send({
            success: false,
            message: 'Internal Server Error'
        });
    }
};

// Check Operator Function
function checkOperator(normalizedNumber: string, originalNumber: string): OperatorResult {
    const operators: Record<string, OperatorInfo> = {
        telkomsel: {
            name: 'Telkomsel',
            prefixes: ['0811', '0812', '0813', '0821', '0822', '0823', '0852', '0853', '0851'],
            color: 'red'
        },
        indosat: {
            name: 'Indosat Ooredoo',
            prefixes: ['0814', '0815', '0816', '0855', '0856', '0857', '0858'],
            color: 'yellow'
        },
        xl: {
            name: 'XL Axiata',
            prefixes: ['0859', '0877', '0878', '0817', '0818', '0819'],
            color: 'blue'
        },
        tri: {
            name: '3 (Tri)',
            prefixes: ['0898', '0899', '0895', '0896', '0897'],
            color: 'gray'
        },
        smartfren: {
            name: 'Smartfren',
            prefixes: ['0889', '0881', '0882', '0883', '0886', '0887', '0888', '0884', '0885'],
            color: 'purple'
        },
        axis: {
            name: 'Axis',
            prefixes: ['0832', '0833', '0838', '0831'],
            color: 'green'
        }
    };

    const prefix = normalizedNumber.substring(0, 4);

    for (const [, operator] of Object.entries(operators)) {
        if (operator.prefixes.includes(prefix)) {
            return {
                success: true,
                phoneNumber: normalizedNumber,
                originalNumber,
                operator: operator.name,
                prefix,
                color: operator.color
            };
        }
    }

    return {
        success: false,
        phoneNumber: normalizedNumber,
        originalNumber
    };
}

export const validateOperator = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { phoneNumber } = request.body as CheckOperatorBody;
        const normalizedPhone = normalizePhoneInput(phoneNumber);

        if (!normalizedPhone.value) {
            return reply.status(400).send({
                success: false,
                message: normalizedPhone.message
            });
        }

        const cacheKey = buildOperatorCacheKey(normalizedPhone.value);
        const cached = getCachedValidation(cacheKey);
        if (cached) {
            return reply.status(cached.statusCode).send(cached.payload);
        }

        const retryAfterSeconds = consumeValidationQuota(request, 'operator');
        if (retryAfterSeconds > 0) {
            return reply.status(429).send({
                success: false,
                message: buildRateLimitMessage(retryAfterSeconds)
            });
        }

        const result = checkOperator(normalizedPhone.value, normalizedPhone.original);

        if (result.success) {
            return sendValidationPayload(reply, cacheKey, 200, {
                success: true,
                data: {
                    phoneNumber: result.phoneNumber,
                    originalNumber: result.originalNumber,
                    operator: result.operator,
                    prefix: result.prefix,
                    color: result.color
                },
                message: 'Operator berhasil dideteksi'
            });
        }

        return sendValidationPayload(reply, cacheKey, 400, {
            success: false,
            data: {
                phoneNumber: result.phoneNumber,
                originalNumber: result.originalNumber
            },
            message: 'Operator tidak dapat diidentifikasi. Prefix nomor tidak terdaftar.'
        });
    } catch (error) {
        console.error('Validate Operator Error:', error);
        return reply.status(500).send({
            success: false,
            message: 'Internal Server Error'
        });
    }
};
