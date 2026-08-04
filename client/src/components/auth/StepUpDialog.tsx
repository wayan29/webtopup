import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bindIdleLockFocusTrap } from '../../auth/idleLockFocus.ts';
import type { StepUpActionGroup } from '../../auth/stepUp.ts';

type Props = {
  open: boolean;
  actionGroup: StepUpActionGroup;
  error?: string | null;
  busy?: boolean;
  onSubmit(password: string, otp: string): Promise<void>;
  onClose(): void;
};

const GROUP_LABELS: Record<StepUpActionGroup, string> = {
  'finance.adjust_balance': 'penyesuaian saldo',
  'finance.refund': 'refund transaksi',
  'finance.deposit_approval': 'persetujuan deposit',
  'transactions.manual': 'tindakan transaksi manual',
  'integrations.credentials': 'kredensial integrasi',
  'team.manage_privileged': 'kelola tim istimewa',
  'team.reset_2fa': 'reset 2FA staf',
  'security.sessions_all': 'cabut semua sesi',
  'exports.sensitive': 'ekspor data sensitif',
  'security.password': 'perubahan email atau password akun',
};

/**
 * Focus-trapped step-up dialog. Escape closes only before submission starts.
 * Password/OTP are ephemeral and cleared on close.
 */
export default function StepUpDialog({
  open,
  actionGroup,
  error,
  busy = false,
  onSubmit,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setOtp('');
      setSubmitting(false);
      submittedRef.current = false;
      return;
    }
    if (typeof document === 'undefined') return;
    return bindIdleLockFocusTrap(dialog.current, document);
  }, [open]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape only before submission.
      if (submittedRef.current || submitting || busy) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setPassword('');
      setOtp('');
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, submitting, busy, onClose]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || submitting || busy) return;
    setSubmitting(true);
    submittedRef.current = true;
    try {
      await onSubmit(password, otp.trim());
      setPassword('');
      setOtp('');
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (submitting || busy || submittedRef.current) return;
    setPassword('');
    setOtp('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[220] grid place-items-center bg-slate-950/80 p-4" role="presentation">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        className="w-full max-w-md rounded-2xl bg-white p-6 text-slate-900 shadow-2xl"
      >
        <h2 id="step-up-title" className="text-xl font-bold">
          Verifikasi ulang diperlukan
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Masukkan password dan kode OTP untuk mengizinkan {GROUP_LABELS[actionGroup]} selama lima menit.
        </p>
        <form onSubmit={submit} className="mt-5 space-y-4">
          <label className="block text-sm font-semibold">
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
          <label className="block text-sm font-semibold">
            Kode OTP
            <input
              autoComplete="one-time-code"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              disabled={submitting || busy}
              className="flex-1 rounded-lg border px-4 py-2 font-semibold disabled:opacity-50"
            >
              Batal
            </button>
            <button
              type="submit"
              disabled={submitting || busy || !password || !otp.trim()}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {submitting || busy ? 'Memverifikasi…' : 'Lanjutkan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
