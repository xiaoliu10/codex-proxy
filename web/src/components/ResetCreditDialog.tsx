import { useT } from "../../../shared/i18n/context";

export interface ResetCreditDialogProps {
  open: boolean;
  /** Current available count (before this consumption). */
  availableCount: number;
  /** Credit title/id to display, if available. */
  creditTitle: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog for consuming a rate-limit reset credit.
 * Follows the existing fixed-overlay pattern (RuleAssign / ImportExport).
 */
export function ResetCreditDialog({ open, availableCount, creditTitle, busy, onConfirm, onCancel }: ResetCreditDialogProps) {
  const t = useT();

  if (!open) return null;

  const afterCount = Math.max(0, availableCount - 1);

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={busy ? undefined : onCancel}
      onKeyDown={busy ? undefined : (e) => { if (e.key === "Escape") onCancel(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("resetCreditsDialogTitle")}
        class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-6 w-full max-w-md mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-base font-semibold text-slate-800 dark:text-text-main mb-2">
          {t("resetCreditsDialogTitle")}
        </h3>

        <p class="text-sm text-slate-600 dark:text-text-dim mb-4">
          {creditTitle
            ? t("resetCreditsConfirmWithTitle").replace("{title}", creditTitle)
            : t("resetCreditsConfirm")}
        </p>

        <div class="flex items-center justify-between text-sm mb-4 px-3 py-2 rounded-lg bg-slate-50 dark:bg-bg-dark border border-slate-100 dark:border-border-dark">
          <span class="text-slate-500 dark:text-text-dim">{t("resetCreditsAvailable")}</span>
          <span class="font-semibold tabular-nums text-slate-700 dark:text-text-main">
            {availableCount}
            <span class="text-slate-400 dark:text-text-dim mx-1">→</span>
            <span class={afterCount > 0 ? "text-primary" : "text-slate-400 dark:text-text-dim"}>
              {afterCount}
            </span>
          </span>
        </div>

        <div class="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            data-testid="reset-credit-cancel"
            disabled={busy}
            class="px-4 py-2 text-sm font-medium text-slate-600 dark:text-text-dim hover:bg-slate-100 dark:hover:bg-border-dark rounded-lg transition-colors disabled:opacity-40"
          >
            {t("cancelBtn")}
          </button>
          <button
            onClick={onConfirm}
            data-testid="reset-credit-confirm"
            disabled={busy}
            class="px-4 py-2 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-60 bg-primary-action hover:bg-primary-action-hover shadow-sm disabled:cursor-not-allowed"
          >
            {busy ? t("resetCreditsConsuming") : t("resetCreditsConfirmBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
