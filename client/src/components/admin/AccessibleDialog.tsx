import { createPortal } from 'react-dom';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"]):not([aria-hidden="true"])',
].join(',');

export interface AccessibleDialogProps {
    open: boolean;
    titleId: string;
    descriptionId: string;
    initialFocusRef?: RefObject<HTMLElement | null>;
    returnFocusRef?: RefObject<HTMLElement | null>;
    parentDialogRef?: RefObject<HTMLElement | null>;
    dialogRef?: RefObject<HTMLDivElement | null>;
    busy?: boolean;
    onClose: () => void;
    children: ReactNode;
}

/**
 * A small modal primitive for admin dialogs. It owns the document-level modal
 * behavior so callers only need to provide labelled content and close policy.
 */
export default function AccessibleDialog({
    open,
    titleId,
    descriptionId,
    initialFocusRef,
    returnFocusRef,
    parentDialogRef,
    dialogRef: externalDialogRef,
    busy = false,
    onClose,
    children,
}: AccessibleDialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const busyRef = useRef(busy);
    const onCloseRef = useRef(onClose);
    busyRef.current = busy;
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!open) return undefined;

        const dialog = dialogRef.current;
        const previousFocus = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const parentDialog = parentDialogRef?.current
            ?? previousFocus?.closest<HTMLElement>('[role="dialog"]')
            ?? null;
        const previousOverflow = document.body.style.overflow;
        const previousParentInert = parentDialog?.inert ?? false;

        document.body.style.overflow = 'hidden';
        if (parentDialog) parentDialog.inert = true;

        const focusInitial = () => {
            const requestedFocus = initialFocusRef?.current;
            const initialFocus = requestedFocus && dialog?.contains(requestedFocus)
                ? requestedFocus
                : dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog;
            initialFocus?.focus();
        };
        const focusTimer = window.setTimeout(focusInitial, 0);

        const isOwnedByNestedDialog = () => {
            const activeElement = document.activeElement;
            if (!(activeElement instanceof HTMLElement)) return false;
            const owningDialog = activeElement.closest<HTMLElement>('[data-accessible-dialog="true"]');
            return owningDialog !== null && owningDialog !== dialog;
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!dialog || isOwnedByNestedDialog()) return;

            if (event.key === 'Escape') {
                if (busyRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
                .filter((element) => !element.hasAttribute('aria-hidden') && !element.hasAttribute('disabled'));
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
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (parentDialog) parentDialog.inert = previousParentInert;

            const requestedReturnFocus = returnFocusRef?.current;
            const focusTarget = requestedReturnFocus?.isConnected
                ? requestedReturnFocus
                : previousFocus?.isConnected
                    ? previousFocus
                    : null;
            focusTarget?.focus();
        };
    }, [open, initialFocusRef, returnFocusRef, parentDialogRef]);

    if (!open) return null;

    const content = (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current();
            }}
        >
            <div
                ref={(node) => {
                    dialogRef.current = node;
                    if (externalDialogRef) externalDialogRef.current = node;
                }}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
                aria-busy={busy ? 'true' : undefined}
                tabIndex={-1}
                data-accessible-dialog="true"
                className="ui-panel ui-border flex max-h-[min(90vh,52rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl outline-none"
            >
                {children}
            </div>
        </div>
    );

    // A dialog must be outside an inert parent in the DOM. The portal also
    // lets a picker opened from another admin dialog inert that parent.
    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}
