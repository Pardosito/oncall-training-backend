import { describe, expect, it } from "vitest";
import { createFixedClock } from "./clock.js";

describe("createFixedClock", () => {
  it("returns the same time until advanced", () => {
    const clock = createFixedClock("2026-11-05T10:00:00.000Z");

    expect(clock.now().toISOString()).toBe("2026-11-05T10:00:00.000Z");
    clock.advance(90);
    expect(clock.now().toISOString()).toBe("2026-11-05T10:01:30.000Z");
  });

  it("returns a new Date each call so callers can't mutate the clock", () => {
    const clock = createFixedClock();
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
