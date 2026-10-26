const REDACTED = "[redacted]";

export function isInvalidGrantError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string" && /(?:^|\b)invalid_grant(?:\b|$)/i.test(value)) {
      return true;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      continue;
    }

    seen.add(value);
    const candidate = value as Record<string, unknown>;
    for (const key of ["code", "error", "message", "cause", "response", "data", "errors"]) {
      try {
        pending.push(candidate[key]);
      } catch {
        // Ignore unusual error objects with throwing property accessors.
      }
    }
  }

  return false;
}

export function calendarReauthorizationMessage(runtimeDirectory: string): string {
  return `Google Calendar authorization has expired or been revoked. Reauthorize it manually; OAuth is never started by the worker: dagent --runtime-directory ${JSON.stringify(runtimeDirectory)} services auth calendar`;
}

export function safeCalendarErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  return message
    .replace(/Bearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
    .replace(/([?&](?:access_token|refresh_token|client_secret|client_id)=)[^&\s]+/gi, `$1${REDACTED}`)
    .replace(/(["'](?:access_token|refresh_token|client_secret|client_id)["']\s*:\s*["'])[^"']+/gi, `$1${REDACTED}`)
    .replace(/((?:access_token|refresh_token|client_secret|client_id)\s*[:=]\s*)[^\s,"']+/gi, `$1${REDACTED}`)
    .slice(0, 500);
}
