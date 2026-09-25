import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";

/**
 * Pins that a broken tool registration still kills the process at BOOT.
 *
 * `registerTools` runs inside `createServer`, the per-request factory handed to
 * `createMcpHandler`. On its own that would turn a registration error (a duplicate tool
 * name, a schema the SDK refuses to convert) from a boot failure into a 500 on every /mcp
 * request, with `/status` still answering 200, so Cloud Run's startup probe passes and a
 * revision that cannot serve a single request takes all the traffic.
 *
 * `server.ts` prevents that by building one sample server at module scope, before
 * `app.listen()`. Anything registration throws therefore propagates out of the import with
 * no port bound. This test poisons `registerTools` and asserts the import rejects with that
 * error. `PORT` points at a socket this test already holds: if the sample build is ever
 * moved past `listen()`, boot hits EADDRINUSE instead and the message assertion below
 * catches it, rather than the suite silently leaking a listening server.
 *
 * In its own file because it mocks a module the rest of the suite uses for real, and
 * because importing `server.ts` is one-shot — module evaluation is cached per worker.
 */
const registerTools = vi.hoisted(() => vi.fn());

vi.mock("../src/tools/index.js", () => ({ registerTools }));

it("aborts module evaluation when tool registration throws, before binding a port", async () => {
  registerTools.mockImplementation(() => {
    throw new Error("registration is broken");
  });

  const occupied = createServer();
  await new Promise<void>((r) => occupied.listen(0, "127.0.0.1", r));
  const { port } = occupied.address() as AddressInfo;

  vi.stubEnv("LEXWARE_API_KEY", "test-key");
  vi.stubEnv("MCP_ALLOW_UNAUTHENTICATED", "true");
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("PORT", String(port));

  let thrown: unknown;
  try {
    await import("../src/server.js");
  } catch (err) {
    thrown = err;
  }

  try {
    expect(thrown, "importing server.ts must reject, not start serving").toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("registration is broken");
    // The sample server server.ts builds — one registration pass, during boot.
    expect(registerTools).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((r) => occupied.close(() => r()));
    vi.unstubAllEnvs();
  }
});
