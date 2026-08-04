import mongoose from 'mongoose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Slider } from '../models';

class SliderControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const isSafeSliderLink = (value: string) => {
    if (!value) {
        return true;
    }

    if (value.startsWith('/')) {
        return !value.startsWith('//');
    }

    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

const ensureObjectId = (value: string, fieldLabel: string) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new SliderControllerError(400, `${fieldLabel} tidak valid`);
    }
};

const normalizeName = (value: unknown, currentName?: string) => {
    const normalized = normalizeText(value ?? currentName);

    if (!normalized) {
        throw new SliderControllerError(400, 'Nama slider wajib diisi');
    }

    return normalized;
};

const normalizeImage = (value: unknown, currentImage?: string) => {
    const normalized = normalizeText(value ?? currentImage);

    if (!normalized) {
        throw new SliderControllerError(400, 'Gambar slider wajib diisi');
    }

    return normalized;
};

const normalizeLink = (value: unknown, currentLink?: string) => {
    const normalized = normalizeText(value ?? currentLink);

    if (!normalized) {
        return '';
    }

    if (!isSafeSliderLink(normalized)) {
        throw new SliderControllerError(400, 'Link slider harus berupa URL http/https atau path internal yang diawali "/"');
    }

    return normalized;
};

const normalizeStatus = (value: unknown, fallback = true) => {
    if (typeof value === 'undefined') {
        return fallback;
    }

    if (typeof value !== 'boolean') {
        throw new SliderControllerError(400, 'Status slider tidak valid');
    }

    return value;
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof SliderControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const reindexSliderSortOrder = async () => {
    const sliders = await Slider.find()
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('_id')
        .lean();

    if (sliders.length === 0) {
        return;
    }

    await Slider.bulkWrite(
        sliders.map((slider, index) => ({
            updateOne: {
                filter: { _id: slider._id },
                update: { $set: { sortOrder: index } }
            }
        }))
    );
};

export const getSliders = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const sliders = await Slider.find({ status: true })
            .sort({ sortOrder: 1, createdAt: 1 })
            .lean();

        return reply.send(sliders);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getAllSliders = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const sliders = await Slider.find()
            .sort({ sortOrder: 1, createdAt: 1 })
            .lean();

        return reply.send(sliders);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const createSlider = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = request.body as {
            name?: string;
            image?: string;
            link?: string;
            status?: boolean;
        };

        const name = normalizeName(payload.name);
        const image = normalizeImage(payload.image);
        const link = normalizeLink(payload.link);
        const status = normalizeStatus(payload.status, true);

        const sliderCount = await Slider.countDocuments();
        const slider = await Slider.create({
            name,
            image,
            link,
            sortOrder: sliderCount,
            status
        });

        return reply.status(201).send({
            message: 'Slider created',
            slider
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updateSlider = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as {
            name?: string;
            image?: string;
            link?: string;
            status?: boolean;
        };

        ensureObjectId(id, 'ID slider');

        const slider = await Slider.findById(id);
        if (!slider) {
            return reply.status(404).send({ message: 'Slider not found' });
        }

        slider.name = normalizeName(payload.name, slider.name);
        slider.image = normalizeImage(payload.image, slider.image);
        slider.link = normalizeLink(payload.link, slider.link);
        slider.status = normalizeStatus(payload.status, slider.status);

        await slider.save();

        return reply.send({
            message: 'Slider updated',
            slider
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const deleteSlider = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        ensureObjectId(id, 'ID slider');

        const slider = await Slider.findByIdAndDelete(id);
        if (!slider) {
            return reply.status(404).send({ message: 'Slider not found' });
        }

        await reindexSliderSortOrder();

        return reply.send({ message: 'Slider deleted' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updateSortOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { orders } = request.body as { orders?: { id: string; sortOrder: number }[] };

        if (!orders || !Array.isArray(orders) || orders.length === 0) {
            throw new SliderControllerError(400, 'Payload urutan slider wajib berupa array dan tidak boleh kosong');
        }

        const allSliders = await Slider.find()
            .sort({ sortOrder: 1, createdAt: 1 })
            .select('_id')
            .lean();

        if (orders.length !== allSliders.length) {
            throw new SliderControllerError(400, 'Payload urutan slider harus mencakup seluruh slider');
        }

        const validIdSet = new Set(allSliders.map((slider) => slider._id.toString()));
        const seenIds = new Set<string>();
        const seenSortOrders = new Set<number>();

        const normalizedOrders = orders.map((item) => {
            const id = normalizeText(item?.id);
            const sortOrder = Number(item?.sortOrder);

            ensureObjectId(id, 'ID slider');

            if (!validIdSet.has(id)) {
                throw new SliderControllerError(400, 'Payload urutan slider mengandung ID yang tidak dikenal');
            }

            if (!Number.isInteger(sortOrder) || sortOrder < 0) {
                throw new SliderControllerError(400, 'Sort order slider harus berupa bilangan bulat non-negatif');
            }

            if (seenIds.has(id)) {
                throw new SliderControllerError(400, 'Payload urutan slider mengandung ID duplikat');
            }

            if (seenSortOrders.has(sortOrder)) {
                throw new SliderControllerError(400, 'Payload urutan slider mengandung sort order duplikat');
            }

            seenIds.add(id);
            seenSortOrders.add(sortOrder);

            return { id, sortOrder };
        });

        if (seenIds.size !== validIdSet.size) {
            throw new SliderControllerError(400, 'Payload urutan slider belum lengkap');
        }

        const sequentialOrders = normalizedOrders
            .sort((first, second) => first.sortOrder - second.sortOrder)
            .map((item, index) => ({
                id: item.id,
                sortOrder: index
            }));

        await Slider.bulkWrite(
            sequentialOrders.map((item) => ({
                updateOne: {
                    filter: { _id: item.id },
                    update: { $set: { sortOrder: item.sortOrder } }
                }
            }))
        );

        return reply.send({ message: 'Sort order updated' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
