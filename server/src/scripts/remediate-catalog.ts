import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Category, Operator, Product, ProductType } from '../models';

dotenv.config();

type Args = Record<string, string | boolean>;

const normalize = (value: unknown) => String(value || '').trim().toLowerCase();

const parseArgs = (): Args => {
    return process.argv.slice(2).reduce<Args>((accumulator, current) => {
        if (!current.startsWith('--')) {
            return accumulator;
        }

        const [rawKey, rawValue] = current.slice(2).split('=');
        if (rawValue === undefined || rawValue === 'true') {
            accumulator[rawKey] = true;
        } else if (rawValue === 'false') {
            accumulator[rawKey] = false;
        } else {
            accumulator[rawKey] = rawValue;
        }

        return accumulator;
    }, {});
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactNameQuery = (value: string) => ({
    $regex: `^${escapeRegex(value)}$`,
    $options: 'i'
});

const slugify = (value: string) => value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const resolveCategory = async (value: string) => Category.findOne({
    $or: [{ slug: value }, { name: exactNameQuery(value) }]
});

const resolveOperator = async (value: string) => Operator.findOne({
    $or: [{ slug: value }, { name: exactNameQuery(value) }]
});

const resolveProductType = async (value: string, operatorId?: mongoose.Types.ObjectId) => ProductType.findOne({
    ...(operatorId ? { operatorId } : {}),
    $or: [{ slug: value }, { name: exactNameQuery(value) }]
});

const ensureUniqueProductTypeSlug = async (operatorId: mongoose.Types.ObjectId, baseValue: string) => {
    const baseSlug = slugify(baseValue) || 'default';
    let candidate = baseSlug;
    let counter = 1;

    while (await ProductType.exists({ operatorId, slug: candidate })) {
        candidate = `${baseSlug}-${counter}`;
        counter += 1;
    }

    return candidate;
};

async function main() {
    const args = parseArgs();
    const apply = args.apply === true;

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');

    try {
        const pulsaCategory = await resolveCategory('pulsa');
        const telkomselOperator = await resolveOperator('telkomsel');
        const regulerType = telkomselOperator
            ? await resolveProductType('reguler', telkomselOperator._id as mongoose.Types.ObjectId)
            : null;

        const topupGameCategory = await resolveCategory('topupgame');
        const freeFireOperator = await resolveOperator('free-fire');

        if (!pulsaCategory || !telkomselOperator || !regulerType) {
            throw new Error('Telkomsel/Pulsa/reguler relation is incomplete. Aborting remediation.');
        }

        if (!topupGameCategory || !freeFireOperator) {
            throw new Error('Free Fire/TopupGame relation is incomplete. Aborting remediation.');
        }

        const telkomselProducts = await Product.find({
            categoryId: pulsaCategory._id,
            brand: exactNameQuery(telkomselOperator.name),
            $or: [
                { operatorId: { $exists: false } },
                { operatorId: null },
                { productTypeId: { $exists: false } },
                { productTypeId: null }
            ]
        }).sort({ name: 1, createdAt: 1 });

        let freeFireType = await ProductType.findOne({
            operatorId: freeFireOperator._id,
            $or: [{ slug: 'cek-id' }, { name: exactNameQuery('Cek ID') }]
        });

        const freeFireProducts = await Product.find({
            operatorId: freeFireOperator._id,
            brand: exactNameQuery(freeFireOperator.name)
        }).sort({ name: 1, createdAt: 1 });

        const productTypeIds = freeFireProducts
            .map((product) => product.productTypeId)
            .filter(Boolean)
            .map((value) => String(value));

        const existingFreeFireTypeIds = new Set(
            (await ProductType.find({ _id: { $in: productTypeIds } }).select('_id').lean())
                .map((item) => String(item._id))
        );

        const brokenFreeFireProducts = freeFireProducts.filter((product) => {
            const productTypeId = product.productTypeId ? String(product.productTypeId) : '';
            return !productTypeId || !existingFreeFireTypeIds.has(productTypeId);
        });

        console.log('Planned Telkomsel backfill:');
        telkomselProducts.forEach((product, index) => {
            console.log(`${index + 1}. ${product.code} -> operator=${telkomselOperator.slug}, type=${regulerType.slug}`);
        });

        console.log('\nPlanned Free Fire repair:');
        console.log(`Fallback type exists: ${freeFireType ? `${freeFireType.name} (${freeFireType.slug})` : 'no, will create Cek ID'}`);
        brokenFreeFireProducts.forEach((product, index) => {
            console.log(`${index + 1}. ${product.code} -> fix broken productType relation`);
        });

        if (!apply) {
            console.log('\nDry run only. Re-run with --apply to write changes.');
            return;
        }

        for (const product of telkomselProducts) {
            product.category = pulsaCategory.name;
            product.categoryId = pulsaCategory._id as mongoose.Types.ObjectId;
            product.operatorId = telkomselOperator._id as mongoose.Types.ObjectId;
            product.productTypeId = regulerType._id as mongoose.Types.ObjectId;
            product.brand = telkomselOperator.name;
            await product.save();
        }

        if (!freeFireType) {
            const sortOrder = await ProductType.countDocuments({ operatorId: freeFireOperator._id });
            freeFireType = await ProductType.create({
                name: 'Cek ID',
                slug: await ensureUniqueProductTypeSlug(freeFireOperator._id as mongoose.Types.ObjectId, 'cek-id'),
                categoryId: topupGameCategory._id,
                operatorId: freeFireOperator._id,
                icon: '',
                cover: '',
                openTime: '00:00',
                closeTime: '23:59',
                open24Hours: true,
                estimatedDelivery: '',
                processType: 'auto',
                description: 'Produk utilitas untuk validasi atau pengecekan ID Free Fire.',
                popupInfo: {
                    title: '',
                    content: '',
                    image: '',
                    buttonText: '',
                    buttonLink: '',
                    enabled: false
                },
                sortOrder,
                status: true
            });
        }

        for (const product of brokenFreeFireProducts) {
            product.category = topupGameCategory.name;
            product.categoryId = topupGameCategory._id as mongoose.Types.ObjectId;
            product.operatorId = freeFireOperator._id as mongoose.Types.ObjectId;
            product.productTypeId = freeFireType._id as mongoose.Types.ObjectId;
            product.brand = freeFireOperator.name;
            await product.save();
        }

        const refreshedProducts = await Product.find().select('categoryId operatorId productTypeId').lean();
        const categoryCounts = new Map<string, number>();
        const operatorCounts = new Map<string, number>();
        const productTypeCounts = new Map<string, number>();

        refreshedProducts.forEach((product) => {
            if (product.categoryId) {
                const key = String(product.categoryId);
                categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
            }
            if (product.operatorId) {
                const key = String(product.operatorId);
                operatorCounts.set(key, (operatorCounts.get(key) || 0) + 1);
            }
            if (product.productTypeId) {
                const key = String(product.productTypeId);
                productTypeCounts.set(key, (productTypeCounts.get(key) || 0) + 1);
            }
        });

        const [activeCategories, activeOperators, activeProductTypes] = await Promise.all([
            Category.find({ status: true }),
            Operator.find({ status: true }),
            ProductType.find({ status: true })
        ]);

        const deactivatedCategories: string[] = [];
        const deactivatedOperators: string[] = [];
        const deactivatedProductTypes: string[] = [];

        for (const category of activeCategories) {
            if ((categoryCounts.get(String(category._id)) || 0) === 0) {
                category.status = false;
                await category.save();
                deactivatedCategories.push(category.name);
            }
        }

        for (const operator of activeOperators) {
            if ((operatorCounts.get(String(operator._id)) || 0) === 0) {
                operator.status = false;
                await operator.save();
                deactivatedOperators.push(operator.name);
            }
        }

        for (const productType of activeProductTypes) {
            if ((productTypeCounts.get(String(productType._id)) || 0) === 0) {
                productType.status = false;
                await productType.save();
                deactivatedProductTypes.push(`${productType.name} (${productType.slug})`);
            }
        }

        console.log('\nRemediation complete:');
        console.log(`- telkomsel products fixed : ${telkomselProducts.length}`);
        console.log(`- free fire products fixed : ${brokenFreeFireProducts.length}`);
        console.log(`- free fire type created   : ${freeFireType ? 'yes' : 'no'}`);
        console.log(`- categories deactivated   : ${deactivatedCategories.length ? deactivatedCategories.join(', ') : 'none'}`);
        console.log(`- operators deactivated    : ${deactivatedOperators.length ? deactivatedOperators.join(', ') : 'none'}`);
        console.log(`- product types deactivated: ${deactivatedProductTypes.length ? deactivatedProductTypes.join(', ') : 'none'}`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('Catalog remediation failed:', error);
    process.exit(1);
});
