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

const normalizeOperatorName = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildOperatorSlug = (name: string): string => {
    const slug = slugify(name);
    if (!slug) {
        throw new Error('INVALID_OPERATOR_SLUG');
    }

    return slug;
};

const getLegacyOperatorProductFilter = (operatorName: string, categoryId: string, categoryName: string) => ({
    brand: operatorName,
    $and: [
        { $or: [{ operatorId: { $exists: false } }, { operatorId: null }] },
        { $or: [{ categoryId }, { category: categoryName }] }
    ]
});

const getOperatorDependencies = async (
    operatorId: string,
    operatorName: string,
    categoryId: string,
    categoryName: string
) => {
    const [directProductCount, legacyProductCount, productTypeCount] = await Promise.all([
        Product.countDocuments({ operatorId }),
        Product.countDocuments(getLegacyOperatorProductFilter(operatorName, categoryId, categoryName)),
        ProductType.countDocuments({ operatorId })
    ]);

    const productCount = directProductCount + legacyProductCount;
    const dependencyCount = productCount + productTypeCount;

    return {
        directProductCount,
        legacyProductCount,
        productCount,
        productTypeCount,
        dependencyCount,
        canDelete: dependencyCount === 0
    };
};

const buildDependencyMessage = (counts: {
    directProductCount: number;
    legacyProductCount: number;
    productTypeCount: number;
}) => {
    const parts = [
        counts.directProductCount > 0 ? `${counts.directProductCount} produk` : null,
        counts.legacyProductCount > 0 ? `${counts.legacyProductCount} referensi legacy` : null,
        counts.productTypeCount > 0 ? `${counts.productTypeCount} tipe produk` : null
    ].filter(Boolean);

    return parts.length > 0
        ? `Operator masih dipakai oleh ${parts.join(', ')}. Nonaktifkan operator jika belum ingin ditampilkan.`
        : 'Operator masih dipakai dan tidak dapat dihapus.';
};

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

const isOperatorPubliclyVisible = (operator: any) => (
    isEntityActive(operator) && isEntityActive(operator.categoryId)
);

// Get all operators (public - active only)
export const getOperators = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId } = request.query as { categoryId?: string };
        const query: any = { status: true };
        
        if (categoryId) {
            query.categoryId = categoryId;
        }

        const operators = await Operator.find(query)
            .populate('categoryId', 'name icon slug status isActive')
            .sort({ sortOrder: 1, name: 1 });

        return reply.send(operators.filter(isOperatorPubliclyVisible));
    } catch (error) {
        console.error('Error fetching operators:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get all operators (admin - including inactive)
export const getAllOperators = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId } = request.query as { categoryId?: string };
        const query: any = {};
        
        if (categoryId) {
            query.categoryId = categoryId;
        }

        const operators = await Operator.find(query)
            .populate('categoryId', 'name icon slug status')
            .sort({ sortOrder: 1, name: 1 });

        const [directProductCounts, legacyProductCounts, productTypeCounts] = await Promise.all([
            Product.aggregate([
                { $match: { operatorId: { $exists: true, $ne: null } } },
                { $group: { _id: '$operatorId', count: { $sum: 1 } } }
            ]),
            Product.aggregate([
                { $match: { $or: [{ operatorId: { $exists: false } }, { operatorId: null }] } },
                {
                    $group: {
                        _id: {
                            brand: '$brand',
                            categoryId: '$categoryId',
                            category: '$category'
                        },
                        count: { $sum: 1 }
                    }
                }
            ]),
            ProductType.aggregate([
                { $group: { _id: '$operatorId', count: { $sum: 1 } } }
            ])
        ]);

        const directProductCountMap = new Map(directProductCounts.map(item => [item._id?.toString(), item.count]));
        const productTypeCountMap = new Map(productTypeCounts.map(item => [item._id?.toString(), item.count]));

        const operatorsWithCount = operators.map(op => ({
            ...(() => {
                const operatorObj = op.toObject() as any;
                const populatedCategory = operatorObj.categoryId;
                const currentCategoryId = populatedCategory?._id?.toString() || op.categoryId.toString();
                const currentCategoryName = populatedCategory?.name || '';
                const legacyProductCount = legacyProductCounts.reduce((sum, item) => {
                    const matchesBrand = item._id?.brand === op.name;
                    const matchesCategoryId = item._id?.categoryId?.toString?.() === currentCategoryId;
                    const matchesCategoryName = item._id?.category === currentCategoryName;

                    return matchesBrand && (matchesCategoryId || matchesCategoryName) ? sum + item.count : sum;
                }, 0);
                const directProductCount = directProductCountMap.get(op._id.toString()) || 0;
                const productTypeCount = productTypeCountMap.get(op._id.toString()) || 0;
                const productCount = directProductCount + legacyProductCount;

                return {
                    ...operatorObj,
                    directProductCount,
                    legacyProductCount,
                    productCount,
                    productTypeCount,
                    dependencyCount: productCount + productTypeCount,
                    canDelete: productCount + productTypeCount === 0
                };
            })()
        }));

        return reply.send(operatorsWithCount);
    } catch (error) {
        console.error('Error fetching all operators:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get operator by ID or slug
export const getOperatorById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const isObjectId = mongoose.Types.ObjectId.isValid(id);

        const operator = await Operator.findOne(isObjectId ? {
            $or: [{ _id: id }, { slug: id }]
        } : { slug: id })
        .populate('categoryId', 'name icon slug status isActive');

        if (!operator) {
            return reply.status(404).send({ message: 'Operator not found' });
        }

        const isAdminRequest = request.url.includes('/admin/');
        if (!isAdminRequest && !isOperatorPubliclyVisible(operator)) {
            return reply.status(404).send({ message: 'Operator not found' });
        }

        return reply.send(operator);
    } catch (error) {
        console.error('Error fetching operator:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Create operator
export const createOperator = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { 
            name, categoryId, icon, instructionImage, checkUsername, usernameLabel, status,
            validationType, description, isCustomProduct, userIdLabel, userIdType,
            hasServerId, serverIdLabel, serverIdDropdown, serverIdType, serverOptions
        } = request.body as any;

        const normalizedName = normalizeOperatorName(name);
        if (!normalizedName) {
            return reply.status(400).send({ message: 'Nama operator wajib diisi' });
        }

        if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
            return reply.status(400).send({ message: 'Kategori operator tidak valid' });
        }

        let slug: string;
        try {
            slug = buildOperatorSlug(normalizedName);
        } catch {
            return reply.status(400).send({ message: 'Nama operator tidak valid untuk dijadikan slug' });
        }

        const category = await Category.findById(categoryId).select('name');
        if (!category) {
            return reply.status(400).send({ message: 'Kategori operator tidak ditemukan' });
        }

        // Check if slug already exists in same category
        const existing = await Operator.findOne({ slug, categoryId });
        if (existing) {
            return reply.status(400).send({ message: 'Operator dengan nama ini sudah ada di kategori ini' });
        }

        // Get max sortOrder for category
        const maxSort = await Operator.findOne({ categoryId }).sort({ sortOrder: -1 });
        const sortOrder = maxSort ? maxSort.sortOrder + 1 : 0;

        const operator = await Operator.create({
            name: normalizedName,
            slug,
            categoryId,
            icon,
            instructionImage,
            checkUsername: checkUsername || false,
            usernameLabel,
            validationType: validationType || 'none',
            description,
            isCustomProduct: isCustomProduct || false,
            userIdLabel: userIdLabel || 'User ID',
            userIdType: userIdType || 'number',
            hasServerId: hasServerId || false,
            serverIdLabel: serverIdLabel || 'Server ID',
            serverIdDropdown: serverIdDropdown || false,
            serverIdType: serverIdType || 'number',
            serverOptions: serverOptions || [],
            sortOrder,
            status: status !== undefined ? status : true
        });

        return reply.status(201).send({
            message: 'Operator created successfully',
            operator
        });
    } catch (error) {
        console.error('Error creating operator:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update operator
export const updateOperator = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const { 
            name, categoryId, icon, instructionImage, checkUsername, usernameLabel, sortOrder, status,
            validationType, description, isCustomProduct, userIdLabel, userIdType,
            hasServerId, serverIdLabel, serverIdDropdown, serverIdType, serverOptions
        } = request.body as any;

        const operator = await Operator.findById(id);
        if (!operator) {
            return reply.status(404).send({ message: 'Operator not found' });
        }

        const previousName = operator.name;
        const previousCategoryId = operator.categoryId.toString();
        const previousCategory = await Category.findById(previousCategoryId).select('name');

        const normalizedName = name !== undefined ? normalizeOperatorName(name) : operator.name;
        if (!normalizedName) {
            return reply.status(400).send({ message: 'Nama operator wajib diisi' });
        }

        const targetCategoryId = categoryId !== undefined ? String(categoryId) : previousCategoryId;
        if (!mongoose.Types.ObjectId.isValid(targetCategoryId)) {
            return reply.status(400).send({ message: 'Kategori operator tidak valid' });
        }

        const targetCategory = await Category.findById(targetCategoryId).select('name');
        if (!targetCategory) {
            return reply.status(400).send({ message: 'Kategori operator tidak ditemukan' });
        }

        const targetSlug = buildOperatorSlug(normalizedName);
        if (normalizedName !== operator.name || targetCategoryId !== previousCategoryId) {
            const existing = await Operator.findOne({
                slug: targetSlug,
                categoryId: targetCategoryId,
                _id: { $ne: id }
            });
            if (existing) {
                return reply.status(400).send({ message: 'Operator dengan nama ini sudah ada di kategori ini' });
            }

            operator.name = normalizedName;
            operator.slug = targetSlug;
        }

        if (categoryId !== undefined) operator.categoryId = targetCategoryId as any;
        if (icon !== undefined) operator.icon = icon;
        if (instructionImage !== undefined) operator.instructionImage = instructionImage;
        if (checkUsername !== undefined) operator.checkUsername = checkUsername;
        if (usernameLabel !== undefined) operator.usernameLabel = usernameLabel;
        if (validationType !== undefined) operator.validationType = validationType;
        if (description !== undefined) operator.description = description;
        if (isCustomProduct !== undefined) operator.isCustomProduct = isCustomProduct;
        if (userIdLabel !== undefined) operator.userIdLabel = userIdLabel;
        if (userIdType !== undefined) operator.userIdType = userIdType;
        if (hasServerId !== undefined) operator.hasServerId = hasServerId;
        if (serverIdLabel !== undefined) operator.serverIdLabel = serverIdLabel;
        if (serverIdDropdown !== undefined) operator.serverIdDropdown = serverIdDropdown;
        if (serverIdType !== undefined) operator.serverIdType = serverIdType;
        if (serverOptions !== undefined) operator.serverOptions = serverOptions;
        if (sortOrder !== undefined) operator.sortOrder = Math.max(0, Number(sortOrder) || 0);
        if (status !== undefined) operator.status = status;

        await operator.save();

        const operatorNameChanged = previousName !== operator.name;
        const operatorCategoryChanged = previousCategoryId !== operator.categoryId.toString();

        if (operatorNameChanged || operatorCategoryChanged) {
            const directProductUpdate: Record<string, unknown> = {
                brand: operator.name,
                categoryId: targetCategory._id,
                category: targetCategory.name
            };

            const legacyOperatorFilter = {
                brand: previousName,
                $and: [
                    { $or: [{ operatorId: { $exists: false } }, { operatorId: null }] },
                    {
                        $or: [
                            { categoryId: previousCategoryId },
                            { category: previousCategory?.name || '' }
                        ]
                    }
                ]
            };

            await Promise.all([
                Product.updateMany({ operatorId: id }, { $set: directProductUpdate }),
                Product.updateMany(legacyOperatorFilter, {
                    $set: {
                        brand: operator.name,
                        categoryId: targetCategory._id,
                        category: targetCategory.name
                    }
                }),
                ProductType.updateMany({ operatorId: id }, { $set: { categoryId: targetCategory._id } })
            ]);
        }

        const dependencyCounts = await getOperatorDependencies(
            operator._id.toString(),
            operator.name,
            operator.categoryId.toString(),
            targetCategory.name
        );

        return reply.send({
            message: 'Operator updated successfully',
            operator: {
                ...operator.toObject(),
                ...dependencyCounts
            }
        });
    } catch (error) {
        if ((error as Error).message === 'INVALID_OPERATOR_SLUG') {
            return reply.status(400).send({ message: 'Nama operator tidak valid untuk dijadikan slug' });
        }
        console.error('Error updating operator:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Delete operator
export const deleteOperator = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const operator = await Operator.findById(id);
        if (!operator) {
            return reply.status(404).send({ message: 'Operator not found' });
        }

        const category = await Category.findById(operator.categoryId).select('name');
        const dependencyCounts = await getOperatorDependencies(
            operator._id.toString(),
            operator.name,
            operator.categoryId.toString(),
            category?.name || ''
        );

        if (!dependencyCounts.canDelete) {
            return reply.status(400).send({
                message: buildDependencyMessage(dependencyCounts),
                dependencies: dependencyCounts
            });
        }

        await operator.deleteOne();

        return reply.send({ message: 'Operator deleted successfully' });
    } catch (error) {
        console.error('Error deleting operator:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update sort order (bulk)
export const updateSortOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId, orders } = request.body as { categoryId?: string; orders: { id: string; sortOrder: number }[] };

        if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
            return reply.status(400).send({ message: 'Kategori operator tidak valid' });
        }

        if (!Array.isArray(orders) || orders.length === 0) {
            return reply.status(400).send({ message: 'Orders array is required' });
        }

        const ids = orders.map(item => String(item.id || '').trim());
        if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
            return reply.status(400).send({ message: 'Ada ID operator yang tidak valid' });
        }

        const uniqueIds = new Set(ids);
        if (uniqueIds.size !== ids.length) {
            return reply.status(400).send({ message: 'Urutan operator mengandung ID duplikat' });
        }

        const existingOperators = await Operator.find({ categoryId }).select('_id');
        if (orders.length !== existingOperators.length) {
            return reply.status(400).send({ message: 'Urutan operator harus memuat semua operator pada kategori aktif' });
        }

        const existingIdSet = new Set(existingOperators.map(operator => operator._id.toString()));
        if (ids.some(id => !existingIdSet.has(id))) {
            return reply.status(400).send({ message: 'Ada operator yang tidak ditemukan pada kategori aktif' });
        }

        const bulkOps = ids.map((id, index) => ({
            updateOne: {
                filter: { _id: id, categoryId },
                update: { $set: { sortOrder: index + 1 } }
            }
        }));

        const result = await Operator.bulkWrite(bulkOps);
        if (result.matchedCount !== existingOperators.length) {
            return reply.status(409).send({ message: 'Urutan operator berubah. Segarkan halaman lalu coba lagi.' });
        }

        return reply.send({ message: 'Sort order updated successfully' });
    } catch (error) {
        console.error('Error updating sort order:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
