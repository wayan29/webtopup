import { Category, Operator, Product, ProductType } from '../models';

export type CatalogIssue =
    | 'missing_category_id'
    | 'missing_operator_id'
    | 'missing_product_type_id'
    | 'missing_category_ref'
    | 'missing_operator_ref'
    | 'missing_product_type_ref'
    | 'inactive_category'
    | 'inactive_operator'
    | 'inactive_product_type'
    | 'operator_category_mismatch'
    | 'type_operator_mismatch'
    | 'type_category_mismatch'
    | 'legacy_category_text_mismatch'
    | 'legacy_brand_mismatch'
    | 'unresolved_legacy_category'
    | 'unresolved_legacy_brand'
    | 'ambiguous_legacy_brand';

export interface CatalogAuditItem {
    _id: string;
    code: string;
    name: string;
    status: boolean;
    category: string;
    brand: string;
    categoryId: string;
    operatorId: string;
    productTypeId: string;
    issues: CatalogIssue[];
}

export interface CatalogAuditEntityItem {
    name: string;
    slug: string;
    categoryId?: string;
    operatorId?: string;
}

export interface CatalogAuditSummary {
    categories: number;
    operators: number;
    productTypes: number;
    products: number;
    productsWithIssues: number;
    emptyActiveCategories: number;
    emptyActiveOperators: number;
    emptyActiveProductTypes: number;
}

export interface CatalogAuditResult {
    generatedAt: string;
    summary: CatalogAuditSummary;
    issueCounts: Record<string, number>;
    examples: CatalogAuditItem[];
    emptyActiveCategories: CatalogAuditEntityItem[];
    emptyActiveOperators: CatalogAuditEntityItem[];
    emptyActiveProductTypes: CatalogAuditEntityItem[];
}

const normalize = (value: unknown) => String(value || '').trim().toLowerCase();

const idOf = (value: unknown) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value && '_id' in value) {
        return String((value as { _id?: unknown })._id || '');
    }
    return '';
};

export const runCatalogAudit = async (limit = 15): Promise<CatalogAuditResult> => {
    const safeLimit = Math.max(1, limit);

    const [categories, operators, productTypes, products] = await Promise.all([
        Category.find().lean(),
        Operator.find().lean(),
        ProductType.find().lean(),
        Product.find().lean()
    ]);

    const categoriesById = new Map(categories.map((item) => [String(item._id), item]));
    const operatorsById = new Map(operators.map((item) => [String(item._id), item]));
    const productTypesById = new Map(productTypes.map((item) => [String(item._id), item]));

    const categoriesByName = new Map<string, typeof categories>([]);
    const operatorsByName = new Map<string, typeof operators>([]);

    categories.forEach((item) => {
        const key = normalize(item.name);
        const list = categoriesByName.get(key) || [];
        list.push(item);
        categoriesByName.set(key, list);
    });

    operators.forEach((item) => {
        const key = normalize(item.name);
        const list = operatorsByName.get(key) || [];
        list.push(item);
        operatorsByName.set(key, list);
    });

    const auditedProducts: CatalogAuditItem[] = products.map((product) => {
        const categoryId = idOf(product.categoryId);
        const operatorId = idOf(product.operatorId);
        const productTypeId = idOf(product.productTypeId);

        const category = categoryId ? categoriesById.get(categoryId) : null;
        const operator = operatorId ? operatorsById.get(operatorId) : null;
        const productType = productTypeId ? productTypesById.get(productTypeId) : null;

        const issues: CatalogIssue[] = [];

        if (!categoryId) issues.push('missing_category_id');
        if (!operatorId) issues.push('missing_operator_id');
        if (!productTypeId) issues.push('missing_product_type_id');

        if (categoryId && !category) issues.push('missing_category_ref');
        if (operatorId && !operator) issues.push('missing_operator_ref');
        if (productTypeId && !productType) issues.push('missing_product_type_ref');

        if (category && !category.status) issues.push('inactive_category');
        if (operator && !operator.status) issues.push('inactive_operator');
        if (productType && !productType.status) issues.push('inactive_product_type');

        if (category && operator && String(operator.categoryId) !== String(category._id)) {
            issues.push('operator_category_mismatch');
        }

        if (productType && operator && String(productType.operatorId) !== String(operator._id)) {
            issues.push('type_operator_mismatch');
        }

        if (productType && category && String(productType.categoryId) !== String(category._id)) {
            issues.push('type_category_mismatch');
        }

        if (category && normalize(product.category) && normalize(product.category) !== normalize(category.name)) {
            issues.push('legacy_category_text_mismatch');
        }

        if (operator && normalize(product.brand) && normalize(product.brand) !== normalize(operator.name)) {
            issues.push('legacy_brand_mismatch');
        }

        if (!categoryId && normalize(product.category)) {
            const categoryMatches = categoriesByName.get(normalize(product.category)) || [];
            if (categoryMatches.length === 0) {
                issues.push('unresolved_legacy_category');
            }
        }

        if (!operatorId && normalize(product.brand)) {
            const operatorMatches = operatorsByName.get(normalize(product.brand)) || [];
            if (operatorMatches.length === 0) {
                issues.push('unresolved_legacy_brand');
            } else if (operatorMatches.length > 1) {
                issues.push('ambiguous_legacy_brand');
            }
        }

        return {
            _id: String(product._id),
            code: product.code,
            name: product.name,
            status: Boolean(product.status),
            category: product.category,
            brand: product.brand,
            categoryId,
            operatorId,
            productTypeId,
            issues
        };
    });

    const issueCounts = auditedProducts.reduce<Record<string, number>>((accumulator, product) => {
        product.issues.forEach((issue) => {
            accumulator[issue] = (accumulator[issue] || 0) + 1;
        });
        return accumulator;
    }, {});

    const productsWithIssues = auditedProducts.filter((item) => item.issues.length > 0);

    const productCountsByOperator = new Map<string, number>();
    const productCountsByType = new Map<string, number>();
    const productCountsByCategory = new Map<string, number>();

    products.forEach((product) => {
        const categoryId = idOf(product.categoryId);
        const operatorId = idOf(product.operatorId);
        const productTypeId = idOf(product.productTypeId);

        if (categoryId) productCountsByCategory.set(categoryId, (productCountsByCategory.get(categoryId) || 0) + 1);
        if (operatorId) productCountsByOperator.set(operatorId, (productCountsByOperator.get(operatorId) || 0) + 1);
        if (productTypeId) productCountsByType.set(productTypeId, (productCountsByType.get(productTypeId) || 0) + 1);
    });

    const emptyActiveOperators = operators
        .filter((item) => item.status && (productCountsByOperator.get(String(item._id)) || 0) === 0)
        .map((item) => ({
            name: item.name,
            slug: item.slug,
            categoryId: String(item.categoryId)
        }));

    const emptyActiveProductTypes = productTypes
        .filter((item) => item.status && (productCountsByType.get(String(item._id)) || 0) === 0)
        .map((item) => ({
            name: item.name,
            slug: item.slug,
            operatorId: String(item.operatorId),
            categoryId: String(item.categoryId)
        }));

    const emptyActiveCategories = categories
        .filter((item) => item.status && (productCountsByCategory.get(String(item._id)) || 0) === 0)
        .map((item) => ({
            name: item.name,
            slug: item.slug
        }));

    return {
        generatedAt: new Date().toISOString(),
        summary: {
            categories: categories.length,
            operators: operators.length,
            productTypes: productTypes.length,
            products: products.length,
            productsWithIssues: productsWithIssues.length,
            emptyActiveCategories: emptyActiveCategories.length,
            emptyActiveOperators: emptyActiveOperators.length,
            emptyActiveProductTypes: emptyActiveProductTypes.length
        },
        issueCounts,
        examples: productsWithIssues.slice(0, safeLimit),
        emptyActiveCategories: emptyActiveCategories.slice(0, safeLimit),
        emptyActiveOperators: emptyActiveOperators.slice(0, safeLimit),
        emptyActiveProductTypes: emptyActiveProductTypes.slice(0, safeLimit)
    };
};
