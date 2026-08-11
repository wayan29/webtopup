import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import {
    TEAM_ACCESS_GROUPS,
    getEffectiveTeamAccess,
    summarizeEffectiveTeamAccess,
    type TeamAccessMember,
    type TeamAccessStatus,
} from '../../lib/teamAccess.ts';

export type TeamAccessDialogMember = TeamAccessMember & {
    name: string;
    email: string;
    twoFactorEnabled?: boolean;
};

export interface TeamAccessDialogProps {
    member: TeamAccessDialogMember;
    onClose: () => void;
}

const statusLabels: Record<TeamAccessStatus, string> = {
    available: 'Tersedia',
    'step-up': 'Tersedia · perlu verifikasi ulang',
    'owner-only': 'Khusus owner',
    'role-limited': 'Terbatas oleh scope role',
    suspended: 'Ditangguhkan karena akun nonaktif',
    unavailable: 'Tidak tersedia',
};

const roleLabels = {
    owner: 'Owner',
    admin: 'Admin',
    cs: 'CS',
} as const;

const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(',');

export default function TeamAccessDialog({ member, onClose }: TeamAccessDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const access = useMemo(() => getEffectiveTeamAccess(member), [member]);
    const summary = useMemo(() => summarizeEffectiveTeamAccess(access), [access]);
    const configuredStatus = member.role === 'owner'
        ? member.active ? 'Akses penuh' : 'Akses penuh dikonfigurasi · ditangguhkan'
        : member.active ? 'Akses aktif' : 'Akses ditangguhkan';

    useEffect(() => {
        const previousFocus = document.activeElement as HTMLElement | null;
        const dialog = dialogRef.current;
        const initialFocus = dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog;
        initialFocus?.focus();

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !dialog) return;
            const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
                .filter((element) => !element.hasAttribute('aria-hidden'));
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0]!;
            const last = focusable[focusable.length - 1]!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            if (previousFocus?.isConnected) previousFocus.focus();
        };
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="team-access-dialog-title"
                aria-describedby="team-access-dialog-description"
                tabIndex={-1}
                className="ui-panel ui-border flex max-h-[min(90vh,48rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none"
            >
                <div className="ui-card-gradient flex shrink-0 items-start justify-between gap-4 border-b ui-border p-5 sm:p-6">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 id="team-access-dialog-title" className="truncate text-xl font-black ui-text sm:text-2xl">
                                Akses efektif · {member.name}
                            </h2>
                            <span className="rounded-full px-2.5 py-1 text-xs font-bold ui-accent-chip">
                                {roleLabels[member.role]}
                            </span>
                        </div>
                        <p id="team-access-dialog-description" className="mt-1 break-all text-sm ui-text-muted">
                            {member.email}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                            <span className={member.active ? 'ui-success-chip rounded-full px-2.5 py-1' : 'ui-warning-chip rounded-full px-2.5 py-1'}>
                                {configuredStatus}
                            </span>
                            <span className="ui-info-chip rounded-full px-2.5 py-1">
                                2FA {member.twoFactorEnabled ? 'aktif' : 'belum aktif'}
                            </span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Tutup detail akses"
                        className="ui-muted-action shrink-0 rounded-xl p-2"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
                    <div className="mb-5 grid gap-3 sm:grid-cols-4">
                        <div className="ui-panel-muted rounded-xl border ui-border p-3">
                            <div className="text-xs ui-text-muted">Akses tersedia</div>
                            <div className="mt-1 text-xl font-black ui-text">{summary.availableCount}</div>
                        </div>
                        <div className="ui-panel-muted rounded-xl border ui-border p-3">
                            <div className="text-xs ui-text-muted">Pengelolaan</div>
                            <div className="mt-1 text-xl font-black ui-text">{summary.managedCount}</div>
                        </div>
                        <div className="ui-panel-muted rounded-xl border ui-border p-3">
                            <div className="text-xs ui-text-muted">Aksi operasional</div>
                            <div className="mt-1 text-xl font-black ui-text">{summary.actionCount}</div>
                        </div>
                        <div className="ui-panel-muted rounded-xl border ui-border p-3">
                            <div className="text-xs ui-text-muted">Perlu verifikasi ulang</div>
                            <div className="mt-1 text-xl font-black ui-text">{summary.stepUpCount}</div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        {TEAM_ACCESS_GROUPS.map((group) => {
                            const entries = access.filter((entry) => entry.groupId === group.id);
                            return (
                                <section key={group.id} aria-labelledby={`team-access-group-${group.id}`} className="rounded-2xl border ui-border ui-panel-muted p-4">
                                    <h3 id={`team-access-group-${group.id}`} className="text-sm font-black ui-text">
                                        {group.label}
                                    </h3>
                                    <div className="mt-3 space-y-2">
                                        {entries.map((entry) => (
                                            <div key={entry.id} className="rounded-xl border ui-border bg-[var(--ui-card-bg)] p-3">
                                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-bold ui-text">{entry.label}</div>
                                                        <div className="mt-1 text-xs leading-relaxed ui-text-muted">{entry.detail}</div>
                                                    </div>
                                                    <span className="shrink-0 text-xs font-bold ui-text" data-access-status={entry.status}>
                                                        {statusLabels[entry.status]}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                        {entries.length === 0 && (
                                            <p className="text-xs ui-text-muted">Tidak ada detail akses pada area ini.</p>
                                        )}
                                    </div>
                                </section>
                            );
                        })}
                    </div>
                </div>

                <div className="ui-card-gradient shrink-0 border-t ui-border p-4 text-xs leading-relaxed ui-text-muted sm:p-5">
                    Status di atas menjelaskan eligibility normal, termasuk area Keamanan pribadi. Guard backend, scope target, enrollment 2FA, step-up, rate limit, CSRF, dan idempotensi tetap menjadi otoritas akhir.
                </div>
            </div>
        </div>
    );
}
