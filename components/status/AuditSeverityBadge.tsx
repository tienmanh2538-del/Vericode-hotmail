import type { AuditLogSeverity } from "@/services/logs/audit-log.service";

interface AuditSeverityBadgeProps {
  severity: AuditLogSeverity;
}

const VARIANT_BY_SEVERITY: Record<AuditLogSeverity, string> = {
  info: "audit-severity--info",
  notice: "audit-severity--notice",
  warning: "audit-severity--warning",
  error: "audit-severity--error",
};

const LABEL_BY_SEVERITY: Record<AuditLogSeverity, string> = {
  info: "Info",
  notice: "Notice",
  warning: "Warning",
  error: "Error",
};

export function AuditSeverityBadge({ severity }: AuditSeverityBadgeProps) {
  const variant = VARIANT_BY_SEVERITY[severity] ?? "audit-severity--info";
  const label = LABEL_BY_SEVERITY[severity] ?? severity;
  return <span className={`audit-severity ${variant}`}>{label}</span>;
}
