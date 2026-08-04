import { FastifyInstance, FastifyReply } from 'fastify';
import { uploadFile, uploadMultiple, listFiles, deleteFile } from '../controllers/uploadController';
import { authenticate, AuthRequest } from '../middlewares/authMiddleware';

type UploadFolder = 'icons' | 'covers' | 'popups' | 'instructions';
type UploadPermission = 'manageProducts' | 'managePayment' | 'manageSettings';

const resolveUploadFolder = (request: AuthRequest): UploadFolder => {
    const { type } = request.query as { type?: string };
    const validTypes: UploadFolder[] = ['icons', 'covers', 'popups', 'instructions'];
    return validTypes.includes((type || '') as UploadFolder) ? (type as UploadFolder) : 'icons';
};

const hasUploadPermission = (request: AuthRequest, permission: UploadPermission) => {
    if (request.user?.role === 'owner') {
        return true;
    }

    return Boolean(request.user?.permissions?.[permission]);
};

const uploadFolderPermissions: Record<UploadFolder, UploadPermission[]> = {
    icons: ['manageProducts', 'managePayment', 'manageSettings'],
    covers: ['manageProducts', 'manageSettings'],
    popups: ['manageProducts', 'manageSettings'],
    instructions: ['manageProducts']
};

const authorizeUploadFolder = async (request: AuthRequest, reply: FastifyReply) => {
    const folder = resolveUploadFolder(request);
    const allowedPermissions = uploadFolderPermissions[folder];

    if (allowedPermissions.some((permission) => hasUploadPermission(request, permission))) {
        return;
    }

    return reply.status(403).send({ message: 'Forbidden: Permission denied' });
};

export default async function uploadRoutes(fastify: FastifyInstance) {
    // Upload single file based on folder scope permission.
    fastify.post('/upload', { preHandler: [authenticate, authorizeUploadFolder] }, uploadFile);
    
    // Upload multiple files based on folder scope permission.
    fastify.post('/upload/multiple', { preHandler: [authenticate, authorizeUploadFolder] }, uploadMultiple);
    
    // List uploaded files based on folder scope permission.
    fastify.get('/upload/list', { preHandler: [authenticate, authorizeUploadFolder] }, listFiles);
    
    // Delete file based on folder scope permission.
    fastify.delete('/upload', { preHandler: [authenticate, authorizeUploadFolder] }, deleteFile);
}
