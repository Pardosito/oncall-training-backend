import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger({ level: "info", destination });
  return { logger, lines };
}

describe("createLogger", () => {
  it("redacts auth headers, cookies and task tokens", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      {
        req: { headers: { authorization: "Bearer secret.jwt", cookie: "a=b", host: "api" } },
        taskToken: "token-1",
        session: { task_token: "token-2", sessionId: "s1" },
      },
      "request",
    );

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const output = JSON.stringify(entry);
    expect(output).not.toContain("secret.jwt");
    expect(output).not.toContain("token-1");
    expect(output).not.toContain("token-2");
    expect(output).not.toContain("a=b");
    expect(output).toContain('"host":"api"');
    expect(output).toContain('"sessionId":"s1"');
  });

  it("writes JSON at the configured level", () => {
    const { logger, lines } = captureLogger();

    logger.debug("hidden");
    logger.warn("shown");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ level: 40, msg: "shown" });
  });
});
