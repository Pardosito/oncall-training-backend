import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Scenario, ScenarioSchema, toPublic, toSummary } from "./index.js";

const SCENARIOS_DIR = new URL("../../../scenarios/", import.meta.url);

const valid: Scenario = {
  id: "orders-down",
  title: "Orders service is not responding",
  description: "Checkout requests are failing with 5xx.",
  warmupSeconds: 20,
  maxResolveSeconds: 600,
  targets: ["gateway", "orders", "worker-svc"],
  baseline: { gateway: 1, orders: 2, "worker-svc": 1 },
  faults: [{ type: "SCALE_TO_ZERO", target: "orders" }],
  availableActions: ["ACKNOWLEDGE", "VIEW_LOGS", "RESTART_DEPLOYMENT", "SCALE_DEPLOYMENT"],
  validFixes: [{ type: "SCALE_DEPLOYMENT", target: "orders", minReplicas: 1 }],
  scoring: { base: 1000, perSecondTTD: 1, perSecondTTR: 1, perWrongAction: 25 },
};

function issuePaths(input: unknown): string[] {
  const result = ScenarioSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("ScenarioSchema", () => {
  it("accepts the ARCHITECTURE §7.5 example", () => {
    expect(issuePaths(valid)).toEqual([]);
  });

  it("rejects a baseline key that isn't a target", () => {
    expect(issuePaths({ ...valid, baseline: { ...valid.baseline, payments: 1 } })).toEqual([
      "baseline.payments",
    ]);
  });

  it("rejects a fault target that isn't a target", () => {
    expect(issuePaths({ ...valid, faults: [{ type: "DELETE_PODS", target: "db" }] })).toEqual([
      "faults.0.target",
    ]);
  });

  it("rejects a fix target that isn't a target", () => {
    const validFixes = [{ type: "RESTART_DEPLOYMENT", target: "db" }];
    expect(issuePaths({ ...valid, validFixes })).toEqual(["validFixes.0.target"]);
  });

  it("rejects a fix type that isn't in availableActions", () => {
    expect(issuePaths({ ...valid, availableActions: ["ACKNOWLEDGE", "VIEW_LOGS"] })).toEqual([
      "validFixes.0.type",
    ]);
  });

  it.each([0, 4, undefined])("rejects a scale fix with minReplicas %s", (minReplicas) => {
    const validFixes = [{ type: "SCALE_DEPLOYMENT", target: "orders", minReplicas }];
    expect(issuePaths({ ...valid, validFixes })).toEqual(["validFixes.0.minReplicas"]);
  });

  it("rejects unknown action and fault types", () => {
    expect(issuePaths({ ...valid, availableActions: ["ROLLBACK"] })).toContain(
      "availableActions.0",
    );
    expect(issuePaths({ ...valid, faults: [{ type: "CORRUPT_DB", target: "orders" }] })).toEqual([
      "faults.0.type",
    ]);
  });

  it("rejects duplicate targets", () => {
    expect(issuePaths({ ...valid, targets: [...valid.targets, "orders"] })).toContain("targets");
  });
});

describe("scenarios/*.json", () => {
  const files = readdirSync(SCENARIOS_DIR).filter((file) => file.endsWith(".json"));

  it("has at least one scenario", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s parses and its file name equals its id", (file) => {
    const raw: unknown = JSON.parse(readFileSync(new URL(file, SCENARIOS_DIR), "utf8"));
    const scenario = ScenarioSchema.parse(raw);
    expect(`${scenario.id}.json`).toBe(file);
  });
});

describe("public views", () => {
  it("toSummary keeps only the picker fields", () => {
    expect(toSummary(valid)).toEqual({
      id: "orders-down",
      title: valid.title,
      description: valid.description,
      maxResolveSeconds: 600,
    });
  });

  it("toPublic never exposes validFixes, faults or baseline", () => {
    const view = JSON.stringify(toPublic(valid));

    expect(view).not.toContain("validFixes");
    expect(view).not.toContain("minReplicas");
    expect(view).not.toContain("faults");
    expect(view).not.toContain("SCALE_TO_ZERO");
    expect(view).not.toContain("baseline");
  });

  it("toPublic keeps what the console needs", () => {
    expect(toPublic(valid)).toMatchObject({
      targets: valid.targets,
      availableActions: valid.availableActions,
      warmupSeconds: 20,
      maxResolveSeconds: 600,
    });
  });
});
