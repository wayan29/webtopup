import mongoose from 'mongoose';
import { FastifyReply } from 'fastify';
import { AuthRequest } from '../middlewares/authMiddleware';
import { User, ITeamPermissions, LoginLog, TeamAuditLog } from '../models';

const allPermissions: (keyof ITeamPermissions)[] = [
    'viewDashboard', 'viewReports',
    'viewTransactions', 'processManualTransaction',
    'viewDeposits', 'approveDeposits',
    'viewProducts', 'manageProducts',
    'viewPayment', 'managePayment',
    'viewUsers', 'manageUsers',
    'viewTeam', 'manageTeam',
    'viewSettings', 'manageSettings',
    'viewVendors', 'manageVendors'
];

type TeamRole = 'admin' | 'cs';
type TeamAuditAction = 'create' | 'update' | 'activate' | 'deactivate' | 'archive';

interface TeamListQuery {
    search?: string;
}

interface LoginLogQuery {
    page?: string;
    limit?: string;
}

interface TeamMemberPayload {
    name?: string;
    email?: string;
    password?: string;
    role?: TeamRole;
    permissions?: Partial<ITeamPermissions>;
}

class TeamControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const getDefaultPermissions = (role: TeamRole): ITeamPermissions => {
    if (role === 'admin') {
        return {
            viewDashboard: true,
            viewReports: true,
            viewTransactions: true,
            processManualTransaction: true,
            viewDeposits: true,
            approveDeposits: true,
            viewProducts: true,
            manageProducts: true,
            manageVouchers: true,
            viewPayment: true,
            managePayment: true,
            viewUsers: true,
            manageUsers: true,
            viewTeam: true,
            manageTeam: false,
            viewSettings: false,
            manageSettings: false,
            viewVendors: true,
            manageVendors: false
        };
    }

    return {
        viewDashboard: true,
        viewReports: false,
        viewTransactions: true,
        processManualTransaction: true,
        viewDeposits: true,
        approveDeposits: false,
        viewProducts: false,
        manageProducts: false,
        manageVouchers: false,
        viewPayment: false,
        managePayment: false,
        viewUsers: false,
        manageUsers: false,
        viewTeam: false,
        manageTeam: false,
        viewSettings: false,
        manageSettings: false,
        viewVendors: false,
        manageVendors: false
    };
};

const parsePositiveInt = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Number.parseInt(value || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.min(parsed, max);
};

const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ');

const normalizeEmail = (value: string) => value.trim().toLowerCase();

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildPermissions = (input: Partial<ITeamPermissions> | undefined, role: TeamRole): ITeamPermissions => {
    const base = { ...getDefaultPermissions(role) };

    if (!input) {
        return base;
    }

    allPermissions.forEach((key) => {
        if (typeof input[key] === 'boolean') {
            base[key] = input[key]!;
        }
    });

    if (base.manageTeam) {
        base.viewTeam = true;
    }

    return base;
};

const clampPermissionsToActor = (permissions: ITeamPermissions, actorPermissions?: ITeamPermissions): ITeamPermissions => {
    if (!actorPermissions) {
        return permissions;
    }

    const safe = { ...permissions };

    allPermissions.forEach((key) => {
        if (safe[key] && !actorPermissions[key]) {
            safe[key] = false;
        }
    });

    safe.viewDashboard = true;
    return safe;
};

const serializePermissions = (permissions?: ITeamPermissions | null) => {
    const source = permissions || ({} as ITeamPermissions);
    return allPermissions.reduce((acc, key) => {
        acc[key] = Boolean(source[key]);
        return acc;
    }, {} as Record<keyof ITeamPermissions, boolean>);
};

const sanitizeTeamMember = (member: {
    _id: unknown;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'cs' | 'member';
    permissions?: ITeamPermissions;
    active: boolean;
    twoFactorEnabled?: boolean;
    createdAt: Date | string;
    updatedAt?: Date | string;
    createdBy?: {
        _id?: unknown;
        name?: string;
        email?: string;
        role?: string;
    } | mongoose.Types.ObjectId | null;
}) => ({
    _id: member._id,
    name: member.name,
    email: member.email,
    role: member.role,
    active: member.active,
    twoFactorEnabled: member.twoFactorEnabled === true,
    permissions: serializePermissions(member.permissions),
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    createdBy: member.createdBy && typeof member.createdBy === 'object' && 'name' in member.createdBy
        ? {
            _id: member.createdBy._id,
            name: member.createdBy.name,
            email: member.createdBy.email,
            role: member.createdBy.role
        }
        : null
});

const getActorScope = async (request: AuthRequest) => {
    const actorId = request.user?.id;
    if (!actorId || !mongoose.Types.ObjectId.isValid(actorId)) {
        throw new TeamControllerError(401, 'Unauthorized');
    }

    const actor = await User.findById(actorId).select('name email role permissions active');
    if (!actor) {
        throw new TeamControllerError(401, 'Unauthorized');
    }

    if (actor.active === false) {
        throw new TeamControllerError(403, 'Akun tim tidak aktif');
    }

    return {
        actor,
        isOwner: actor.role === 'owner'
    };
};

const ensureManageScope = (actorRole: string, targetRole: string) => {
    if (actorRole === 'owner') {
        return;
    }

    if (targetRole !== 'cs') {
        throw new TeamControllerError(403, 'Hanya owner yang dapat mengelola akun admin');
    }
};

const ensureAssignableRole = (actorRole: string, targetRole: TeamRole) => {
    if (actorRole === 'owner') {
        return;
    }

    if (targetRole !== 'cs') {
        throw new TeamControllerError(403, 'Hanya owner yang dapat membuat atau mempromosikan admin');
    }
};

const getTeamMemberById = async (id: string) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new TeamControllerError(400, 'ID anggota tim tidak valid');
    }

    const member = await User.findOne({ _id: id, role: { $in: ['admin', 'cs'] } });
    if (!member) {
        throw new TeamControllerError(404, 'Anggota tim tidak ditemukan');
    }

    return member;
};

const writeTeamAuditLog = async ({
    actor,
    target,
    action,
    summary,
    metadata
}: {
    actor: { _id: mongoose.Types.ObjectId; name: string; email: string };
    target: { _id: mongoose.Types.ObjectId; name: string; email: string; role: 'owner' | 'admin' | 'cs' | 'member' };
    action: TeamAuditAction;
    summary: string;
    metadata?: Record<string, unknown>;
}) => {
    await TeamAuditLog.create({
        actor: actor._id,
        actorName: actor.name,
        actorEmail: actor.email,
        targetUser: target._id,
        targetName: target.name,
        targetEmail: target.email,
        targetRole: target.role,
        action,
        summary,
        metadata
    });
};

const buildUpdateSummary = (changes: string[]) => {
    if (changes.length === 0) {
        return 'Tidak ada perubahan terdeteksi';
    }

    return `Memperbarui ${changes.join(', ')}`;
};

export const listTeamMembers = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as TeamListQuery;
        const search = query.search?.trim();

        const filter: Record<string, unknown> = {
            role: { $in: ['owner', 'admin', 'cs'] }
        };

        if (search) {
            const pattern = escapeRegex(search);
            filter.$or = [
                { name: { $regex: pattern, $options: 'i' } },
                { email: { $regex: pattern, $options: 'i' } }
            ];
        }

        const members = await User.find(filter)
            .select('name email role permissions active twoFactorEnabled createdAt updatedAt createdBy')
            .populate('createdBy', 'name email role')
            .sort({ role: 1, createdAt: -1 })
            .lean();

        const summary = members.reduce((acc, member) => {
            acc.total += 1;
            acc.active += member.active ? 1 : 0;
            acc.inactive += member.active ? 0 : 1;
            if (member.role === 'owner' || member.role === 'admin' || member.role === 'cs') {
                acc[member.role] += 1;
            }
            return acc;
        }, {
            total: 0,
            active: 0,
            inactive: 0,
            owner: 0,
            admin: 0,
            cs: 0
        });

        return reply.send({
            members: members.map((member) => sanitizeTeamMember(member as any)),
            summary
        });
    } catch (error) {
        console.error('List team members error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return reply.status(400).send({ message: 'ID anggota tim tidak valid' });
        }

        const member = await User.findOne({ _id: id, role: { $in: ['admin', 'cs'] } })
            .select('name email role permissions active twoFactorEnabled createdAt updatedAt createdBy')
            .populate('createdBy', 'name email role');

        if (!member) {
            return reply.status(404).send({ message: 'Anggota tim tidak ditemukan' });
        }

        return reply.send({
            member: sanitizeTeamMember(member as any)
        });
    } catch (error) {
        console.error('Get team member error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const createTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor, isOwner } = await getActorScope(request);
        const { name, email, password, role, permissions } = request.body as TeamMemberPayload;

        const normalizedName = typeof name === 'string' ? normalizeName(name) : '';
        const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';

        if (normalizedName.length < 2 || normalizedName.length > 80) {
            return reply.status(400).send({ message: 'Nama anggota tim harus 2-80 karakter' });
        }

        if (!isValidEmail(normalizedEmail)) {
            return reply.status(400).send({ message: 'Format email tidak valid' });
        }

        if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
            return reply.status(400).send({ message: 'Password minimal 6 karakter' });
        }

        if (role !== 'admin' && role !== 'cs') {
            return reply.status(400).send({ message: 'Role anggota tim harus admin atau cs' });
        }

        ensureAssignableRole(actor.role, role);

        const existing = await User.findOne({ email: normalizedEmail }).select('_id');
        if (existing) {
            return reply.status(400).send({ message: 'Email sudah dipakai akun lain' });
        }

        let finalPermissions = buildPermissions(permissions, role);
        if (!isOwner) {
            finalPermissions = clampPermissionsToActor(finalPermissions, actor.permissions);
        }

        const user = await User.create({
            name: normalizedName,
            email: normalizedEmail,
            password,
            role,
            level: 'basic',
            balance: 0,
            points: 0,
            createdBy: actor._id,
            permissions: finalPermissions,
            active: true
        });

        await writeTeamAuditLog({
            actor: {
                _id: actor._id,
                name: actor.name,
                email: actor.email
            },
            target: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            action: 'create',
            summary: `Membuat akun tim baru dengan role ${user.role}`,
            metadata: {
                permissions: finalPermissions
            }
        });

        return reply.status(201).send({
            message: 'Anggota tim berhasil dibuat',
            user: sanitizeTeamMember(user as any)
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Create team member error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor, isOwner } = await getActorScope(request);
        const { id } = request.params as { id: string };
        const { name, email, password, role, permissions } = request.body as TeamMemberPayload;

        const user = await getTeamMemberById(id);
        ensureManageScope(actor.role, user.role);

        const changes: string[] = [];
        const previousSnapshot = {
            name: user.name,
            email: user.email,
            role: user.role,
            active: user.active,
            permissions: serializePermissions(user.permissions)
        };

        if (typeof name === 'string') {
            const normalizedName = normalizeName(name);
            if (normalizedName.length < 2 || normalizedName.length > 80) {
                return reply.status(400).send({ message: 'Nama anggota tim harus 2-80 karakter' });
            }

            if (normalizedName !== user.name) {
                user.name = normalizedName;
                changes.push('nama');
            }
        }

        if (typeof email === 'string') {
            const normalizedEmail = normalizeEmail(email);
            if (!isValidEmail(normalizedEmail)) {
                return reply.status(400).send({ message: 'Format email tidak valid' });
            }

            const existingUser = await User.findOne({
                email: normalizedEmail,
                _id: { $ne: user._id }
            }).select('_id');

            if (existingUser) {
                return reply.status(400).send({ message: 'Email sudah dipakai akun lain' });
            }

            if (normalizedEmail !== user.email) {
                user.email = normalizedEmail;
                changes.push('email');
            }
        }

        let targetRole = user.role as TeamRole;
        if (role) {
            ensureAssignableRole(actor.role, role);
            if (role !== user.role) {
                targetRole = role;
                user.role = role;
                changes.push('role');
            }
        }

        if (permissions) {
            let finalPermissions = buildPermissions(permissions, targetRole);
            if (!isOwner) {
                finalPermissions = clampPermissionsToActor(finalPermissions, actor.permissions);
            }

            user.permissions = finalPermissions;
            changes.push('permission');
        } else if (role && role !== previousSnapshot.role) {
            let finalPermissions = buildPermissions(undefined, role);
            if (!isOwner) {
                finalPermissions = clampPermissionsToActor(finalPermissions, actor.permissions);
            }

            user.permissions = finalPermissions;
            changes.push('permission default role');
        }

        if (typeof password === 'string' && password.length > 0) {
            if (password.length < 6 || password.length > 100) {
                return reply.status(400).send({ message: 'Password minimal 6 karakter' });
            }

            user.password = password;
            changes.push('password');
        }

        if (changes.length === 0) {
            return reply.status(400).send({ message: 'Tidak ada perubahan yang bisa disimpan' });
        }

        await user.save();

        await writeTeamAuditLog({
            actor: {
                _id: actor._id,
                name: actor.name,
                email: actor.email
            },
            target: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            action: 'update',
            summary: buildUpdateSummary(changes),
            metadata: {
                before: previousSnapshot,
                after: {
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    active: user.active,
                    permissions: serializePermissions(user.permissions)
                }
            }
        });

        return reply.send({
            message: 'Anggota tim berhasil diperbarui',
            user: sanitizeTeamMember(user as any)
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Update team member error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const deleteTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor } = await getActorScope(request);
        const { id } = request.params as { id: string };

        if (id === actor._id.toString()) {
            return reply.status(400).send({ message: 'Akun sendiri tidak dapat diarsipkan dari halaman ini' });
        }

        const user = await getTeamMemberById(id);
        ensureManageScope(actor.role, user.role);

        user.active = false;
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        await user.save();

        await writeTeamAuditLog({
            actor: {
                _id: actor._id,
                name: actor.name,
                email: actor.email
            },
            target: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            action: 'archive',
            summary: 'Mengarsipkan akun tim tanpa menghapus histori audit'
        });

        return reply.send({ message: 'Anggota tim diarsipkan dan dinonaktifkan' });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Delete team member error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const deactivateTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor } = await getActorScope(request);
        const { id } = request.params as { id: string };

        if (id === actor._id.toString()) {
            return reply.status(400).send({ message: 'Akun sendiri tidak dapat diaktifkan atau dinonaktifkan dari halaman ini' });
        }

        const user = await getTeamMemberById(id);
        ensureManageScope(actor.role, user.role);

        user.active = !user.active;
        if (!user.active) {
            user.sessionVersion = (user.sessionVersion || 0) + 1;
        }
        await user.save();

        await writeTeamAuditLog({
            actor: {
                _id: actor._id,
                name: actor.name,
                email: actor.email
            },
            target: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            action: user.active ? 'activate' : 'deactivate',
            summary: user.active ? 'Mengaktifkan kembali akun tim' : 'Menonaktifkan akun tim'
        });

        return reply.send({
            message: user.active ? 'Akun tim berhasil diaktifkan' : 'Akun tim berhasil dinonaktifkan',
            user: sanitizeTeamMember(user as any)
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Deactivate team member error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const resetTeamMemberTwoFactor = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor, isOwner } = await getActorScope(request);
        const { id } = request.params as { id: string };

        if (!isOwner) {
            return reply.status(403).send({ message: 'Hanya owner yang dapat reset 2FA anggota tim' });
        }

        const user = await getTeamMemberById(id);
        user.twoFactorEnabled = false;
        user.twoFactorSecret = undefined;
        user.twoFactorPendingSecret = undefined;
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        await user.save();

        await writeTeamAuditLog({
            actor: {
                _id: actor._id,
                name: actor.name,
                email: actor.email
            },
            target: {
                _id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
            action: 'update',
            summary: 'Reset 2FA akun tim karena recovery authenticator'
        });

        return reply.send({
            message: '2FA anggota tim berhasil direset',
            user: sanitizeTeamMember(user as any)
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Reset team member 2FA error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getLoginLogs = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { actor, isOwner } = await getActorScope(request);
        const { id } = request.params as { id: string };
        const query = request.query as LoginLogQuery;
        const page = parsePositiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInt(query.limit, 20, 100);
        const skip = (page - 1) * limit;

        const member = await getTeamMemberById(id);
        if (!isOwner && member.role !== 'cs') {
            return reply.status(403).send({ message: 'Hanya owner yang dapat melihat log login admin' });
        }

        const [logs, totalLogs] = await Promise.all([
            LoginLog.find({ user: id })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            LoginLog.countDocuments({ user: id })
        ]);

        return reply.send({
            logs,
            currentPage: page,
            totalPages: Math.max(1, Math.ceil(totalLogs / limit)),
            totalLogs,
            pageSize: limit,
            scope: isOwner ? 'owner' : actor.role
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get login logs error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getAllLoginLogs = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { isOwner } = await getActorScope(request);
        const query = request.query as LoginLogQuery;
        const page = parsePositiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInt(query.limit, 20, 100);
        const skip = (page - 1) * limit;

        const teamMembers = await User.find({
            role: isOwner ? { $in: ['owner', 'admin', 'cs'] } : 'cs'
        }).select('_id');
        const teamMemberIds = teamMembers.map((member) => member._id);

        const [logs, totalLogs] = await Promise.all([
            LoginLog.find({ user: { $in: teamMemberIds } })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            LoginLog.countDocuments({ user: { $in: teamMemberIds } })
        ]);

        return reply.send({
            logs,
            currentPage: page,
            totalPages: Math.max(1, Math.ceil(totalLogs / limit)),
            totalLogs,
            pageSize: limit
        });
    } catch (error) {
        if (error instanceof TeamControllerError) {
            return reply.status(error.statusCode).send({ message: error.message });
        }

        console.error('Get all login logs error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getTeamAuditLogs = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as LoginLogQuery;
        const page = parsePositiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInt(query.limit, 10, 50);
        const skip = (page - 1) * limit;

        const [logs, totalLogs] = await Promise.all([
            TeamAuditLog.find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            TeamAuditLog.countDocuments({})
        ]);

        return reply.send({
            logs,
            currentPage: page,
            totalPages: Math.max(1, Math.ceil(totalLogs / limit)),
            totalLogs,
            pageSize: limit
        });
    } catch (error) {
        console.error('Get team audit logs error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
