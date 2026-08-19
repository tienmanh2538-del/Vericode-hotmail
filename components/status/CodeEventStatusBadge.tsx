import {
  CODE_EVENT_STATUS_LABELS,
  type CodeEventStatus,
} from "@/services/logs/code-event-log.service";

interface CodeEventStatusBadgeProps {
  status: CodeEventStatus;
}

const VARIANT_BY_STATUS: Record<CodeEventStatus, string> = {
  CODE_SENT: "code-event-status--sent",
  CODE_DETECTED: "code-event-status--detected",
  CODE_SKIPPED_DUPLICATE: "code-event-status--skipped",
  CODE_SKIPPED_LOW_CONFIDENCE: "code-event-status--skipped",
  CODE_SKIPPED_STALE: "code-event-status--skipped",
  DETECTOR_REJECTED: "code-event-status--skipped",
  EXTRACTOR_FAILED: "code-event-status--failed",
  TELEGRAM_SEND_FAILED: "code-event-status--failed",
};

export function CodeEventStatusBadge({ status }: CodeEventStatusBadgeProps) {
  const variant = VARIANT_BY_STATUS[status] ?? "code-event-status--neutral";
  return (
    <span className={`code-event-status ${variant}`}>
      {CODE_EVENT_STATUS_LABELS[status] ?? status}
    </span>
  );
}
