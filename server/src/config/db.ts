export const connectDB = async () => {
    if (process.env.MONGO_URI) {
        throw new Error('MONGO_URI is not part of the SQL runtime');
    }
    const databaseUrl = process.env.DATABASE_URL || '';
    const database = decodeURIComponent(databaseUrl.split('?')[0]?.split('/').pop() || '');
    if (!database || ['pobb', 'ppob', 'webtopup'].includes(database)) {
        throw new Error(`DATABASE_URL target is not allowed: ${database || '(missing)'}`);
    }
};
