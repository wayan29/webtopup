import { FastifyReply } from 'fastify';
import { AdminAuditLog } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';

type AdminAuditQuery = {
    page?: string;
    limit?: string;
    search?: string;
    action?: string;
    resource?: string;
    startDate?: string;
    endDate?: string;
};

const AUDIT_EXPORT_LIMIT = 5000;

const parsePositiveInt = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Number.parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.min(parsed, max);
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const csvEscape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

const formatCsvDate = (value: unknown) => {
    if (!value) return '';
    const date = new Date(value as string | Date);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
};

const formatDateKey = (date: Date) => date.toISOString().slice(0, 10);

const parseDateBoundary = (value: string | undefined, endOfDay = false) => {
    const text = value?.trim();
    if (!text) return null;

    const date = new Date(`${text}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
    if (Number.isNaN(date.getTime())) {
        throw new Error('INVALID_DATE');
    }

    return date;
};

const buildAuditFilter = (query: AdminAuditQuery) => {
    const filter: Record<string, unknown> = {};
    const start = parseDateBoundary(query.startDate);
    const end = parseDateBoundary(query.endDate, true);

    if (start || end) {
        filter.createdAt = {};
        if (start) {
            (filter.createdAt as Record<string, Date>).$gte = start;
        }
        if (end) {
            (filter.createdAt as Record<string, Date>).$lte = end;
        }
    }

    if (query.action && ['create', 'update', 'delete', 'execute'].includes(query.action)) {
        filter.action = query.action;
    }

    if (query.resource?.trim()) {
        filter.resource = query.resource.trim();
    }

    if (query.search?.trim()) {
        const keyword = escapeRegex(query.search.trim());
        filter.$or = [
            { actorName: { $regex: keyword, $options: 'i' } },
            { actorEmail: { $regex: keyword, $options: 'i' } },
            { resource: { $regex: keyword, $options: 'i' } },
            { path: { $regex: keyword, $options: 'i' } },
            { ip: { $regex: keyword, $options: 'i' } }
        ];
    }

    return filter;
};

const buildAuditCsv = (items: any[]) => {
    const header = [
        'Tanggal',
        'Actor',
        'Email',
        'Role',
        'Action',
        'Resource',
        'Method',
        'Path',
        'Status Code',
        'IP',
        'User Agent',
        'Summary',
        'Metadata'
    ];

    const rows = items.map((item) => ([
        formatCsvDate(item.createdAt),
        item.actorName || '',
        item.actorEmail || '',
        item.actorRole || '',
        item.action || '',
        item.resource || '',
        item.method || '',
        item.path || '',
        item.statusCode || '',
        item.ip || '',
        item.userAgent || '',
        item.summary || '',
        item.metadata ? JSON.stringify(item.metadata) : ''
    ]));

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

export const getAdminAuditLogs = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as AdminAuditQuery;
        const page = parsePositiveInt(query.page, 1, 10000);
        const limit = parsePositiveInt(query.limit, 25, 100);
        const filter = buildAuditFilter(query);

        const [items, total, resources] = await Promise.all([
            AdminAuditLog.find(filter)
                .sort({ createdAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            AdminAuditLog.countDocuments(filter),
            AdminAuditLog.distinct('resource')
        ]);

        return reply.send({
            items,
            resources: resources.sort(),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_DATE') {
            return reply.status(400).send({ message: 'Format tanggal audit tidak valid' });
        }

        request.log.error({ error }, 'Get admin audit logs error');
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const exportAdminAuditLogsCsv = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as AdminAuditQuery;
        const filter = buildAuditFilter(query);
        const items = await AdminAuditLog.find(filter)
            .sort({ createdAt: -1 })
            .limit(AUDIT_EXPORT_LIMIT)
            .lean();

        const csv = buildAuditCsv(items);
        const filename = `admin-audit-logs-${formatDateKey(new Date())}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error) {
        if (error instanceof Error && error.message === 'INVALID_DATE') {
            return reply.status(400).send({ message: 'Format tanggal audit tidak valid' });
        }

        request.log.error({ error }, 'Export admin audit logs error');
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
