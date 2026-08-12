export type AuditAction = 'create' | 'update' | 'delete' | 'execute';

export type AuditLogAppliedQuery = {
  search: string;
  action: AuditAction | '';
  resource: string;
  startDate: string;
  endDate: string;
  page: number;
};

export type AuditLogFilterDraft = Omit<AuditLogAppliedQuery, 'page'>;

export type AuditQueryValidation =
  | { ok: true; value: AuditLogAppliedQuery; canonicalQueryString: string }
  | { ok: false; message: string; field: keyof AuditLogFilterDraft | 'page' };

export type AuditDraftValidation =
  | { ok: true; value: AuditLogFilterDraft }
  | { ok: false; message: string; field: keyof AuditLogFilterDraft };

const AUDIT_ACTIONS = new Set<AuditAction>(['create', 'update', 'delete', 'execute']);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const isAuditAction = (value: string): value is AuditAction =>
  AUDIT_ACTIONS.has(value as AuditAction);

const isExactCalendarDate = (value: string): boolean => {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
};

const validateFilterFields = (
  draft: AuditLogFilterDraft,
): AuditDraftValidation => {
  const search = draft.search.trim();
  if (search && (search.length < 2 || search.length > 120)) {
    return {
      ok: false,
      field: 'search',
      message: 'Pencarian harus 2–120 karakter atau dikosongkan.',
    };
  }

  const action = draft.action.trim();
  if (action && !isAuditAction(action)) {
    return {
      ok: false,
      field: 'action',
      message: 'Aksi audit tidak valid.',
    };
  }

  const resource = draft.resource.trim();
  if (resource && (resource.length < 1 || resource.length > 120)) {
    return {
      ok: false,
      field: 'resource',
      message: 'Resource harus 1–120 karakter atau dikosongkan.',
    };
  }

  const startDate = draft.startDate.trim();
  if (startDate && !isExactCalendarDate(startDate)) {
    return {
      ok: false,
      field: 'startDate',
      message: 'Tanggal mulai tidak valid.',
    };
  }

  const endDate = draft.endDate.trim();
  if (endDate && !isExactCalendarDate(endDate)) {
    return {
      ok: false,
      field: 'endDate',
      message: 'Tanggal akhir tidak valid.',
    };
  }

  if (startDate && endDate && startDate > endDate) {
    return {
      ok: false,
      field: 'startDate',
      message: 'Tanggal mulai tidak boleh lebih besar dari tanggal akhir.',
    };
  }

  return {
    ok: true,
    value: {
      search,
      action: action as AuditAction | '',
      resource,
      startDate,
      endDate,
    },
  };
};

export function serializeAuditLogQuery(query: AuditLogAppliedQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set('q', query.search);
  if (query.action) params.set('action', query.action);
  if (query.resource) params.set('resource', query.resource);
  if (query.startDate) params.set('startDate', query.startDate);
  if (query.endDate) params.set('endDate', query.endDate);
  if (query.page > 1) params.set('page', String(query.page));
  return params;
}

export function validateAuditLogDraft(draft: AuditLogFilterDraft): AuditDraftValidation {
  return validateFilterFields(draft);
}

export function parseAuditLogSearchParams(params: URLSearchParams): AuditQueryValidation {
  const draftResult = validateFilterFields({
    search: params.get('q') || '',
    action: (params.get('action') || '') as AuditAction | '',
    resource: params.get('resource') || '',
    startDate: params.get('startDate') || '',
    endDate: params.get('endDate') || '',
  });
  if (!draftResult.ok) {
    return draftResult;
  }

  const rawPage = params.get('page');
  let page = 1;
  if (rawPage !== null && rawPage.trim() !== '') {
    if (!/^\d+$/.test(rawPage.trim())) {
      return {
        ok: false,
        field: 'page',
        message: 'Nomor halaman tidak valid.',
      };
    }
    page = Number(rawPage.trim());
    if (!Number.isInteger(page) || page < 1 || page > 10_000) {
      return {
        ok: false,
        field: 'page',
        message: 'Nomor halaman harus antara 1 dan 10000.',
      };
    }
  }

  const value: AuditLogAppliedQuery = {
    ...draftResult.value,
    page,
  };
  return {
    ok: true,
    value,
    canonicalQueryString: serializeAuditLogQuery(value).toString(),
  };
}

export function auditPaginationRange(
  page: number,
  limit: number,
  total: number,
): { start: number; end: number } {
  if (total <= 0) {
    return { start: 0, end: 0 };
  }
  const start = ((page - 1) * limit) + 1;
  const end = Math.min(page * limit, total);
  return { start, end };
}

export function auditPageCorrection(
  page: number,
  totalPages: number,
  total: number,
): number | null {
  if (total <= 0) {
    return page === 1 ? null : 1;
  }
  if (page > totalPages) {
    return totalPages;
  }
  return null;
}
