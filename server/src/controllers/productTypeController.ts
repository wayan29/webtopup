import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Category, Operator, Product, ProductType } from '../models';

const slugify = (text: string): string => {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
};

const normalizeProductTypeName = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildProductTypeSlug = (name: string): string => {
    const slug = slugify(name);
    if (!slug) {
        throw new Error('INVALID_PRODUCT_TYPE_SLUG');
    }

    return slug;
};

const getProductTypeDependencies = async (productTypeId: string) => {
    const productCount = await Product.countDocuments({ productTypeId });

    return {
        productCount,
        dependencyCount: productCount,
        canDelete: productCount === 0
    };
};

const buildDependencyMessage = (productCount: number) => productCount > 0
    ? `Jenis produk masih dipakai oleh ${productCount} produk. Nonaktifkan jenis produk jika belum ingin ditampilkan.`
    : 'Jenis produk masih dipakai dan tidak dapat dihapus.';

const isEntityActive = (entity: any) => {
    if (!entity) {
        return false;
    }

    if (typeof entity.status === 'boolean') {
        return entity.status;
    }

    if (typeof entity.isActive === 'boolean') {
        return entity.isActive;
    }

    return true;
};

const isProductTypePubliclyVisible = (productType: any) => (
    isEntityActive(productType) &&
    isEntityActive(productType.categoryId) &&
    isEntityActive(productType.operatorId)
);

// Get all product types (public - active only)
export const getProductTypes = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId, operatorId } = request.query as { categoryId?: string; operatorId?: string };
        const query: any = { status: true };

        if (categoryId) query.categoryId = categoryId;
        if (operatorId) query.operatorId = operatorId;

        const productTypes = await ProductType.find(query)
            .populate('categoryId', 'name icon slug status isActive')
            .populate('operatorId', 'name icon slug status')
            .sort({ sortOrder: 1, name: 1 });

        return reply.send(productTypes.filter(isProductTypePubliclyVisible));
    } catch (error) {
        console.error('Error fetching product types:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get all product types (admin - including inactive)
export const getAllProductTypes = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId, operatorId } = request.query as { categoryId?: string; operatorId?: string };
        const query: any = {};

        if (categoryId) query.categoryId = categoryId;
        if (operatorId) query.operatorId = operatorId;

        const productTypes = await ProductType.find(query)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name icon slug status')
            .sort({ sortOrder: 1, name: 1 });

        const productCounts = await Product.aggregate([
            { $match: { productTypeId: { $exists: true, $ne: null } } },
            { $group: { _id: '$productTypeId', count: { $sum: 1 } } }
        ]);

        const productCountMap = new Map(productCounts.map(item => [item._id?.toString(), item.count]));
        const productTypesWithCount = productTypes.map((productType) => {
            const productCount = productCountMap.get(productType._id.toString()) || 0;

            return {
                ...(productType.toObject() as any),
                productCount,
                dependencyCount: productCount,
                canDelete: productCount === 0
            };
        });

        return reply.send(productTypesWithCount);
    } catch (error) {
        console.error('Error fetching all product types:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get product type by ID or slug
export const getProductTypeById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const isObjectId = mongoose.Types.ObjectId.isValid(id);

        const productType = await ProductType.findOne(isObjectId ? {
            $or: [{ _id: id }, { slug: id }]
        } : { slug: id })
        .populate('categoryId', 'name icon slug status isActive')
        .populate('operatorId', 'name icon slug status');

        if (!productType) {
            return reply.status(404).send({ message: 'Product type not found' });
        }

        const isAdminRequest = request.url.includes('/admin/');
        if (!isAdminRequest && !isProductTypePubliclyVisible(productType)) {
            return reply.status(404).send({ message: 'Product type not found' });
        }

        return reply.send(productType);
    } catch (error) {
        console.error('Error fetching product type:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Create product type
export const createProductType = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { 
            name, categoryId, operatorId, 
            icon, cover, 
            openTime, closeTime, open24Hours,
            estimatedDelivery, processType, description,
            popupInfo,
            status 
        } = request.body as any;

        const normalizedName = normalizeProductTypeName(name);
        if (!normalizedName) {
            return reply.status(400).send({ message: 'Nama jenis produk wajib diisi' });
        }

        if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
            return reply.status(400).send({ message: 'Operator jenis produk tidak valid' });
        }

        const operator = await Operator.findById(operatorId).select('name categoryId');
        if (!operator) {
            return reply.status(400).send({ message: 'Operator tidak ditemukan' });
        }

        const targetCategoryId = categoryId ? String(categoryId) : operator.categoryId.toString();
        if (!mongoose.Types.ObjectId.isValid(targetCategoryId)) {
            return reply.status(400).send({ message: 'Kategori jenis produk tidak valid' });
        }

        if (operator.categoryId.toString() !== targetCategoryId) {
            return reply.status(400).send({ message: 'Operator tidak berada di kategori yang dipilih' });
        }

        const category = await Category.findById(targetCategoryId).select('name');
        if (!category) {
            return reply.status(400).send({ message: 'Kategori jenis produk tidak ditemukan' });
        }

        let slug: string;
        try {
            slug = buildProductTypeSlug(normalizedName);
        } catch {
            return reply.status(400).send({ message: 'Nama jenis produk tidak valid untuk dijadikan slug' });
        }

        // Check if slug already exists for same operator
        const existing = await ProductType.findOne({ slug, operatorId });
        if (existing) {
            return reply.status(400).send({ message: 'Jenis produk dengan nama ini sudah ada untuk operator ini' });
        }

        // Get max sortOrder for operator
        const maxSort = await ProductType.findOne({ operatorId }).sort({ sortOrder: -1 });
        const sortOrder = maxSort ? maxSort.sortOrder + 1 : 0;

        const productType = await ProductType.create({
            name: normalizedName,
            slug,
            categoryId: targetCategoryId,
            operatorId,
            icon: icon || '',
            cover: cover || '',
            openTime: openTime || '00:00',
            closeTime: closeTime || '23:59',
            open24Hours: open24Hours !== undefined ? open24Hours : true,
            estimatedDelivery: estimatedDelivery || '',
            processType: processType || 'auto',
            description: description || '',
            popupInfo: popupInfo || {},
            sortOrder,
            status: status !== undefined ? status : true
        });

        const populated = await ProductType.findById(productType._id)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name icon slug status');

        const dependencyCounts = await getProductTypeDependencies(productType._id.toString());

        return reply.status(201).send({
            message: 'Product type created successfully',
            productType: {
                ...(populated?.toObject() as any),
                ...dependencyCounts
            }
        });
    } catch (error) {
        console.error('Error creating product type:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update product type
export const updateProductType = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const { 
            name, categoryId, operatorId, 
            icon, cover,
            openTime, closeTime, open24Hours,
            estimatedDelivery, processType, description,
            popupInfo,
            sortOrder, status 
        } = request.body as any;

        const productType = await ProductType.findById(id);
        if (!productType) {
            return reply.status(404).send({ message: 'Product type not found' });
        }

        const previousName = productType.name;
        const previousCategoryId = productType.categoryId.toString();
        const previousOperatorId = productType.operatorId.toString();
        const normalizedName = name !== undefined ? normalizeProductTypeName(name) : productType.name;

        if (!normalizedName) {
            return reply.status(400).send({ message: 'Nama jenis produk wajib diisi' });
        }

        const targetOperatorId = operatorId !== undefined ? String(operatorId) : previousOperatorId;
        if (!mongoose.Types.ObjectId.isValid(targetOperatorId)) {
            return reply.status(400).send({ message: 'Operator jenis produk tidak valid' });
        }

        const targetOperator = await Operator.findById(targetOperatorId).select('name categoryId');
        if (!targetOperator) {
            return reply.status(400).send({ message: 'Operator tidak ditemukan' });
        }

        const targetCategoryId = categoryId !== undefined ? String(categoryId) : targetOperator.categoryId.toString();
        if (!mongoose.Types.ObjectId.isValid(targetCategoryId)) {
            return reply.status(400).send({ message: 'Kategori jenis produk tidak valid' });
        }

        if (targetOperator.categoryId.toString() !== targetCategoryId) {
            return reply.status(400).send({ message: 'Operator tidak berada di kategori yang dipilih' });
        }

        const targetCategory = await Category.findById(targetCategoryId).select('name');
        if (!targetCategory) {
            return reply.status(400).send({ message: 'Kategori jenis produk tidak ditemukan' });
        }

        const targetSlug = buildProductTypeSlug(normalizedName);
        if (normalizedName !== productType.name || targetOperatorId !== previousOperatorId) {
            const existing = await ProductType.findOne({
                slug: targetSlug,
                operatorId: targetOperatorId,
                _id: { $ne: id }
            });
            if (existing) {
                return reply.status(400).send({ message: 'Jenis produk dengan nama ini sudah ada untuk operator ini' });
            }

            productType.name = normalizedName;
            productType.slug = targetSlug;
        }

        productType.categoryId = targetCategoryId as any;
        productType.operatorId = targetOperatorId as any;
        if (icon !== undefined) productType.icon = icon;
        if (cover !== undefined) productType.cover = cover;
        if (openTime !== undefined) productType.openTime = openTime;
        if (closeTime !== undefined) productType.closeTime = closeTime;
        if (open24Hours !== undefined) productType.open24Hours = open24Hours;
        if (estimatedDelivery !== undefined) productType.estimatedDelivery = estimatedDelivery;
        if (processType !== undefined) productType.processType = processType;
        if (description !== undefined) productType.description = description;
        if (popupInfo !== undefined) productType.popupInfo = popupInfo;
        if (sortOrder !== undefined) productType.sortOrder = Math.max(0, Number(sortOrder) || 0);
        if (status !== undefined) productType.status = status;

        await productType.save();

        const shouldSyncProducts = previousName !== productType.name
            || previousCategoryId !== productType.categoryId.toString()
            || previousOperatorId !== productType.operatorId.toString();

        if (shouldSyncProducts) {
            await Product.updateMany(
                { productTypeId: id },
                {
                    $set: {
                        categoryId: targetCategory._id,
                        category: targetCategory.name,
                        operatorId: targetOperator._id,
                        brand: targetOperator.name
                    }
                }
            );
        }

        const populated = await ProductType.findById(productType._id)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name icon slug status');

        const dependencyCounts = await getProductTypeDependencies(productType._id.toString());

        return reply.send({
            message: 'Product type updated successfully',
            productType: {
                ...(populated?.toObject() as any),
                ...dependencyCounts
            }
        });
    } catch (error) {
        if ((error as Error).message === 'INVALID_PRODUCT_TYPE_SLUG') {
            return reply.status(400).send({ message: 'Nama jenis produk tidak valid untuk dijadikan slug' });
        }
        console.error('Error updating product type:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Delete product type
export const deleteProductType = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const productType = await ProductType.findById(id);
        if (!productType) {
            return reply.status(404).send({ message: 'Product type not found' });
        }

        const dependencyCounts = await getProductTypeDependencies(productType._id.toString());
        if (!dependencyCounts.canDelete) {
            return reply.status(400).send({
                message: buildDependencyMessage(dependencyCounts.productCount),
                dependencies: dependencyCounts
            });
        }

        await productType.deleteOne();

        return reply.send({ message: 'Product type deleted successfully' });
    } catch (error) {
        console.error('Error deleting product type:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update sort order (bulk)
export const updateSortOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { operatorId, orders } = request.body as { operatorId?: string; orders: { id: string; sortOrder: number }[] };

        if (!operatorId || !mongoose.Types.ObjectId.isValid(operatorId)) {
            return reply.status(400).send({ message: 'Operator jenis produk tidak valid' });
        }

        if (!Array.isArray(orders) || orders.length === 0) {
            return reply.status(400).send({ message: 'Orders array is required' });
        }

        const ids = orders.map(item => String(item.id || '').trim());
        if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
            return reply.status(400).send({ message: 'Ada ID jenis produk yang tidak valid' });
        }

        const uniqueIds = new Set(ids);
        if (uniqueIds.size !== ids.length) {
            return reply.status(400).send({ message: 'Urutan jenis produk mengandung ID duplikat' });
        }

        const existingTypes = await ProductType.find({ operatorId }).select('_id');
        if (orders.length !== existingTypes.length) {
            return reply.status(400).send({ message: 'Urutan jenis produk harus memuat semua jenis pada operator aktif' });
        }

        const existingIdSet = new Set(existingTypes.map(type => type._id.toString()));
        if (ids.some(id => !existingIdSet.has(id))) {
            return reply.status(400).send({ message: 'Ada jenis produk yang tidak ditemukan pada operator aktif' });
        }

        const bulkOps = ids.map((id, index) => ({
            updateOne: {
                filter: { _id: id, operatorId },
                update: { $set: { sortOrder: index + 1 } }
            }
        }));

        const result = await ProductType.bulkWrite(bulkOps);
        if (result.matchedCount !== existingTypes.length) {
            return reply.status(409).send({ message: 'Urutan jenis produk berubah. Segarkan halaman lalu coba lagi.' });
        }

        return reply.send({ message: 'Sort order updated successfully' });
    } catch (error) {
        console.error('Error updating sort order:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
