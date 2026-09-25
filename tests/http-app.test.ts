import express from "express";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { createBaseApp } from "../src/http-app.js";

/**
 * Pins the two properties of the base app that `server.ts` depends on.
 *
 * No app-level body parser: the auth gate must see a request before any body is buffered,
 * and the upload routes' `express.raw()` must see the real bytes. The SDK's
 * `createMcpExpressApp` would install one, which is why `createBaseApp` exists; a parser
 * added back here fails these tests rather than production quietly regaining a pre-auth
 * body-buffering path.
 *
 * DNS-rebinding protection on a localhost bind: a browser page on a foreign origin must not
 * reach a server that only listens on 127.0.0.1.
 */
async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("createBaseApp parses no bodies", () => {
  it("leaves the body unparsed for a JSON request", async () => {
    const app = createBaseApp("127.0.0.1");
    app.post("/probe", (req, res) => {
      res.json({ type: typeof req.body, isBuffer: Buffer.isBuffer(req.body) });
    });
    const s = await listen(app);
    const res = await fetch(`${s.url}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    // Express 5 defaults req.body to undefined when no parser touched it. The point is
    // that it is NOT the parsed {hello:"world"} object.
    expect((await res.json()).type).not.toBe("object");
    await s.close();
  });

  it("does not enforce a size limit, because it never reads the stream", async () => {
    // The real risk this guards: a parser that still runs pre-auth would reject or
    // buffer a large body before the auth gate ever saw the request.
    const app = createBaseApp("127.0.0.1");
    app.post("/probe", (_req, res) => res.json({ reached: true }));
    const s = await listen(app);
    const res = await fetch(`${s.url}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(200_000) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
    await s.close();
  });

  it("still lets a later, path-scoped parser do its job", async () => {
    // server.ts mounts express.json({limit}) on /mcp AFTER the auth gate.
    const app = createBaseApp("127.0.0.1");
    app.use("/mcp", express.json({ limit: "12mb" }));
    app.post("/mcp", (req, res) => res.json({ got: req.body }));
    const s = await listen(app);
    const res = await fetch(`${s.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(await res.json()).toEqual({ got: { hello: "world" } });
    await s.close();
  });

  it("leaves a raw parser the real bytes, whatever the content type claims", async () => {
    // Critical-1 in miniature: a JSON-content-typed upload must reach express.raw() as a
    // Buffer, not as a parsed object.
    const app = createBaseApp("0.0.0.0");
    app.post("/upload", express.raw({ type: () => true }), (req, res) => {
      res.json({ isBuffer: Buffer.isBuffer(req.body), len: (req.body as Buffer)?.length ?? -1 });
    });
    const s = await listen(app);
    const payload = JSON.stringify({ not: "really json to us" });
    const res = await fetch(`${s.url}/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(await res.json()).toEqual({ isBuffer: true, len: Buffer.byteLength(payload) });
    await s.close();
  });
});

describe("createBaseApp guards a localhost bind against DNS rebinding", () => {
  function probe(host: string) {
    const app = createBaseApp(host);
    app.get("/status", (_req, res) => res.json({ status: "ok" }));
    return app;
  }

  it("serves a request addressed to the loopback host", async () => {
    const s = await listen(probe("127.0.0.1"));
    const res = await fetch(`${s.url}/status`);
    expect(res.status).toBe(200);
    await s.close();
  });

  it("refuses a foreign Host header and a foreign Origin", async () => {
    const s = await listen(probe("127.0.0.1"));
    const port = new URL(s.url).port;
    const badHost = await rawGet(port, { host: "evil.example.com" });
    expect(badHost).toBe(403);
    const res = await fetch(`${s.url}/status`, { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
    await s.close();
  });

  it("does not apply the localhost checks to a wildcard bind (containers)", async () => {
    const s = await listen(probe("0.0.0.0"));
    const port = new URL(s.url).port;
    expect(await rawGet(port, { host: "mcp.example.com" })).toBe(200);
    await s.close();
  });
});

/** GET /status with an arbitrary Host header, which fetch() does not let a caller set. */
async function rawGet(port: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/status", method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}
