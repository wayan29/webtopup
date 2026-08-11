import { FastifyRequest, FastifyReply } from 'fastify';
import { User, ITeamPermissions } from '../models';
import { sendAuthError } from '../utils/authErrors';
import { authenticateSession, authenticateUnlockSession } from './sessionAuth';

export interface AuthRequest extends FastifyRequest {
    user?: {
        id: string;
        email: string;
        role: 'owner' | 'admin' | 'cs' | 'member';
        permissions?: ITeamPermissions;
        sessionId?: string;
        /** Present for browser bearer authentication; absent for separately trusted API-key contexts. */
        authMode?: 'legacy' | 'refresh-session';
    };
}

export type PermissionKey = keyof ITeamPermissions;

export const hasResolvedPermission = (permissions: ITeamPermissions | undefined, permission: PermissionKey) => {
    if (!permissions) {
        return false;
    }

    if (permissions[permission] === true) {
        return true;
    }

    if (permission === 'viewTeam' && permissions.manageTeam === true) {
        return true;
    }

    if (permission === 'viewVendors' && permissions.manageVendors === true) {
        return true;
    }

    if (permission === 'viewProducts' && permissions.manageProducts === true) {
        return true;
    }

    if (permission === 'manageVouchers' && permissions.manageProducts === true) {
        return true;
    }

    if (permission === 'viewPayment' && permissions.managePayment === true) {
        return true;
    }

    if (permission === 'viewUsers' && permissions.manageUsers === true) {
        return true;
    }

    if (permission === 'viewSettings' && permissions.manageSettings === true) {
        return true;
    }

    if (permission === 'viewDeposits' && permissions.approveDeposits === true) {
        return true;
    }

    return false;
};

export const authenticate = authenticateSession;
export const authenticateUnlock = authenticateUnlockSession;

// Check if user is owner or admin (for backward compatibility)
export const isAdmin = async (request: AuthRequest, reply: FastifyReply) => {
    if (!request.user || (request.user.role !== 'admin' && request.user.role !== 'owner')) {
        return sendAuthError(reply, 403, 'PERMISSION_DENIED', 'Forbidden: Admin access required');
    }
};

// Check if user is owner only
export const isOwner = async (request: AuthRequest, reply: FastifyReply) => {
    if (!request.user || request.user.role !== 'owner') {
        return sendAuthError(reply, 403, 'PERMISSION_DENIED', 'Forbidden: Owner access required');
    }
};

// Check if user is part of team (owner, admin, or cs)
export const isTeamMember = async (request: AuthRequest, reply: FastifyReply) => {
    if (!request.user || !['owner', 'admin', 'cs'].includes(request.user.role)) {
        return sendAuthError(reply, 403, 'PERMISSION_DENIED', 'Forbidden: Team access required');
    }
};

// Flexible permission check
export const hasPermission = (permission: PermissionKey) => {
    return async (request: AuthRequest, reply: FastifyReply) => {
        if (!request.user) {
            return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized');
        }

        // Owner always has all permissions
        if (request.user.role === 'owner') return;

        // For admin and cs, check specific permission
        if (request.user.role === 'admin' || request.user.role === 'cs') {
            const user = await User.findById(request.user.id).select('permissions active');
            
            if (!user || user.active === false) {
                return sendAuthError(reply, 403, 'AUTH_ACCOUNT_DISABLED', 'Forbidden: Account inactive');
            }

            // Check permission
            if (!hasResolvedPermission(user.permissions, permission)) {
                return sendAuthError(reply, 403, 'PERMISSION_DENIED', 'Forbidden: Permission denied');
            }
        }

        // Members don't have admin panel access
        if (request.user.role === 'member') {
            return sendAuthError(reply, 403, 'PERMISSION_DENIED', 'Forbidden: No access to admin panel');
        }
    };
};

// Legacy support - maps old permission names to new ones
export const authorizeTeam = (permission: 'viewTransactions' | 'viewDeposits' | 'viewReports' | 'viewUsers') => {
    return hasPermission(permission as PermissionKey);
};
