import './telemetry';
import dotenv from 'dotenv';
import { connectDB } from './config/db';
import { buildApp } from './app';
import { assertJwtSecretConfigured } from './utils/jwt';
import { resolveServerHost } from './config/serverHost';

dotenv.config();

const start = async () => {
    try {
        assertJwtSecretConfigured();
        await connectDB();
        const app = await buildApp();
        const PORT = process.env.PORT || 9005;
        const HOST = resolveServerHost(process.env);
        await app.listen({ port: Number(PORT), host: HOST });
        console.log(`Server running on ${HOST}:${PORT}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();