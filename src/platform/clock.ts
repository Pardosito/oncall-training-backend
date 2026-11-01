/** Injected wherever time matters (scoring, TTLs, timeouts), so tests don't use real time. */
export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export type FixedClock = Clock & {
  advance(seconds: number): void;
  set(date: Date): void;
};

export function createFixedClock(start: Date | string = "2026-01-01T00:00:00.000Z"): FixedClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (seconds) => {
      current += seconds * 1000;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
}
