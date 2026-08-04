import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Category, Product, Operator, ProductType } from '../models';

const slugify = (text: string): string => {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
};

const normalizeCategoryName = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const buildCategorySlug = (name: string): string => {
    const slug = slugify(name);
    if (!slug) {
        throw new Error('INVALID_CATEGORY_SLUG');
    }

    return slug;
};

const getCategoryDependencies = async (categoryId: string, categoryName: string) => {
    const [directProductCount, legacyProductCount, operatorCount, productTypeCount] = await Promise.all([
        Product.countDocuments({ categoryId }),
        Product.countDocuments({
            category: categoryName,
            $or: [{ categoryId: { $exists: false } }, { categoryId: null }]
        }),
        Operator.countDocuments({ categoryId }),
        ProductType.countDocuments({ categoryId })
    ]);

    const productCount = directProductCount + legacyProductCount;
    const dependencyCount = productCount + operatorCount + productTypeCount;

    return {
        directProductCount,
        legacyProductCount,
        productCount,
        operatorCount,
        productTypeCount,
        dependencyCount,
        canDelete: dependencyCount === 0
    };
};

const buildDependencyMessage = (counts: {
    directProductCount: number;
    productCount: number;
    legacyProductCount: number;
    operatorCount: number;
    productTypeCount: number;
}) => {
    const parts = [
        counts.directProductCount > 0 ? `${counts.directProductCount} produk` : null,
        counts.legacyProductCount > 0 ? `${counts.legacyProductCount} referensi legacy` : null,
        counts.operatorCount > 0 ? `${counts.operatorCount} operator` : null,
        counts.productTypeCount > 0 ? `${counts.productTypeCount} tipe produk` : null
    ].filter(Boolean);

    return parts.length > 0
        ? `Kategori masih dipakai oleh ${parts.join(', ')}. Nonaktifkan kategori jika belum ingin ditampilkan.`
        : 'Kategori masih dipakai dan tidak dapat dihapus.';
};

// Get all categories (public - active only)
export const getCategories = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        // Support both old (isActive) and new (status) format
        const categories = await Category.find({ 
            $or: [{ status: true }, { isActive: true }] 
        }).sort({ sortOrder: 1, name: 1 });
        return reply.send(categories);
    } catch (error) {
        console.error('Error fetching categories:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get all categories (admin - including inactive)
export const getAllCategories = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const categories = await Category.find().sort({ sortOrder: 1, name: 1 });

        const [productCounts, legacyProductCounts, operatorCounts, productTypeCounts] = await Promise.all([
            Product.aggregate([
                { $match: { categoryId: { $exists: true, $ne: null } } },
                { $group: { _id: '$categoryId', count: { $sum: 1 } } }
            ]),
            Product.aggregate([
                {
                    $match: {
                        $or: [{ categoryId: { $exists: false } }, { categoryId: null }]
                    }
                },
                { $group: { _id: '$category', count: { $sum: 1 } } }
            ]),
            Operator.aggregate([
                { $group: { _id: '$categoryId', count: { $sum: 1 } } }
            ]),
            ProductType.aggregate([
                { $group: { _id: '$categoryId', count: { $sum: 1 } } }
            ])
        ]);

        const productCountMap = new Map(productCounts.map(item => [item._id?.toString(), item.count]));
        const legacyProductCountMap = new Map(legacyProductCounts.map(item => [item._id, item.count]));
        const operatorCountMap = new Map(operatorCounts.map(item => [item._id?.toString(), item.count]));
        const productTypeCountMap = new Map(productTypeCounts.map(item => [item._id?.toString(), item.count]));

        const categoriesWithCount = categories.map(cat => ({
            ...cat.toObject(),
            directProductCount: productCountMap.get(cat._id.toString()) || 0,
            legacyProductCount: legacyProductCountMap.get(cat.name) || 0,
            productCount: (productCountMap.get(cat._id.toString()) || 0) + (legacyProductCountMap.get(cat.name) || 0),
            operatorCount: operatorCountMap.get(cat._id.toString()) || 0,
            productTypeCount: productTypeCountMap.get(cat._id.toString()) || 0,
            dependencyCount:
                ((productCountMap.get(cat._id.toString()) || 0) + (legacyProductCountMap.get(cat.name) || 0)) +
                (operatorCountMap.get(cat._id.toString()) || 0) +
                (productTypeCountMap.get(cat._id.toString()) || 0),
            canDelete:
                (((productCountMap.get(cat._id.toString()) || 0) + (legacyProductCountMap.get(cat.name) || 0)) +
                    (operatorCountMap.get(cat._id.toString()) || 0) +
                    (productTypeCountMap.get(cat._id.toString()) || 0)) === 0
        }));

        return reply.send(categoriesWithCount);
    } catch (error) {
        console.error('Error fetching all categories:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get category by ID
export const getCategoryById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const category = await Category.findById(id);
        
        if (!category) {
            return reply.status(404).send({ message: 'Category not found' });
        }
        
        return reply.send(category);
    } catch (error) {
        console.error('Error fetching category:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Create category
export const createCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { name, icon, sortOrder, status } = request.body as any;
        const normalizedName = normalizeCategoryName(name);
        if (!normalizedName) {
            return reply.status(400).send({ message: 'Nama kategori wajib diisi' });
        }

        let slug: string;
        try {
            slug = buildCategorySlug(normalizedName);
        } catch {
            return reply.status(400).send({ message: 'Nama kategori tidak valid untuk dijadikan slug' });
        }

        // Check if slug already exists
        const existing = await Category.findOne({ slug });
        if (existing) {
            return reply.status(400).send({ message: 'Category with this name already exists' });
        }

        const maxSortCategory = await Category.findOne().sort({ sortOrder: -1 }).select('sortOrder');
        const resolvedSortOrder = (maxSortCategory?.sortOrder || 0) + 1;

        const category = await Category.create({
            name: normalizedName,
            slug,
            icon: icon || '📦',
            sortOrder: resolvedSortOrder,
            status: status !== undefined ? status : true
        });

        return reply.status(201).send({
            message: 'Category created successfully',
            category
        });
    } catch (error) {
        console.error('Error creating category:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update category
export const updateCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const { name, icon, sortOrder, status } = request.body as any;

        const category = await Category.findById(id);
        if (!category) {
            return reply.status(404).send({ message: 'Category not found' });
        }

        const previousName = category.name;

        if (name !== undefined) {
            const normalizedName = normalizeCategoryName(name);
            if (!normalizedName) {
                return reply.status(400).send({ message: 'Nama kategori wajib diisi' });
            }

            const newSlug = buildCategorySlug(normalizedName);
            const existing = await Category.findOne({ slug: newSlug, _id: { $ne: id } });
            if (existing) {
                return reply.status(400).send({ message: 'Category with this name already exists' });
            }

            category.name = normalizedName;
            category.slug = newSlug;
        }

        if (icon !== undefined) category.icon = icon;
        if (sortOrder !== undefined) category.sortOrder = Math.max(0, Number(sortOrder) || 0);
        if (status !== undefined) category.status = status;

        await category.save();

        if (previousName !== category.name) {
            await Product.updateMany(
                {
                    $or: [
                        { categoryId: id },
                        { category: previousName }
                    ]
                },
                { $set: { category: category.name } }
            );
        }

        const dependencyCounts = await getCategoryDependencies(category._id.toString(), category.name);

        return reply.send({
            message: 'Category updated successfully',
            category: {
                ...category.toObject(),
                ...dependencyCounts
            }
        });
    } catch (error) {
        if ((error as Error).message === 'INVALID_CATEGORY_SLUG') {
            return reply.status(400).send({ message: 'Nama kategori tidak valid untuk dijadikan slug' });
        }
        console.error('Error updating category:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Delete category
export const deleteCategory = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const category = await Category.findById(id);
        if (!category) {
            return reply.status(404).send({ message: 'Category not found' });
        }

        const dependencyCounts = await getCategoryDependencies(category._id.toString(), category.name);
        if (!dependencyCounts.canDelete) {
            return reply.status(400).send({
                message: buildDependencyMessage(dependencyCounts),
                dependencies: dependencyCounts
            });
        }

        await Category.findByIdAndDelete(id);

        return reply.send({ message: 'Category deleted successfully' });
    } catch (error) {
        console.error('Error deleting category:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update sort order (bulk)
export const updateSortOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { orders } = request.body as { orders: { id: string; sortOrder: number }[] };

        if (!Array.isArray(orders) || orders.length === 0) {
            return reply.status(400).send({ message: 'Orders array is required' });
        }

        const ids = orders.map(item => String(item.id || '').trim());
        if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
            return reply.status(400).send({ message: 'Ada ID kategori yang tidak valid' });
        }

        const uniqueIds = new Set(ids);
        if (uniqueIds.size !== ids.length) {
            return reply.status(400).send({ message: 'Urutan kategori mengandung ID duplikat' });
        }

        const existingCount = await Category.countDocuments();
        if (orders.length !== existingCount) {
            return reply.status(400).send({ message: 'Urutan kategori harus memuat semua kategori' });
        }

        const matchedCount = await Category.countDocuments({ _id: { $in: ids } });
        if (matchedCount !== existingCount) {
            return reply.status(400).send({ message: 'Ada kategori yang tidak ditemukan pada payload urutan' });
        }

        const bulkOps = ids.map((id, index) => ({
            updateOne: {
                filter: { _id: id },
                update: { $set: { sortOrder: index + 1 } }
            }
        }));

        const result = await Category.bulkWrite(bulkOps);
        if (result.matchedCount !== existingCount) {
            return reply.status(409).send({ message: 'Urutan kategori berubah. Segarkan halaman lalu coba lagi.' });
        }

        return reply.send({ message: 'Sort order updated successfully' });
    } catch (error) {
        console.error('Error updating sort order:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
