import { useMemo } from 'react';
import {
    getEffectiveTeamAccess,
    summarizeEffectiveTeamAccess,
    type TeamPermissionInput,
    type TeamRole,
} from '../../lib/teamAccess.ts';

export interface TeamAccessPreviewProps {
    role: Exclude<TeamRole, 'owner'>;
    permissions: TeamPermissionInput;
    provisional: boolean;
}

export default function TeamAccessPreview({ role, permissions, provisional }: TeamAccessPreviewProps) {
    const access = useMemo(() => getEffectiveTeamAccess({ role, active: true, permissions }), [role, permissions]);
    const summary = useMemo(() => summarizeEffectiveTeamAccess(access), [access]);
    const implications = [
        ['manageProducts', 'viewProducts dan manageVouchers'],
        ['approveDeposits', 'viewDeposits'],
        ['managePayment', 'viewPayment'],
        ['manageUsers', 'viewUsers'],
        ['manageTeam', 'viewTeam'],
        ['manageSettings', 'viewSettings'],
        ['manageVendors', 'viewVendors'],
    ].filter(([source]) => permissions && typeof permissions === 'object' && permissions[source as keyof typeof permissions] === true);

    return (
        <aside className="ui-panel-muted rounded-xl border ui-border p-4" aria-label="Preview akses setelah disimpan">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                <div>
                    <h3 className="text-sm font-black ui-text">Preview akses setelah disimpan</h3>
                    <p className="mt-1 text-xs leading-relaxed ui-text-muted">
                        Ringkasan ini bersifat penjelasan; permission efektif tetap ditentukan backend.
                    </p>
                </div>
                <span className="ui-info-chip shrink-0 rounded-full px-2.5 py-1 text-xs font-bold">Role {role.toUpperCase()}</span>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border ui-border bg-[var(--ui-card-bg)] p-3">
                    <div className="text-[11px] ui-text-muted">Fitur tersedia</div>
                    <div className="mt-1 text-lg font-black ui-text">{summary.availableCount}</div>
                </div>
                <div className="rounded-lg border ui-border bg-[var(--ui-card-bg)] p-3">
                    <div className="text-[11px] ui-text-muted">Pengelolaan</div>
                    <div className="mt-1 text-lg font-black ui-text">{summary.managedCount}</div>
                </div>
                <div className="rounded-lg border ui-border bg-[var(--ui-card-bg)] p-3">
                    <div className="text-[11px] ui-text-muted">Aksi operasional</div>
                    <div className="mt-1 text-lg font-black ui-text">{summary.actionCount}</div>
                </div>
                <div className="rounded-lg border ui-border bg-[var(--ui-card-bg)] p-3">
                    <div className="text-[11px] ui-text-muted">Perlu verifikasi ulang</div>
                    <div className="mt-1 text-lg font-black ui-text">{summary.stepUpCount}</div>
                </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
                {summary.labels.map((label) => (
                    <span key={label} className="ui-accent-chip rounded-full px-2.5 py-1 text-xs font-semibold">{label}</span>
                ))}
                {summary.remainingGroupCount > 0 && (
                    <span className="ui-info-chip rounded-full px-2.5 py-1 text-xs font-semibold">+{summary.remainingGroupCount} area akses</span>
                )}
                {summary.labels.length === 0 && (
                    <span className="text-xs ui-text-muted">Tidak ada akses operasional</span>
                )}
            </div>

            {implications.length > 0 && (
                <div className="mt-4 rounded-lg border ui-border p-3">
                    <div className="text-xs font-bold ui-text">Implikasi permission</div>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-xs ui-text-muted">
                        {implications.map(([source, target]) => <li key={source}><code>{source}</code> juga memberi {target}.</li>)}
                    </ul>
                </div>
            )}

            {provisional && (
                <p className="mt-4 rounded-lg border ui-border p-3 text-xs leading-relaxed ui-warning-text">
                    Preview provisional: permission di luar scope editor dapat di-clamp oleh backend saat disimpan.
                </p>
            )}
        </aside>
    );
}
