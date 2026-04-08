// ── State UI ──────────────────────────────────────────────────────────

interface EmptyStateProps {
  message?: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="empty-state-icon mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-bg-subtle)]">
        <svg
          className="h-6 w-6 text-[var(--color-border-strong)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 9l4 3-4 3M13 15h5" />
        </svg>
      </div>
      {message ? (
        <p className="empty-state-text text-[13px] text-[var(--color-text-muted)]">{message}</p>
      ) : (
        <>
          <p className="empty-state-label text-[13px] font-medium text-[var(--color-text-secondary)]">
            No active sessions
          </p>
          <p className="empty-state-hint mt-1.5 max-w-[240px] text-[12px] leading-relaxed text-[var(--color-text-muted)]">
            Open the orchestrator to queue work or start a session.
          </p>
        </>
      )}
    </div>
  );
}
