import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FaultMessageSchema } from "./orchestration.schemas.js";

/** Same file as the infra repo's injector tests (decision P-05): both sides parse it. */
const FIXTURE = new URL("../../../test/fixtures/fault-message.json", import.meta.url);
const fixture: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("FaultMessageSchema", () => {
  it("parses the shared cross-repo fixture", () => {
    expect(FaultMessageSchema.parse(fixture)).toEqual(fixture);
  });

  it.each(["userId", "sessionId", "faultId", "sentAt"])("requires %s", (key) => {
    const message = { ...(fixture as Record<string, unknown>), [key]: undefined };
    expect(FaultMessageSchema.safeParse(message).success).toBe(false);
  });

  it("rejects an unknown fault type", () => {
    const message = { ...(fixture as Record<string, unknown>), type: "CORRUPT_DB" };
    expect(FaultMessageSchema.safeParse(message).success).toBe(false);
  });
});
