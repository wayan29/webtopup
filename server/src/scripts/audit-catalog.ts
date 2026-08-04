import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { runCatalogAudit } from '../services/catalogAuditService';

dotenv.config();

type Args = Record<string, string | boolean>;

const parseArgs = (): Args => {
    return process.argv.slice(2).reduce<Args>((accumulator, current) => {
        if (!current.startsWith('--')) {
            return accumulator;
        }

        const [rawKey, rawValue] = current.slice(2).split('=');
        if (rawValue === undefined) {
            accumulator[rawKey] = true;
        } else if (rawValue === 'true') {
            accumulator[rawKey] = true;
        } else if (rawValue === 'false') {
            accumulator[rawKey] = false;
        } else {
            accumulator[rawKey] = rawValue;
        }
        return accumulator;
    }, {});
};

const printSection = (title: string) => {
    console.log(`\n=== ${title} ===`);
};

async function main() {
    const args = parseArgs();
    const limit = Math.max(1, Number(args.limit) || 15);
    const json = args.json === true;

    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/pobb');

    try {
        const result = await runCatalogAudit(limit);

        if (json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }

        printSection('Summary');
        console.log(`Categories           : ${result.summary.categories}`);
        console.log(`Operators            : ${result.summary.operators}`);
        console.log(`Product types        : ${result.summary.productTypes}`);
        console.log(`Products             : ${result.summary.products}`);
        console.log(`Products with issues : ${result.summary.productsWithIssues}`);
        console.log(`Empty active categories    : ${result.summary.emptyActiveCategories}`);
        console.log(`Empty active operators     : ${result.summary.emptyActiveOperators}`);
        console.log(`Empty active product types : ${result.summary.emptyActiveProductTypes}`);

        printSection('Issue Counts');
        Object.entries(result.issueCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .forEach(([issue, count]) => {
                console.log(`${issue.padEnd(30)} ${count}`);
            });

        printSection(`Sample Products With Issues (max ${limit})`);
        if (result.examples.length === 0 && result.summary.productsWithIssues === 0) {
            console.log('No product relation issues found.');
        } else {
            result.examples.forEach((item, index) => {
                console.log(
                    `${index + 1}. ${item.code} | ${item.name}\n` +
                    `   category=${item.category || '-'} | brand=${item.brand || '-'} | status=${item.status ? 'active' : 'inactive'}\n` +
                    `   categoryId=${item.categoryId || '-'} | operatorId=${item.operatorId || '-'} | productTypeId=${item.productTypeId || '-'}\n` +
                    `   issues=${item.issues.join(', ')}`
                );
            });
        }

        printSection(`Empty Active Operators (max ${limit})`);
        if (result.emptyActiveOperators.length === 0) {
            console.log('None');
        } else {
            result.emptyActiveOperators.forEach((item, index) => {
                console.log(`${index + 1}. ${item.name} (${item.slug})`);
            });
        }

        printSection(`Empty Active Product Types (max ${limit})`);
        if (result.emptyActiveProductTypes.length === 0) {
            console.log('None');
        } else {
            result.emptyActiveProductTypes.forEach((item, index) => {
                console.log(`${index + 1}. ${item.name} (${item.slug})`);
            });
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error('Catalog audit failed:', error);
    process.exit(1);
});
