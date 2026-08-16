/**
 * React binding for the shared step-up orchestrator.
 * Pages use this instead of per-page pendingActionRef / dialog state.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import StepUpDialog from '../components/auth/StepUpDialog.tsx';
import {
  getSharedStepUpOrchestrator,
  STEP_UP_AMBIGUOUS_STATUS_MESSAGE,
  type StepUpActionGroup,
  type StepUpDialogSnapshot,
  type StepUpOrchestrator,
} from './withStepUp.ts';
import type { ApiV2RequestConfig } from '../api/index.ts';
import { useAuthStore } from '../store/useAuthStore.ts';

export type UseStepUpOrchestrationResult = {
  run: <T>(
    actionGroup: StepUpActionGroup,
    execute: (config: ApiV2RequestConfig) => Promise<T>,
    baseConfig?: ApiV2RequestConfig,
  ) => Promise<T>;
  cancel: () => void;
  dialog: ReactElement;
  dialogOpen: boolean;
  ambiguousMessage: string | null;
  clearAmbiguous: () => void;
  ambiguousStatusMessage: string;
  orchestrator: StepUpOrchestrator;
};

export function useStepUpOrchestration(): UseStepUpOrchestrationResult {
  const orchestrator = useMemo(() => getSharedStepUpOrchestrator(), []);
  const twoFactorEnabled = useAuthStore((state) => state.user?.twoFactorEnabled === true);
  const [snapshot, setSnapshot] = useState<StepUpDialogSnapshot>(() => orchestrator.getDialog());
  const [ambiguousMessage, setAmbiguousMessage] = useState<string | null>(
    () => orchestrator.getAmbiguousMessage(),
  );

  useEffect(() => orchestrator.subscribe(setSnapshot), [orchestrator]);
  useEffect(() => orchestrator.subscribeAmbiguous(setAmbiguousMessage), [orchestrator]);

  // Unmount does not cancel: multi-step pages may remount. Session lifecycle cancels explicitly.

  const dialogContent = (
    <StepUpDialog
      open={snapshot.open}
      actionGroup={(snapshot.actionGroup ?? 'security.sessions_all') as StepUpActionGroup}
      error={snapshot.error}
      busy={snapshot.busy}
      twoFactorEnabled={twoFactorEnabled}
      onClose={() => {
        orchestrator.cancel('dialog-close');
      }}
      onSubmit={async (password, otp) => {
        await orchestrator.completeWithCredentials(password, otp);
      }}
    />
  );
  const dialog = typeof document === 'undefined' ? dialogContent : createPortal(dialogContent, document.body);

  return {
    run: orchestrator.run,
    cancel: () => orchestrator.cancel('manual'),
    dialog,
    dialogOpen: snapshot.open,
    ambiguousMessage,
    clearAmbiguous: () => orchestrator.clearAmbiguous(),
    ambiguousStatusMessage: STEP_UP_AMBIGUOUS_STATUS_MESSAGE,
    orchestrator,
  };
}
