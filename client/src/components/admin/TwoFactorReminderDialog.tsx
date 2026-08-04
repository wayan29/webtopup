import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import {
    createEnrollmentDeadlineTimer,
    enrollmentRemainingMs,
    formatEnrollmentReminderMessage,
    parseAuthoritativeTimestamp,
    shouldShowEnrollmentReminder,
} from '../../auth/twoFactorEnrollmentClock.ts';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * Staff 2FA enrollment reminder, shown on the admin dashboard only.
 *
 * Dismissal is per-mount state, so closing it hides the dialog for this visit but navigating
 * back to the dashboard shows it again. Enabling 2FA clears `twoFactorEnabled`, which retires
 * the reminder permanently without any extra bookkeeping. Server enforcement remains the
 * authority: this is guidance, not a gate.
 */
export default function TwoFactorReminderDialog() {
    const user = useAuthStore((state) => state.user);
    const serverTimeOffsetMs = useAuthStore((state) => state.serverTimeOffsetMs);
    const [dismissed, setDismissed] = useState(false);
    const [clockTick, setClockTick] = useState(0);
    const dialogRef = useRef<HTMLDivElement>(null);

    const visible = shouldShowEnrollmentReminder({
        user,
        clientNowMs: Date.now(),
        serverTimeOffsetMs,
        dismissed,
    });

    // Re-render at the deadline so the copy switches from days to hours to overdue while open.
    useEffect(() => {
        const deadlineMs = parseAuthoritativeTimestamp(user?.twoFactorEnrollmentRequiredAt);
        if (!visible || deadlineMs === null || serverTimeOffsetMs === null) return;
        const controller = createEnrollmentDeadlineTimer({
            now: () => Date.now(),
            setTimeout: (fn, ms) => window.setTimeout(fn, ms),
            clearTimeout: (id) => window.clearTimeout(id),
            onTick: () => setClockTick((value) => value + 1),
        });
        controller.start({ deadlineMs, serverTimeOffsetMs });
        return () => controller.stop();
    }, [visible, user?.id, user?.twoFactorEnrollmentRequiredAt, serverTimeOffsetMs]);

    const message = useMemo(() => {
        void clockTick;
        return formatEnrollmentReminderMessage(enrollmentRemainingMs({
            user,
            clientNowMs: Date.now(),
            serverTimeOffsetMs,
        }));
    }, [user, user?.twoFactorEnrollmentRequiredAt, serverTimeOffsetMs, clockTick]);

    // Escape closes, and focus is trapped so keyboard users cannot tab into the page behind.
    useEffect(() => {
        if (!visible) return;
        const dialog = dialogRef.current;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setDismissed(true);
                return;
            }
            if (event.key !== 'Tab' || !dialog) return;
            const focusable = dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
            if (focusable.length === 0) return;
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
        document.addEventListener('keydown', onKeyDown);
        dialog?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [visible]);

    if (!visible) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
            <div
                ref={dialogRef}
                className="ui-panel ui-border w-full max-w-lg rounded-3xl border p-6 shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="two-factor-reminder-title"
                aria-describedby="two-factor-reminder-body"
            >
                <div className="flex items-start gap-4">
                    <div className="ui-warning-chip rounded-2xl p-3"><ShieldAlert className="h-6 w-6" /></div>
                    <div>
                        <h2 id="two-factor-reminder-title" className="ui-text text-xl font-black">
                            Aktifkan autentikasi dua faktor
                        </h2>
                        <p id="two-factor-reminder-body" className="ui-text-muted mt-2 text-sm leading-relaxed">
                            {message} Setelah batas waktu lewat, menu admin hanya dapat digunakan untuk
                            mengaktifkan 2FA.
                        </p>
                    </div>
                </div>
                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
                    <button
                        type="button"
                        onClick={() => setDismissed(true)}
                        className="ui-muted-action rounded-xl px-4 py-3 text-sm font-bold"
                    >
                        Nanti saja
                    </button>
                    <Link
                        to="/admin/security"
                        onClick={() => setDismissed(true)}
                        className="ui-accent-solid inline-flex items-center justify-center rounded-xl px-4 py-3 text-sm font-bold"
                    >
                        Aktifkan sekarang
                    </Link>
                </div>
            </div>
        </div>
    );
}
