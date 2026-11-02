import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createHealthServer } from "./process.js";
import type { Server } from "node:http";

let server: Server | undefined;

afterEach(async () => {
  if (server?.listening) await closeServer(server, 100);
  server = undefined;
});

async function listen(s: Server): Promise<string> {
  await new Promise<void>((resolve) => s.listen(0, resolve));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("createHealthServer", () => {
  it("answers 200 while healthy and 503 once stopping", async () => {
    let healthy = true;
    server = createHealthServer(() => healthy);
    const base = await listen(server);

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    healthy = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });

  it("answers 404 for other paths", async () => {
    server = createHealthServer(() => true);
    const base = await listen(server);

    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});

describe("closeServer", () => {
  it("resolves after the server stops listening", async () => {
    server = createHealthServer(() => true);
    await listen(server);

    await closeServer(server, 1_000);

    expect(server.listening).toBe(false);
  });
});
