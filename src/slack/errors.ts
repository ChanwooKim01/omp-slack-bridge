/**
 * errors.ts — Reading the machine-readable parts of Slack Web API errors.
 */

/** Used when Slack rate-limits a call without saying how long to wait. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Errors from the Web API carry the machine-readable code in `data.error`; transport errors in `code`.
 */
export function slackErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    if ("data" in error && error.data && typeof error.data === "object" && "error" in error.data && error.data.error) {
      return String(error.data.error);
    }
    if ("code" in error && error.code) return String(error.code);
    if ("message" in error && error.message) return String(error.message);
  }
  return String(error);
}

function positiveSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Seconds Slack asks the caller to wait when `error` is a rate-limit response, otherwise undefined.
 * Covers both shapes the Web API client produces: the dedicated rate-limited error (thrown when
 * `rejectRateLimitedCalls` is on) and a platform error whose code is `ratelimited`.
 */
export function slackRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as {
    code?: unknown;
    retryAfter?: unknown;
    data?: { error?: unknown; response_metadata?: { retryAfter?: unknown } };
  };
  if (candidate.code === "slack_webapi_rate_limited_error") {
    return positiveSeconds(candidate.retryAfter) ?? DEFAULT_RETRY_AFTER_SECONDS;
  }
  if (candidate.data?.error === "ratelimited") {
    return positiveSeconds(candidate.data.response_metadata?.retryAfter) ?? DEFAULT_RETRY_AFTER_SECONDS;
  }
  return undefined;
}
