import { Category, Operator, ProductType } from '../models';

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getObjectIdString = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && value && '_id' in value) {
        return normalizeText(String((value as { _id?: unknown })._id || ''));
    }
    if (typeof value === 'object' && value && 'toString' in value) {
        return normalizeText(String(value));
    }
    return '';
};

export const getProductPurchaseIssues = async (product: any): Promise<string[]> => {
    if (!product) {
        return ['Produk tidak ditemukan'];
    }

    const categoryId = getObjectIdString(product.categoryId);
    const operatorId = getObjectIdString(product.operatorId);
    const productTypeId = getObjectIdString(product.productTypeId);
    const categoryName = normalizeText(product.category);
    const brandName = normalizeText(product.brand);

    let category: any = null;
    let operator: any = null;
    let productType: any = null;

    const [categoryDoc, operatorDoc, productTypeDoc] = await Promise.all([
        categoryId ? Category.findById(categoryId).select('status').lean() : null,
        operatorId ? Operator.findById(operatorId).select('status categoryId').lean() : null,
        productTypeId ? ProductType.findById(productTypeId).select('status categoryId operatorId').lean() : null
    ]);

    category = categoryDoc;
    operator = operatorDoc;
    productType = productTypeDoc;

    if (!operator && brandName) {
        operator = await Operator.findOne({
            name: {
                $regex: `^${escapeRegExp(brandName)}$`,
                $options: 'i'
            }
        })
            .select('status categoryId')
            .sort({ sortOrder: 1, name: 1 })
            .lean();
    }

    if (!category && categoryName) {
        category = await Category.findOne({
            name: {
                $regex: `^${escapeRegExp(categoryName)}$`,
                $options: 'i'
            }
        })
            .select('status')
            .lean();
    }

    if (!category && operator?.categoryId) {
        category = await Category.findById(operator.categoryId).select('status').lean();
    }

    if (!category && productType?.categoryId) {
        category = await Category.findById(productType.categoryId).select('status').lean();
    }

    if (!operator && productType?.operatorId) {
        operator = await Operator.findById(productType.operatorId).select('status categoryId').lean();
    }

    const issues = new Set<string>();

    if (category && category.status === false) {
        issues.add('Kategori nonaktif');
    }

    if (operator && operator.status === false) {
        issues.add('Operator nonaktif');
    }

    if (productType && productType.status === false) {
        issues.add('Jenis produk nonaktif');
    }

    return Array.from(issues);
};
