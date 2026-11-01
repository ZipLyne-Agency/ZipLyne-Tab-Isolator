import { isSessionId } from "./lib/session-model.js";

// Reports come from page scripts, so nothing in them is trusted or kept unbounded.
export function sanitizeDiagnostics(report) {
  if (!report || typeof report !== "object") return null;
  return {
    sessionId: isSessionId(report.sessionId) ? report.sessionId : null,
    state: String(report.state || "unknown").slice(0, 32),
    serviceWorkerControlled: Boolean(report.serviceWorkerControlled),
    capabilities: Object.fromEntries(
      Object.entries(report.capabilities || {}).map(([key, value]) => [String(key).slice(0, 32), Boolean(value)])
    ),
    warnings: Array.isArray(report.warnings)
      ? report.warnings.map((warning) => String(warning).slice(0, 160)).slice(0, 12)
      : []
  };
}
