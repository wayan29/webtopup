import { FastifyRequest, FastifyReply } from 'fastify';
import { createWriteStream, readdirSync, statSync, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

const generateFileName = (originalName: string): string => {
    const ext = path.extname(originalName).toLowerCase();
    const hash = crypto.randomBytes(8).toString('hex');
    const timestamp = Date.now();
    return `${timestamp}-${hash}${ext}`;
};

const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
];

const isSafeUploadFilename = (filename: string): boolean => (
    filename.trim().length > 0
    && filename === path.basename(filename)
    && !filename.includes('/')
    && !filename.includes('\\')
    && !filename.includes('..')
    && !filename.includes('\0')
);

export const uploadFile = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const data = await request.file();
        
        if (!data) {
            return reply.status(400).send({ message: 'No file uploaded' });
        }

        const { type } = request.query as { type?: string };
        
        // Validate type
        const validTypes = ['icons', 'covers', 'popups', 'instructions'];
        const folder = validTypes.includes(type || '') ? type : 'icons';

        // Validate mime type
        if (!allowedMimeTypes.includes(data.mimetype)) {
            return reply.status(400).send({ message: 'Invalid file type. Only images allowed.' });
        }

        // Generate unique filename
        const fileName = generateFileName(data.filename);
        const uploadPath = path.join(UPLOAD_DIR, folder!, fileName);

        // Save file
        await pipeline(data.file, createWriteStream(uploadPath));

        // Return URL path
        const fileUrl = `/uploads/${folder}/${fileName}`;

        return reply.send({
            success: true,
            url: fileUrl,
            filename: fileName
        });
    } catch (error) {
        console.error('Error uploading file:', error);
        return reply.status(500).send({ message: 'Failed to upload file' });
    }
};

export const uploadMultiple = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const parts = request.files();
        const { type } = request.query as { type?: string };
        
        const validTypes = ['icons', 'covers', 'popups', 'instructions'];
        const folder = validTypes.includes(type || '') ? type : 'icons';

        const uploadedFiles: { url: string; filename: string }[] = [];

        for await (const data of parts) {
            if (!allowedMimeTypes.includes(data.mimetype)) {
                continue;
            }

            const fileName = generateFileName(data.filename);
            const uploadPath = path.join(UPLOAD_DIR, folder!, fileName);

            await pipeline(data.file, createWriteStream(uploadPath));

            uploadedFiles.push({
                url: `/uploads/${folder}/${fileName}`,
                filename: fileName
            });
        }

        return reply.send({
            success: true,
            files: uploadedFiles
        });
    } catch (error) {
        console.error('Error uploading files:', error);
        return reply.status(500).send({ message: 'Failed to upload files' });
    }
};

export const listFiles = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { type } = request.query as { type?: string };
        
        const validTypes = ['icons', 'covers', 'popups', 'instructions'];
        const folder = validTypes.includes(type || '') ? type : 'icons';
        
        const folderPath = path.join(UPLOAD_DIR, folder!);
        
        try {
            const files = readdirSync(folderPath);
            const fileList = files
                .filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
                })
                .map(file => {
                    const filePath = path.join(folderPath, file);
                    const stats = statSync(filePath);
                    return {
                        url: `/uploads/${folder}/${file}`,
                        filename: file,
                        size: stats.size,
                        uploadedAt: stats.mtime.toISOString()
                    };
                })
                .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
            
            return reply.send({
                success: true,
                files: fileList,
                folder: folder
            });
        } catch {
            return reply.send({
                success: true,
                files: [],
                folder: folder
            });
        }
    } catch (error) {
        console.error('Error listing files:', error);
        return reply.status(500).send({ message: 'Failed to list files' });
    }
};

export const deleteFile = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { type, filename } = request.query as { type?: string; filename?: string };
        
        if (!filename) {
            return reply.status(400).send({ message: 'Filename is required' });
        }

        if (!isSafeUploadFilename(filename)) {
            return reply.status(404).send({ message: 'File not found' });
        }

        const validTypes = ['icons', 'covers', 'popups', 'instructions'];
        const folder = validTypes.includes(type || '') ? type : 'icons';
        const folderPath = path.resolve(UPLOAD_DIR, folder!);
        const filePath = path.resolve(folderPath, filename);

        if (!filePath.startsWith(folderPath + path.sep)) {
            return reply.status(404).send({ message: 'File not found' });
        }

        try {
            unlinkSync(filePath);
            return reply.send({ success: true, message: 'File deleted successfully' });
        } catch {
            return reply.status(404).send({ message: 'File not found' });
        }
    } catch (error) {
        console.error('Error deleting file:', error);
        return reply.status(500).send({ message: 'Failed to delete file' });
    }
};
