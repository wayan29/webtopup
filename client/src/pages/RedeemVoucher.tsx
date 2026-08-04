import { useState } from 'react';
import { apiV2 } from '../api';
import { Gift, ArrowRight, CheckCircle, AlertCircle } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';

export default function RedeemVoucher() {
    const [code, setCode] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const { syncProfile } = useAuthStore();

    const handleRedeem = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!code) return;

        setLoading(true);
        setMessage(null);

        try {
            const res = await apiV2
                .post('/vouchers/redeem', { code });
            setMessage({ type: 'success', text: `Berhasil! Rp ${res.data.amount.toLocaleString('id-ID')} ditambahkan ke saldo Kamu.` });
            setCode('');
            void syncProfile();
        } catch (error: any) {
            const msg = error.response?.data?.message || 'Gagal redeem voucher';
            setMessage({ type: 'error', text: msg });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white p-4 md:p-6 space-y-6">
            {/* Header */}
            <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-r from-[#1f1f35] via-[#1b1b2f] to-[#11111f] p-5 sm:p-6">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(255,141,70,0.2),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(109,152,255,0.22),transparent_30%)]" />
                </div>
                <div className="relative">
                    <h1 className="text-2xl font-bold text-white">Redeem Voucher</h1>
                    <p className="text-gray-400 mt-1">Tukar kode voucher untuk menambah saldo.</p>
                </div>
            </div>

            <div className="bg-[#25252d] rounded-xl border border-white/5 p-8 max-w-xl mx-auto">
                <div className="flex items-center justify-center mb-6">
                    <div className="h-16 w-16 bg-orange-500/20 rounded-full flex items-center justify-center">
                        <Gift className="h-8 w-8 text-orange-400" />
                    </div>
                </div>

                <div className="text-center mb-8">
                    <h2 className="text-lg font-semibold text-white">Punya kode voucher?</h2>
                    <p className="text-gray-400 mt-1">Masukkan kode voucher di bawah untuk menukar saldo.</p>
                </div>

                <form onSubmit={handleRedeem} className="space-y-4">
                    <div>
                        <input
                            type="text"
                            value={code}
                            onChange={(e) => setCode(e.target.value.toUpperCase())}
                            placeholder="Masukkan Kode Voucher"
                            className="block w-full text-center text-2xl font-mono tracking-widest uppercase bg-[#1a1a1f] border border-white/10 rounded-lg focus:border-orange-500 focus:outline-none p-4 text-white placeholder-gray-500"
                            required
                        />
                    </div>

                    {message && (
                        <div className={`p-4 rounded-lg flex items-center ${message.type === 'success' ? 'bg-green-500/10 border border-green-500/30 text-green-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'}`}>
                            {message.type === 'success' ? <CheckCircle className="h-5 w-5 mr-2" /> : <AlertCircle className="h-5 w-5 mr-2" />}
                            {message.text}
                        </div>
                    )}

                    <button
                        type="submit"
                        disabled={loading || !code}
                        className="w-full flex justify-center items-center py-3 px-4 rounded-lg text-sm font-semibold text-white bg-orange-500 hover:bg-orange-600 focus:outline-none disabled:opacity-50 transition-colors"
                    >
                        {loading ? 'Memproses...' : (
                            <>
                                Redeem Sekarang <ArrowRight className="ml-2 h-4 w-4" />
                            </>
                        )}
                    </button>
                </form>
            </div>
        </div>
    );
}
