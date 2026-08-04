export type FocusableDocument = {
  activeElement: Element | null;
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
};

export function bindIdleLockFocusTrap(
  dialog: HTMLElement | null,
  document: FocusableDocument,
): () => void {
  const active = document.activeElement;
  const previous =
    active && typeof (active as HTMLElement).focus === 'function'
      ? (active as HTMLElement)
      : null;
  const focusable = dialog?.querySelector<HTMLElement>('input,button');
  focusable?.focus();

  const trap = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab' || !dialog) return;
    const nodes = [...dialog.querySelectorAll<HTMLElement>('input,button')].filter(
      (node) => !node.hasAttribute('disabled'),
    );
    if (!nodes.length) return;
    const first = nodes[0]!;
    const last = nodes.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener('keydown', trap);
  return () => {
    document.removeEventListener('keydown', trap);
    if (previous?.isConnected) previous.focus();
  };
}