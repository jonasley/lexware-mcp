import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/express";
import express, { type Express } from "express";

/** The binds `createMcpExpressApp` guards against DNS rebinding; mirrored exactly. */
const DNS_REBINDING_GUARDED_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * The bare Express app `server.ts` builds on: DNS-rebinding protection for a localhost
 * bind, and deliberately NO body parser.
 *
 * Hand-rolled rather than `createMcpExpressApp` from `@modelcontextprotocol/express`,
 * because that helper installs an app-wide `express.json()` as its first layer, with no
 * option to leave it out. That layer would sit ahead of every middleware this project
 * registers, including the auth gate and the upload routes' own `express.raw()`. Both of
 * those orderings matter:
 *
 * - A pre-auth parser buffers and parses a body for an UNAUTHENTICATED request.
 *   `server.ts` mounts the raised-limit parser on `/mcp` *after* the auth gate precisely
 *   so that cannot happen.
 * - It would pre-parse `/upload/:ticket` bodies. For a `Content-Type: application/json`
 *   upload `req.body` would then be a parsed object rather than a `Buffer`, and a naive
 *   length guard reads that as an empty-but-successful upload while still consuming the
 *   ticket.
 *
 * So nothing is parsed app-wide; `server.ts` mounts the parsers it wants, where it wants
 * them. The host and origin checks are the SDK's own middleware, applied under the same
 * condition `createMcpExpressApp` uses. They read headers only, never the body.
 *
 * Shared with `tests/uploads-routes.test.ts` and `tests/http-app.test.ts`, so the tests
 * exercise the same stack production runs and a parser added here fails them.
 */
export function createBaseApp(host: string): Express {
  const app = express();
  if (DNS_REBINDING_GUARDED_HOSTS.includes(host)) {
    app.use(localhostHostValidation());
    app.use(localhostOriginValidation());
  }
  return app;
}
