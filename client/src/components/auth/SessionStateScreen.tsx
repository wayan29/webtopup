type SessionStateScreenProps = {
    returnTo: string;
    onRetry?: () => void;
    variant?: 'offline-stale' | 'rate-limited' | 'bootstrap-retry' | 'refreshing';
    detailMessage?: string | null;
};

const COPY = {
    'offline-stale': {
        title: 'Koneksi tidak stabil',
        body: 'Sesi Anda belum kedaluwarsa, tetapi aplikasi tidak dapat memverifikasi status login saat ini. Periksa koneksi internet Anda lalu coba lagi.',
    },
    'rate-limited': {
        title: 'Terlalu banyak percobaan',
        body: 'Sesi Anda tetap tersimpan. Tunggu sekitar 15 menit tanpa menekan ulang, lalu muat ulang halaman ini.',
    },
    'bootstrap-retry': {
        title: 'Verifikasi sesi tertunda',
        body: 'Sesi Anda masih ada, tetapi aplikasi belum dapat menyelesaikan verifikasi login. Coba lagi untuk melanjutkan ke halaman tujuan.',
    },
    refreshing: {
        title: 'Memperbarui sesi',
        body: 'Sesi Anda sedang diperbarui. Mohon tunggu sebentar.',
    },
} as const;

export default function SessionStateScreen({
    returnTo,
    onRetry,
    variant = 'offline-stale',
    detailMessage = null,
}: SessionStateScreenProps) {
    const copy = COPY[variant];

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
            <div className="max-w-md w-full rounded-xl border border-gray-200 bg-white p-8 shadow-sm text-center">
                <h1 className="text-xl font-semibold text-gray-900">{copy.title}</h1>
                <p className="mt-3 text-sm text-gray-600">{copy.body}</p>
                {detailMessage ? (
                    <p className="mt-2 text-xs text-gray-500 break-words">{detailMessage}</p>
                ) : null}
                <p className="mt-2 text-xs text-gray-500 break-all">Halaman tujuan: {returnTo}</p>
                {onRetry ? (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="mt-6 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                    >
                        Coba lagi
                    </button>
                ) : null}
            </div>
        </div>
    );
}