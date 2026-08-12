import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';

export type AuditAction = 'create' | 'update' | 'delete' | 'execute';
export type AuditLogSource = 'Gateway' | 'Domain' | 'Tidak diketahui';

export type AuditLogMetadata = {
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  auditSource?: string;
  traceId?: string;
  correlationSource?: string;
  [key: string]: unknown;
};

export type AuditLogItem = {
  _id: string;
  actorName: string;
  actorEmail: string;
  actorRole: 'owner' | 'admin' | 'cs' | 'member';
  action: AuditAction;
  resource: string;
  method: string;
  path: string;
  statusCode?: number;
  ip?: string;
  userAgent?: string;
  summary: string;
  metadata?: AuditLogMetadata;
  createdAt: string;
};

export interface AuditLogDetailDialogProps {
  item: AuditLogItem;
  trigger: HTMLElement | null;
  onClose: () => void;
}

const actionLabels: Record<AuditAction, string> = {
  create: 'Buat',
  update: 'Ubah',
  delete: 'Hapus',
  execute: 'Eksekusi',
};

const actionClasses: Record<AuditAction, string> = {
  create: 'ui-success-chip',
  update: 'ui-info-chip',
  delete: 'ui-danger-chip',
  execute: 'ui-warning-chip',
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(',');

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const stringifyMetadata = (value: unknown) => {
  if (value === undefined) return '-';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '-';
  }
};

export function resolveAuditLogSource(metadata?: AuditLogMetadata): AuditLogSource {
  if (metadata?.auditSource === 'node_gateway') return 'Gateway';
  if (metadata?.auditSource === 'rust_domain') return 'Domain';
  return 'Tidak diketahui';
}

export default function AuditLogDetailDialog({
  item,
  trigger,
  onClose,
}: AuditLogDetailDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const source = resolveAuditLogSource(item.metadata);
  const paramsText = stringifyMetadata(item.metadata?.params);
  const bodyText = stringifyMetadata(item.metadata?.body);
  const advancedMetadata = useMemo(() => {
    if (!item.metadata) return undefined;
    const { params: _params, body: _body, ...rest } = item.metadata;
    return rest;
  }, [item.metadata]);
  const advancedText = stringifyMetadata(advancedMetadata);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
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
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) {
        trigger.focus();
      }
    };
  }, [onClose, trigger]);

  const copyValue = async (label: string, value: string | undefined) => {
    if (!value || value === '-') {
      setCopyStatus(`${label} gagal disalin.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} berhasil disalin.`);
    } catch {
      setCopyStatus(`${label} gagal disalin.`);
    }
  };

  const details: Array<[string, string, string?]> = [
    ['Aktor', item.actorName],
    ['Email', item.actorEmail],
    ['Peran', item.actorRole],
    ['Tanggal', formatDateTime(item.createdAt)],
    ['Method', item.method],
    ['Endpoint', item.path, item.path],
    ['Status', item.statusCode ? String(item.statusCode) : '-'],
    ['IP', item.ip || '-', item.ip],
    ['User Agent', item.userAgent || '-', item.userAgent],
    ['Sumber audit', source],
    ['Trace ID', item.metadata?.traceId || '-', item.metadata?.traceId],
    ['Correlation source', item.metadata?.correlationSource || '-'],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-log-detail-title"
        aria-describedby="audit-log-detail-description"
        tabIndex={-1}
        className="ui-panel ui-border flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-[0_35px_120px_rgba(0,0,0,0.45)] outline-none sm:max-h-[calc(100dvh-3rem)]"
      >
        <div className="ui-panel-muted ui-border flex shrink-0 items-start justify-between gap-4 border-b p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-black ${actionClasses[item.action]}`}>
                {actionLabels[item.action]}
              </span>
              <span className="ui-accent-chip rounded-full border px-3 py-1 text-xs font-black">{item.resource}</span>
              <span className="ui-info-chip rounded-full border px-3 py-1 text-xs font-black">{source}</span>
              {item.statusCode !== undefined && (
                <span className={`rounded-full border px-3 py-1 text-xs font-black ${item.statusCode >= 400 ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                  HTTP {item.statusCode}
                </span>
              )}
            </div>
            <h2 id="audit-log-detail-title" className="ui-text mt-3 text-xl font-black">Detail Log Audit</h2>
            <p id="audit-log-detail-description" className="ui-text-muted mt-1 break-all text-sm">{item.summary}</p>
            <p className="ui-text-muted mt-2 text-xs">
              Nilai <code>[redacted]</code> berarti secret sengaja disembunyikan.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-muted-action rounded-xl p-2"
            aria-label="Tutup detail audit log"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <dl className="grid gap-4 md:grid-cols-2">
            {details.map(([label, value, copyable]) => (
              <div key={label} className="ui-panel-muted rounded-2xl border ui-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <dt className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">{label}</dt>
                  {copyable ? (
                    <button
                      type="button"
                      onClick={() => copyValue(label, copyable)}
                      className="ui-muted-action inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold"
                    >
                      <Copy className="h-3 w-3" /> Salin
                    </button>
                  ) : null}
                </div>
                <dd className="ui-text mt-2 break-all text-sm font-bold">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section className="ui-panel-muted rounded-2xl border ui-border p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">Params</h3>
                <button
                  type="button"
                  onClick={() => copyValue('Params', paramsText === '-' ? undefined : paramsText)}
                  className="ui-muted-action inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold"
                >
                  <Copy className="h-3 w-3" /> Salin
                </button>
              </div>
              <pre className="ui-text-muted mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
                {paramsText}
              </pre>
            </section>
            <section className="ui-panel-muted rounded-2xl border ui-border p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="ui-text-muted text-xs font-black uppercase tracking-[0.14em]">Body</h3>
                <button
                  type="button"
                  onClick={() => copyValue('Body', bodyText === '-' ? undefined : bodyText)}
                  className="ui-muted-action inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold"
                >
                  <Copy className="h-3 w-3" /> Salin
                </button>
              </div>
              <pre className="ui-text-muted mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
                {bodyText}
              </pre>
            </section>
          </div>

          <details className="ui-panel-muted mt-4 rounded-2xl border ui-border p-4">
            <summary className="ui-text cursor-pointer text-sm font-black">Metadata lanjutan</summary>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="ui-text-muted text-xs">
                Tidak mengulang Params/Body. Secret tetap ditampilkan sebagai <code>[redacted]</code>.
              </p>
              <button
                type="button"
                onClick={() => copyValue('Metadata lanjutan', advancedText === '-' ? undefined : advancedText)}
                className="ui-muted-action inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold"
              >
                <Copy className="h-3 w-3" /> Salin
              </button>
            </div>
            <pre className="ui-text-muted mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl ui-panel px-3 py-2 text-xs leading-5">
              {advancedText}
            </pre>
          </details>
        </div>

        <div
          role="status"
          aria-live="polite"
          className="ui-panel-muted shrink-0 border-t ui-border px-5 py-3 text-xs font-semibold ui-text-muted"
        >
          {copyStatus || 'Siap menyalin field yang sudah disanitasi.'}
        </div>
      </div>
    </div>
  );
}
