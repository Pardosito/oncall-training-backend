import type { HealthCheckResult } from "./mock-cluster.gateway.js";

export const HEALTH_CHECK_TIMEOUT_MS = 1500;

/**
 * HTTP GET on `MOCK_HEALTH_URL_TEMPLATE` with `{service}` replaced (CONVENTIONS §9, BE-079).
 * Any non-2xx, network error or timeout (1.5 s) is unhealthy. Never throws.
 */
export function createHttpHealthChecker(deps: {
  urlTemplate: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}): (service: string) => Promise<HealthCheckResult> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const timeoutMs = deps.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  return async (service) => {
    const url = deps.urlTemplate.replaceAll("{service}", encodeURIComponent(service));
    const started = now();
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      const latencyMs = Math.round(now() - started);
      return { healthy: res.ok, latencyMs };
    } catch {
      return { healthy: false };
    }
  };
}
