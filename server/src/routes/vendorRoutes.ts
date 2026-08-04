import { FastifyInstance } from 'fastify';
import {
    getVendors,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor,
    testVendorConnection,
    syncVendorProducts,
    getVendorStats,
    getVendorHealth,
    exportVendorHealthCsv,
    getDigiflazzBalance,
    getDigiflazzSettings,
    saveDigiflazzSettings,
    getDigiflazzPricelist,
    fetchDigiflazzPricelist,
    getTokovoucherBalance,
    getTokovoucherSettings,
    saveTokovoucherSettings,
    getTokovoucherCategories,
    getTokovoucherOperators,
    getTokovoucherJenis,
    getTokovoucherProducts,
    searchTokovoucherByCode
} from '../controllers/vendorController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function vendorRoutes(fastify: FastifyInstance) {
    fastify.get('/health', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getVendorHealth);

    fastify.get('/health/export', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, exportVendorHealthCsv);

    // Digiflazz specific routes
    fastify.get('/digiflazz/balance', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzBalance);

    fastify.get('/digiflazz/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSettings);

    fastify.post('/digiflazz/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, saveDigiflazzSettings);

    fastify.get('/digiflazz/pricelist', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzPricelist);

    fastify.post('/digiflazz/pricelist/fetch', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, fetchDigiflazzPricelist);

    // Tokovoucher specific routes
    fastify.get('/tokovoucher/balance', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherBalance);

    fastify.get('/tokovoucher/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherSettings);

    fastify.post('/tokovoucher/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, saveTokovoucherSettings);

    // Tokovoucher cascading filters
    fastify.get('/tokovoucher/categories', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherCategories);

    fastify.get('/tokovoucher/operators', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherOperators);

    fastify.get('/tokovoucher/jenis', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherJenis);

    fastify.get('/tokovoucher/products', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getTokovoucherProducts);

    fastify.get('/tokovoucher/search', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, searchTokovoucherByCode);

    // Admin only routes
    fastify.get('/', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getVendors);

    fastify.get('/:id', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getVendorById);

    fastify.post('/', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, createVendor);

    fastify.put('/:id', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, updateVendor);

    fastify.delete('/:id', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, deleteVendor);

    fastify.post('/:id/test', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, testVendorConnection);

    fastify.post('/:id/sync', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, syncVendorProducts);

    fastify.get('/:id/stats', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getVendorStats);
}
