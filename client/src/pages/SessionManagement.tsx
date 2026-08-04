import { useEffect, useState } from 'react';
import { apiV2 } from '../api';
import { useStepUpOrchestration } from '../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../auth/withStepUp';
import { useAuthStore } from '../store/useAuthStore';

type Session = { sessionId: string; deviceLabel: string; userAgentSummary: string; lastUsedAt: string; createdAt: string; ipContext: string; current: boolean };

export default function SessionManagement() {
    const stepUp = useStepUpOrchestration();
    const [sessions, setSessions] = useState<Session[]>([]);
    const [confirm, setConfirm] = useState<{ kind: 'current' | 'device' | 'all'; id?: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const user = useAuthStore((state) => state.user);
    const logout = useAuthStore((state) => state.logout);
    const load = async () => { try { const response = await apiV2.get('/auth/sessions'); setSessions(response.data.sessions.slice(0, 20)); } catch { setError('Gagal memuat sesi perangkat'); } };
    useEffect(() => { void load(); }, []);
    const act = async () => {
        if (!confirm) return; setBusy(true); setError('');
        try {
            if (confirm.kind === 'current') { await apiV2.post('/auth/sessions/revoke-current', {}, { _skipAuthRefresh: true } as never); await logout(); return; }
            if (confirm.kind === 'all') {
                await stepUp.run(
                    'security.sessions_all',
                    (config) => apiV2.post('/auth/sessions/revoke-all', {}, { ...config, _skipAuthRefresh: true } as never),
                );
                await logout();
                return;
            }
            await apiV2.post('/auth/sessions/revoke-device', { sessionId: confirm.id }, { authRetrySafe: false } as never);
            setConfirm(null); await load();
        } catch (err) {
            const text = stepUpActionErrorMessage(err, 'Tindakan sesi gagal. Periksa status sebelum mencoba lagi.');
            if (text) setError(text);
        } finally { setBusy(false); }
    };
    const staff = user && ['owner', 'admin', 'cs'].includes(user.role);
    return <main className="mx-auto max-w-4xl space-y-6 p-6" aria-labelledby="sessions-title">
        <header><h1 id="sessions-title" className="ui-text text-2xl font-black">Manajemen Sesi</h1><p className="ui-text-muted mt-2 text-sm">{staff ? 'Kebijakan staf: maksimum 2 perangkat, sesi berakhir setelah 8 jam.' : 'Kebijakan member: maksimum 5 perangkat; sesi yang diingat hingga 30 hari.'}</p></header>
        {error && <div role="alert" className="ui-danger-chip rounded-xl p-3">{error}</div>}
        <ul className="space-y-3" aria-label="Daftar sesi perangkat">{sessions.map((session) => <li key={session.sessionId} className="ui-panel ui-border rounded-2xl border p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:justify-between"><div><h2 className="ui-text font-black">{session.deviceLabel || 'Perangkat'} {session.current && <span className="ui-success-chip ml-2 rounded-full px-2 py-1 text-xs">Perangkat saat ini</span>}</h2><p className="ui-text-muted mt-1 text-sm">{session.userAgentSummary} · {session.ipContext}</p><p className="ui-text-muted text-xs">Terakhir aktif: {new Date(session.lastUsedAt).toLocaleString('id-ID')} · Dibuat: {new Date(session.createdAt).toLocaleString('id-ID')}</p></div>
            <button type="button" className="ui-warning-action rounded-xl px-4 py-2 text-sm font-bold" onClick={() => setConfirm(session.current ? { kind: 'current' } : { kind: 'device', id: session.sessionId })}>{session.current ? 'Keluar perangkat ini' : 'Keluarkan perangkat'}</button></div>
        </li>)}</ul>
        <section className="ui-panel ui-border rounded-2xl border p-5"><h2 className="ui-text font-black">Semua perangkat</h2><p className="ui-text-muted my-2 text-sm">Mencabut seluruh sesi dan memerlukan login ulang di semua perangkat.</p><button type="button" className="ui-danger-action rounded-xl px-4 py-3 font-bold" onClick={() => setConfirm({ kind: 'all' })}>Keluar dari semua perangkat</button></section>
        {confirm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div role="dialog" aria-modal="true" aria-labelledby="session-confirm-title" className="ui-panel w-full max-w-md rounded-2xl p-6"><h2 id="session-confirm-title" className="ui-text text-xl font-black">Konfirmasi tindakan sesi</h2><p className="ui-text-muted mt-2 text-sm">Tindakan ini tidak dicoba ulang otomatis jika hasilnya ambigu.</p><div className="mt-5 flex justify-end gap-3"><button disabled={busy} onClick={() => setConfirm(null)}>Batal</button><button disabled={busy} className="ui-danger-action rounded-xl px-4 py-2" onClick={() => void act()}>{busy ? 'Memproses...' : 'Konfirmasi'}</button></div></div></div>}
    {stepUp.dialog}</main>;
}
