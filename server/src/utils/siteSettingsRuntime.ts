export const buildMaintenanceMessage = (message?: string) => {
    const normalized = typeof message === 'string' ? message.trim() : '';
    return normalized || 'Sistem sedang dalam pemeliharaan. Silakan coba beberapa saat lagi.';
};
