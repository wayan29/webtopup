import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Category, Operator, Product, ProductType } from '../models';

dotenv.config();

type Args = Record<string, string | boolean>;

const getArgValue = (rawValue?: string) => {
    if (rawValue === undefined) return true;
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    return rawValue;
};

const parseArgs = (): Args => {
    return process.argv.slice(2).reduce<Args>((accumulator, current) => {
        if (!current.startsWith('--')) {
            return accumulator;
        }

        const [rawKey, rawValue] = current.slice(2).split('=');
        accumulator[rawKey] = getArgValue(rawValue);
        return accumulator;
    }, {});
};

const slugify = (value: string) => value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactNameQuery = (value: string) => ({
    $regex: `^${escapeRegex(value)}$`,
    $options: 'i'
});

const resolveCategory = async (value: string) => {
    return Category.findOne({
        $or: [{ slug: value }, { name: exactNameQuery(value) }]
    });
};

const resolveOperator = async (value: string) => {
    return Operator.findOne({
        $or: [{ slug: value }, { name: exactNameQuery(value) }]
    });
};

const resolveProductType = async (value: string, operatorId?: mongoose.Types.ObjectId) => {
    return ProductType.findOne({
        ...(operatorId ? { operatorId } : {}),
        $or: [{ slug: value }, { name: exactNameQuery(value) }]
    });
};

const generateUniqueCode = async (baseCode: string) => {
    let candidate = baseCode;
    let counter = 1;

    while (await Product.exists({ code: candidate })) {
        candidate = `${baseCode}-${counter}`;
        counter += 1;
    }

    return candidate;
};

async function main() {
    const args = parseArgs();
    const sourceOperatorKey = String(args['source-operator'] || '');
    const sourceTypeKey = String(args['source-type'] || '');
    const targetCategoryKey = String(args['target-category'] || '');
    const targetOperatorKey = String(args['target-operator'] || '');
    const targetTypeKey = String(args['target-type'] || '');
    const codePrefix = String(args['code-prefix'] || 'G2-');
    const apply = args.apply === true;

    if (!sourceOperatorKey || !sourceTypeKey || !targetCategoryKey || !targetOperatorKey || !targetTypeKey) {
        console.error('Usage: ts-node src/scripts/clone-catalog.ts --source-operator=<slug> --source-type=<slug> --target-category=<slug> --target-operator=<slug> --target-type=<slug> [--code-prefix=G2-] [--apply]');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');

    try {
        const sourceOperator = await resolveOperator(sourceOperatorKey);
        const targetOperator = await resolveOperator(targetOperatorKey);
        const targetCategory = await resolveCategory(targetCategoryKey);

        if (!sourceOperator) throw new Error(`Source operator not found: ${sourceOperatorKey}`);
        if (!targetOperator) throw new Error(`Target operator not found: ${targetOperatorKey}`);
        if (!targetCategory) throw new Error(`Target category not found: ${targetCategoryKey}`);

        const sourceType = await resolveProductType(sourceTypeKey, sourceOperator._id as mongoose.Types.ObjectId);
        const targetType = await resolveProductType(targetTypeKey, targetOperator._id as mongoose.Types.ObjectId);
        const sourceCategory = await Category.findById(sourceOperator.categoryId);

        if (!sourceType) throw new Error(`Source product type not found: ${sourceTypeKey}`);
        if (!targetType) throw new Error(`Target product type not found: ${targetTypeKey}`);
        if (!sourceCategory) throw new Error(`Source category not found for operator: ${sourceOperator.name}`);

        const sourceProducts = await Product.find({
            $or: [
                { productTypeId: sourceType._id },
                { operatorId: sourceOperator._id },
                {
                    brand: exactNameQuery(sourceOperator.name),
                    $or: [
                        { categoryId: sourceOperator.categoryId },
                        { category: exactNameQuery(sourceCategory.name) }
                    ]
                }
            ]
        }).sort({ sortOrder: 1, createdAt: 1 });

        const existingTargetProducts = await Product.find({
            $or: [
                { productTypeId: targetType._id },
                { operatorId: targetOperator._id },
                { brand: exactNameQuery(targetOperator.name) }
            ]
        });

        const existingByVendorSku = new Map(
            existingTargetProducts
                .filter((product) => product.vendor?.sku)
                .map((product) => [`${product.vendor?.name || ''}::${product.vendor?.sku || ''}`, product])
        );

        console.log(`Source products found: ${sourceProducts.length}`);
        console.log(`Target products existing: ${existingTargetProducts.length}`);

        if (sourceProducts.length === 0) {
            console.log('No source products found. Nothing to clone.');
            return;
        }

        console.log('\nPlanned operator sync:');
        console.log(`- validationType: ${sourceOperator.validationType} -> ${targetOperator.validationType}`);
        console.log(`- hasServerId: ${sourceOperator.hasServerId} -> ${targetOperator.hasServerId}`);
        console.log(`- serverIdDropdown: ${sourceOperator.serverIdDropdown} -> ${targetOperator.serverIdDropdown}`);
        console.log(`- serverOptions: ${sourceOperator.serverOptions.length} option(s)`);

        console.log('\nPlanned product type sync:');
        console.log(`- processType: ${sourceType.processType} -> ${targetType.processType}`);
        console.log(`- popup enabled: ${sourceType.popupInfo?.enabled ? 'yes' : 'no'}`);
        console.log(`- description length: ${(sourceType.description || '').length}`);

        console.log('\nPlanned product mapping:');
        sourceProducts.forEach((product, index) => {
            const vendorKey = `${product.vendor?.name || ''}::${product.vendor?.sku || ''}`;
            const existingTarget = existingByVendorSku.get(vendorKey);
            console.log(`${index + 1}. ${product.code} -> ${existingTarget ? `[update existing ${existingTarget.code}]` : `[create ${codePrefix}${product.code}]`} :: ${product.name}`);
        });

        if (!apply) {
            console.log('\nDry run only. Re-run with --apply to write changes.');
            return;
        }

        targetOperator.icon = sourceOperator.icon;
        targetOperator.instructionImage = sourceOperator.instructionImage;
        targetOperator.checkUsername = sourceOperator.checkUsername;
        targetOperator.usernameLabel = sourceOperator.usernameLabel;
        targetOperator.validationType = sourceOperator.validationType;
        targetOperator.description = sourceOperator.description;
        targetOperator.isCustomProduct = sourceOperator.isCustomProduct;
        targetOperator.userIdLabel = sourceOperator.userIdLabel;
        targetOperator.userIdType = sourceOperator.userIdType;
        targetOperator.hasServerId = sourceOperator.hasServerId;
        targetOperator.serverIdLabel = sourceOperator.serverIdLabel;
        targetOperator.serverIdDropdown = sourceOperator.serverIdDropdown;
        targetOperator.serverIdType = sourceOperator.serverIdType;
        targetOperator.serverOptions = sourceOperator.serverOptions;
        await targetOperator.save();

        targetType.icon = sourceType.icon;
        targetType.cover = sourceType.cover;
        targetType.openTime = sourceType.openTime;
        targetType.closeTime = sourceType.closeTime;
        targetType.open24Hours = sourceType.open24Hours;
        targetType.estimatedDelivery = sourceType.estimatedDelivery;
        targetType.processType = sourceType.processType;
        targetType.description = sourceType.description;
        targetType.popupInfo = sourceType.popupInfo;
        targetType.status = sourceType.status;
        await targetType.save();

        let nextSortOrder = existingTargetProducts.reduce((max, product) => Math.max(max, product.sortOrder || 0), -1) + 1;
        let created = 0;
        let updated = 0;

        for (const product of sourceProducts) {
            const vendorKey = `${product.vendor?.name || ''}::${product.vendor?.sku || ''}`;
            const existingTarget = existingByVendorSku.get(vendorKey);

            if (existingTarget) {
                existingTarget.name = product.name;
                existingTarget.category = targetCategory.name;
                existingTarget.categoryId = targetCategory._id as mongoose.Types.ObjectId;
                existingTarget.operatorId = targetOperator._id as mongoose.Types.ObjectId;
                existingTarget.productTypeId = targetType._id as mongoose.Types.ObjectId;
                existingTarget.paymentType = product.paymentType;
                existingTarget.icon = product.icon;
                existingTarget.rewardPoints = product.rewardPoints;
                existingTarget.brand = targetOperator.name;
                existingTarget.costPrice = product.costPrice;
                existingTarget.price = product.price;
                existingTarget.vendor = product.vendor;
                existingTarget.status = product.status;
                existingTarget.sortOrder = nextSortOrder++;
                await existingTarget.save();
                updated += 1;
                continue;
            }

            const baseCode = `${codePrefix}${String(product.code || '').trim()}`.replace(/\s+/g, '');
            const uniqueCode = await generateUniqueCode(baseCode || `${codePrefix}${slugify(product.name).toUpperCase().replace(/-/g, '')}`);

            await Product.create({
                name: product.name,
                code: uniqueCode,
                category: targetCategory.name,
                categoryId: targetCategory._id,
                operatorId: targetOperator._id,
                productTypeId: targetType._id,
                paymentType: product.paymentType || 'prabayar',
                icon: product.icon || '',
                rewardPoints: product.rewardPoints || 0,
                brand: targetOperator.name,
                costPrice: product.costPrice || 0,
                price: product.price,
                vendor: product.vendor,
                status: product.status,
                sortOrder: nextSortOrder++
            });

            created += 1;
        }

        console.log('\nApply complete:');
        console.log(`- created: ${created}`);
        console.log(`- updated: ${updated}`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('Clone catalog failed:', error);
    process.exit(1);
});
