import { useEffect, useRef, useState } from 'react';

export type DeviceSession = {
    sessionId: string;
    deviceLabel: string;
    userAgentSummary: string;
    lastUsedAt: string;
    createdAt: string;
    ipContext: string;
};

type Props = {
    sessions: DeviceSession[];
    busy?: boolean;
    onConfirm: (sessionId: string) => Promise<void>;
    onCancel: () => void;
};

export default function DeviceLimitDialog({ sessions, busy, onConfirm, onCancel }: Props) {
    const [selectedSessionId, setSelectedSessionId] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const titleRef = useRef<HTMLHeadingElement>(null);
    useEffect(() => { titleRef.current?.focus(); }, []);
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div role="dialog" aria-modal="true" aria-labelledby="device-limit-title" className="ui-panel ui-border max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-3xl border p-6">
            <h2 id="device-limit-title" ref={titleRef} tabIndex={-1} className="ui-text text-xl font-black">Pilih perangkat untuk dikeluarkan</h2>
            <p className="ui-text-muted mt-2 text-sm">Batas perangkat tercapai. Tidak ada perangkat yang dipilih otomatis.</p>
            <fieldset className="mt-5 space-y-3"><legend className="sr-only">Sesi perangkat</legend>
                {sessions.map((session) => <label key={session.sessionId} className="ui-panel-muted ui-border flex cursor-pointer gap-3 rounded-xl border p-4">
                    <input type="radio" name="device-session" value={session.sessionId} checked={selectedSessionId === session.sessionId} onChange={() => { setSelectedSessionId(session.sessionId); setConfirmed(false); }} />
                    <span><strong className="ui-text block">{session.deviceLabel || 'Perangkat'}</strong><span className="ui-text-muted text-sm">{session.userAgentSummary} · terakhir aktif {new Date(session.lastUsedAt).toLocaleString('id-ID')}</span></span>
                </label>)}
            </fieldset>
            <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" checked={confirmed} disabled={!selectedSessionId} onChange={(event) => setConfirmed(event.target.checked)} /><span>Konfirmasi pilihan perangkat ini akan dikeluarkan</span></label>
            <div className="mt-6 flex justify-end gap-3"><button type="button" className="ui-muted-action rounded-xl px-4 py-3" onClick={onCancel} disabled={busy}>Batal</button><button type="button" className="ui-warning-action rounded-xl px-4 py-3" disabled={!selectedSessionId || !confirmed || busy} onClick={() => void onConfirm(selectedSessionId)}>{busy ? 'Memproses...' : 'Keluarkan & lanjutkan'}</button></div>
        </div>
    </div>;
}
