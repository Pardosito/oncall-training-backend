import type { Scenario } from "../scenarios/index.js";

export type ScoreInput = {
  faultInjectedAt: string;
  /** Unset when the user never acknowledged: TTD then equals TTR. */
  acknowledgedAt?: string | undefined;
  resolvedAt: string;
  wrongActions: number;
  scoring: Scenario["scoring"];
};

export type ScoreResult = { ttdSeconds: number; ttrSeconds: number; score: number };

/** Whole seconds between two ISO timestamps, rounded to the nearest second, never negative. */
export function secondsBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.max(0, Math.round(ms / 1000));
}

export function ttrSeconds(input: Pick<ScoreInput, "faultInjectedAt" | "resolvedAt">): number {
  return secondsBetween(input.faultInjectedAt, input.resolvedAt);
}

export function ttdSeconds(
  input: Pick<ScoreInput, "faultInjectedAt" | "acknowledgedAt" | "resolvedAt">,
): number {
  if (!input.acknowledgedAt) return ttrSeconds(input);
  return Math.min(secondsBetween(input.faultInjectedAt, input.acknowledgedAt), ttrSeconds(input));
}

/** ARCHITECTURE §7.5: `max(0, base − perSecondTTD·TTD − perSecondTTR·TTR − perWrongAction·wrong)`. */
export function computeScore(input: ScoreInput): ScoreResult {
  const ttd = ttdSeconds(input);
  const ttr = ttrSeconds(input);
  const { base, perSecondTTD, perSecondTTR, perWrongAction } = input.scoring;
  const raw = base - perSecondTTD * ttd - perSecondTTR * ttr - perWrongAction * input.wrongActions;
  return { ttdSeconds: ttd, ttrSeconds: ttr, score: Math.max(0, Math.round(raw)) };
}
