import { describe, expect, it } from "vitest";
import { computeScore, secondsBetween, ttdSeconds, ttrSeconds } from "./scoring.js";

const scoring = { base: 1000, perSecondTTD: 1, perSecondTTR: 1, perWrongAction: 25 };
const fault = "2026-11-05T18:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(fault) + seconds * 1000).toISOString();

describe("computeScore", () => {
  it("matches the ARCHITECTURE §8.2 example (TTD 42, TTR 131, 1 wrong → 802)", () => {
    expect(
      computeScore({
        faultInjectedAt: fault,
        acknowledgedAt: at(42),
        resolvedAt: at(131),
        wrongActions: 1,
        scoring,
      }),
    ).toEqual({ ttdSeconds: 42, ttrSeconds: 131, score: 802 });
  });

  it("uses TTR as TTD when the user never acknowledged", () => {
    const result = computeScore({
      faultInjectedAt: fault,
      resolvedAt: at(100),
      wrongActions: 0,
      scoring,
    });
    expect(result).toEqual({ ttdSeconds: 100, ttrSeconds: 100, score: 800 });
  });

  it("never goes below zero", () => {
    const result = computeScore({
      faultInjectedAt: fault,
      acknowledgedAt: at(500),
      resolvedAt: at(600),
      wrongActions: 10,
      scoring,
    });
    expect(result.score).toBe(0);
  });

  it("rounds fractional weights to a whole score", () => {
    const result = computeScore({
      faultInjectedAt: fault,
      acknowledgedAt: at(3),
      resolvedAt: at(3),
      wrongActions: 0,
      scoring: { ...scoring, perSecondTTD: 0.5, perSecondTTR: 0 },
    });
    expect(result.score).toBe(999);
  });
});

describe("seconds", () => {
  it("rounds to the nearest whole second", () => {
    expect(secondsBetween(fault, "2026-11-05T18:00:41.499Z")).toBe(41);
    expect(secondsBetween(fault, "2026-11-05T18:00:41.500Z")).toBe(42);
  });

  it("never returns a negative duration (clock skew between pods)", () => {
    expect(secondsBetween(fault, "2026-11-05T17:59:59.000Z")).toBe(0);
  });

  it("caps TTD at TTR", () => {
    expect(ttdSeconds({ faultInjectedAt: fault, acknowledgedAt: at(90), resolvedAt: at(60) })).toBe(
      60,
    );
    expect(ttrSeconds({ faultInjectedAt: fault, resolvedAt: at(60) })).toBe(60);
  });
});
