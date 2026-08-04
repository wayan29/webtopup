import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import PaymentCategory from '../models/PaymentCategory';
import { PaymentMethod } from '../models';

type CategoryStatus = 'active' | 'inactive';

class HttpError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const isCategoryStatus = (value: unknown): value is CategoryStatus =>
    value === 'active' || value === 'inactive';

const normalizeName = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';

const normalizeIcon = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';

const slugify = (value: string) =>
    value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/(^-|-$)/g, '');

const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof HttpError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const buildCategoryPayload = (
    payload: Record<string, unknown>,
    current?: {
        name: string;
        slug: string;
        icon?: string;
        status: CategoryStatus;
    }
) => {
    const name = normalizeName(payload.name ?? current?.name);
    const providedSlug =
        payload.slug === undefined ? undefined : normalizeName(payload.slug);
    const icon = normalizeIcon(payload.icon ?? current?.icon ?? '');
    const status = (payload.status ?? current?.status ?? 'active') as CategoryStatus;

    if (!name) {
        throw new HttpError(400, 'Nama kategori wajib diisi');
    }

    if (!isCategoryStatus(status)) {
        throw new HttpError(400, 'Status kategori tidak valid');
    }

    const slugCandidate = providedSlug === undefined
        ? (payload.name !== undefined ? name : current?.slug ?? name)
        : (providedSlug || name);
    const slug = slugify(slugCandidate);

    if (!slug) {
        throw new HttpError(400, 'Slug kategori tidak valid');
    }

    return {
        name,
        slug,
        icon,
        status
    };
};

const findDuplicateCategory = async (name: string, slug: string, excludeId?: string) => {
    const query: Record<string, unknown> = {
        $or: [
            { slug },
            { name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' } }
        ]
    };

    if (excludeId) {
        query._id = { $ne: excludeId };
    }

    return PaymentCategory.findOne(query).lean();
};

const getMethodStatsByCategory = async () => {
    const stats = await PaymentMethod.aggregate([
        {
            $match: {
                category: { $type: 'objectId' }
            }
        },
        {
            $group: {
                _id: '$category',
                methodCount: { $sum: 1 },
                activeMethodCount: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'active'] }, 1, 0]
                    }
                },
                inactiveMethodCount: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0]
                    }
                }
            }
        }
    ]);

    return new Map(
        stats.map((item) => [item._id.toString(), item])
    );
};

export const getPaymentCategories = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const [categories, methodStatsMap] = await Promise.all([
            PaymentCategory.find().sort({ order: 1, createdAt: -1 }).lean(),
            getMethodStatsByCategory()
        ]);

        const categoriesWithStats = categories.map((category) => {
            const stats = methodStatsMap.get(category._id.toString());
            const methodCount = Number(stats?.methodCount ?? 0);

            return {
                ...category,
                methodCount,
                activeMethodCount: Number(stats?.activeMethodCount ?? 0),
                inactiveMethodCount: Number(stats?.inactiveMethodCount ?? 0),
                canDelete: methodCount === 0,
                deleteBlockedReason: methodCount > 0
                    ? `Kategori masih dipakai oleh ${methodCount} metode pembayaran.`
                    : ''
            };
        });

        return reply.send(categoriesWithStats);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getActivePaymentCategories = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const categories = await PaymentCategory.find({ status: 'active' }).sort({ order: 1, createdAt: -1 });
        return reply.send(categories);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const createPaymentCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const data = request.body as Record<string, unknown>;
        const payload = buildCategoryPayload(data);

        const existing = await findDuplicateCategory(payload.name, payload.slug);
        if (existing) {
            throw new HttpError(400, 'Kategori dengan nama atau slug tersebut sudah ada');
        }

        const maxOrder = await PaymentCategory.findOne().sort({ order: -1 }).select('order').lean();

        const category = await PaymentCategory.create({
            ...payload,
            order: typeof data.order === 'number' && data.order > 0
                ? Math.floor(data.order)
                : (maxOrder?.order ?? 0) + 1
        });

        return reply.status(201).send({ message: 'Payment category created', category });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updatePaymentCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new HttpError(400, 'ID kategori tidak valid');
        }

        const currentCategory = await PaymentCategory.findById(id).lean();
        if (!currentCategory) {
            return reply.status(404).send({ message: 'Payment category not found' });
        }

        const data = request.body as Record<string, unknown>;
        const payload = buildCategoryPayload(data, currentCategory as any);

        const existing = await findDuplicateCategory(payload.name, payload.slug, id);
        if (existing) {
            throw new HttpError(400, 'Kategori dengan nama atau slug tersebut sudah ada');
        }

        const category = await PaymentCategory.findByIdAndUpdate(
            id,
            {
                $set: {
                    ...payload,
                    ...(typeof data.order === 'number' && data.order > 0
                        ? { order: Math.floor(data.order) }
                        : {})
                }
            },
            { new: true }
        );

        return reply.send({ message: 'Payment category updated', category });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const deletePaymentCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new HttpError(400, 'ID kategori tidak valid');
        }

        const category = await PaymentCategory.findById(id).lean();
        if (!category) {
            return reply.status(404).send({ message: 'Payment category not found' });
        }

        const methodCount = await PaymentMethod.countDocuments({ category: id });
        if (methodCount > 0) {
            throw new HttpError(
                400,
                `Kategori "${category.name}" masih dipakai oleh ${methodCount} metode pembayaran dan tidak bisa dihapus.`
            );
        }

        await PaymentCategory.findByIdAndDelete(id);

        return reply.send({ message: 'Payment category deleted' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const reorderPaymentCategories = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { orders } = request.body as { orders?: { id: string; order: number }[] };

        if (!Array.isArray(orders) || orders.length === 0) {
            throw new HttpError(400, 'Payload reorder tidak valid');
        }

        const seenIds = new Set<string>();
        const normalizedOrders = orders.map((item) => {
            if (!item || typeof item.id !== 'string' || !mongoose.Types.ObjectId.isValid(item.id)) {
                throw new HttpError(400, 'Ada ID kategori yang tidak valid pada payload reorder');
            }

            if (seenIds.has(item.id)) {
                throw new HttpError(400, 'Payload reorder mengandung ID kategori duplikat');
            }

            if (!Number.isInteger(item.order) || item.order < 1) {
                throw new HttpError(400, 'Urutan kategori harus berupa bilangan bulat positif');
            }

            seenIds.add(item.id);
            return {
                id: item.id,
                order: item.order
            };
        });

        const categoryCount = await PaymentCategory.countDocuments({
            _id: { $in: normalizedOrders.map((item) => item.id) }
        });

        if (categoryCount !== normalizedOrders.length) {
            throw new HttpError(400, 'Ada kategori yang tidak ditemukan saat reorder');
        }

        await PaymentCategory.bulkWrite(
            normalizedOrders.map((item) => ({
                updateOne: {
                    filter: { _id: item.id },
                    update: { $set: { order: item.order } }
                }
            }))
        );

        return reply.send({ message: 'Order updated successfully' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
