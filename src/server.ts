import { mcpAuthMetadataRouter } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, UnsupportedProtocolVersionError } from "@modelcontextprotocol/server";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearerAuthMiddleware } from "./auth.js";
import { type Config, ConfigError, describeCapabilities, loadConfig } from "./config.js";
import { createBaseApp } from "./http-app.js";
import { buildServerInstructions } from "./instructions.js";
import { LexwareClient } from "./lexware/client.js";
import { advertisedScopes, buildOAuthMetadata, oauthGate, protectedResourceMetadataUrl } from "./oauth.js";
import { createFinalizeConfirmation } from "./tools/finalize-confirmation.js";
import { registerTools } from "./tools/index.js";
import { registerUploadRoutes } from "./uploads/routes.js";
import { TicketStore } from "./uploads/tickets.js";

/** Base64 file uploads (upload-file / upload-voucher-file) travel inline in the JSON-RPC body. */
const JSON_BODY_LIMIT = "12mb";

// Fail fast with a clear, secret-free message on any misconfiguration.
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const client = new LexwareClient({
  baseUrl: config.lexwareApiBaseUrl,
  apiKey: config.lexwareApiKey,
  debug: config.debugLogging,
});

// Ticket-gated upload path: bytes go browser/curl -> server -> Lexware, never through
// the model context. Shared store so the MCP tools can issue and read tickets that the
// upload routes consume.
//
// Module scope, NOT inside createServer: that runs on EVERY request. A
// per-request store would mean a ticket issued by one request is unknown to the request
// that redeems it, so every upload would fail. The same goes for `client` above — it
// holds the token-bucket rate limiter, and one bucket per request is no limiter at all
// (which is also why the deployment runs --max-instances=1).
export const uploadTickets = new TicketStore();

// Human confirmation for create-finalized-* (LEXWARE_FINALIZE_ELICITATION); undefined when
// off. Module scope for the same reason as the tickets: it remembers which approvals were
// used, and its key must be the one that minted the state the client echoes back.
const finalizeConfirmation = createFinalizeConfirmation(config.finalizeElicitation, config.requestStateKey);

/**
 * Build the MCP server for one request, with every enabled tool registered.
 *
 * Per request, and synchronous, so it does registration and nothing else. A fresh server
 * per request is what `createMcpHandler`'s factory contract asks for: the SDK stamps the
 * negotiated protocol version on the instance, so sharing one would pin concurrent callers
 * to a single version.
 *
 * It costs ~23ms of blocking CPU per request (53 tools at the read+drafts tier), which
 * is most of the server's own time. That tier has 39 tools since the per-type get-<type>
 * and render-<type>-pdf tools were folded into get-document and get-document-file, so
 * read the figures below as an upper bound. Measured over HTTP against the built image:
 *
 *   /status        2.1ms      <- no registration
 *   initialize    29.5ms      <- pays for all 53 tool schemas and uses none of them
 *   tools/list    41.3ms
 *
 * Where it goes, measured by running the real registerTools twice against a server whose
 * registerTool drops `inputSchema` in one pass and keeps it in the other:
 *
 *   registration, as it runs today            22.9ms
 *   the same, minus the SDK's zod -> JSON     4.7ms   <- all the rest is ours
 *   Schema conversion
 *
 * So ~79% is `_createRegisteredTool` calling `standardSchemaToJsonSchema` on every
 * registration, and zod does NOT memoize `~standard.jsonSchema.input()`: converting ONE
 * hoisted instance 300 times costs a median 0.84ms every time and returns a fresh object
 * on each call; a per-registration `z.object(shape)` costs 1.03ms. Hoisting buys 18%, not
 * the ~100% a memo would. The remaining 4.7ms is ours and is hoistable, at the price of
 * lifting every `inputSchema` literal in src/tools/ to module scope. Not taken: a fifth
 * of a cost whose other four fifths are upstream.
 */
function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "lexware-office",
      title: "Lexware Office",
      description: "Contacts, sales documents, vouchers and files in Lexware Office.",
      websiteUrl: "https://github.com/marselsel/Lexware-MCP-Server",
      version: "0.2.0",
    },
    {
      capabilities: {},
      // Sent when a client connects: how the tools fit together, scoped to the enabled tiers.
      instructions: buildServerInstructions(config.capabilities),
      // Verifies the signed requestState a client echoes back with its confirmation, before
      // the handler runs. Without the hook the SDK would hand the handler the raw, unverified
      // string.
      ...(finalizeConfirmation ? { requestState: { verify: finalizeConfirmation.verify } } : {}),
    },
  );
  registerTools(server, client, config, uploadTickets, finalizeConfirmation);
  return server;
}

// Registration fails at BOOT, not per request, even though createServer runs per request:
// building one sample server here, before the port is bound, means a duplicate tool name
// or a schema the SDK refuses to convert aborts module evaluation, instead of leaving a
// revision that answers /status with 200 and every /mcp call with a 500. A test pins it:
// tests/server-boot-registration.test.ts.
createServer();

const mcpHandler = createMcpHandler(createServer, {
  onerror: (error) => {
    // A client asking for a protocol version this SDK does not speak is answered with the
    // right error already; logging it too would only be noise.
    if (error instanceof UnsupportedProtocolVersionError) return;
    console.error("[lexware-mcp] Error handling MCP request:", error);
  },
});
const nodeMcpHandler = toNodeHandler(mcpHandler);

const app = createBaseApp(config.host);

// Unauthenticated health check. Use `/status`, not `/healthz`: Google Front End
// intercepts `/healthz` on Cloud Run (it never reaches the container).
app.get("/status", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// Gate the MCP endpoint according to the configured auth mode.
if (config.auth.mode === "oauth") {
  const oauth = config.auth;
  // Advertise the authorization server so MCP clients can discover and sign in.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildOAuthMetadata(oauth),
      resourceServerUrl: new URL(oauth.resource),
      // Undefined unless OAUTH_SCOPES_SUPPORTED is set, which keeps `scopes_supported`
      // out of the protected-resource document exactly as before (see advertisedScopes).
      scopesSupported: advertisedScopes(oauth),
    }),
  );
  app.use("/mcp", ...oauthGate(oauth, protectedResourceMetadataUrl(oauth.resource)));
} else if (config.auth.mode === "static") {
  app.use("/mcp", bearerAuthMiddleware(config.auth.token));
}
// mode "none": no gate (operator explicitly opted into unauthenticated).

// Parse /mcp bodies at the raised limit — mounted AFTER the auth gate above, so an
// unauthenticated request is rejected before any multi-MB body is buffered or parsed.
// The MCP handler below receives `req.body` as the pre-parsed body; the base app has no
// parser of its own (see http-app.ts).
app.use("/mcp", express.json({ limit: JSON_BODY_LIMIT }));

app.use("/mcp", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Express strips the mount path from req.url ("/mcp" becomes "/"). Restore it so the
    // SDK builds the correct request URL.
    req.url = req.originalUrl;
    await nodeMcpHandler(req, res, req.body);
  } catch (error) {
    next(error);
  }
});

// The ticket-gated upload routes are a drafts-tier WRITE path (they push a file into the
// Lexware file store), so mount them only when the drafts capability is enabled. Without
// this, a read-only deployment (LEXWARE_READ_ONLY, or drafts explicitly off) would still
// expose the unauthenticated POST /upload/:ticket route wired to Lexware's write API —
// unreachable, since no ticket can be issued without the drafts-only create-upload-ticket
// tool, but a write route has no business existing on a server configured not to write.
//
// They read the body themselves with express.raw(); with no app-level parser, that raw
// parser is the first thing to touch an upload body.
if (config.capabilities.drafts) {
  registerUploadRoutes(app, uploadTickets, async ({ bytes, filename, contentType, type }) =>
    client.postMultipart<{ id: string }>("/v1/files", { bytes, filename, contentType }, { type }),
  );
}

console.error(
  `[lexware-mcp] starting — ${describeCapabilities(config)} bodyLimit=${JSON_BODY_LIMIT} (/mcp, post-auth)`,
);
for (const warning of config.warnings) {
  console.error(`[lexware-mcp] WARNING: ${warning}`);
}
if (config.auth.mode === "oauth" && config.auth.allowedEmailDomains.length === 0) {
  console.error(
    "[lexware-mcp] WARNING: OAuth mode with no OAUTH_ALLOWED_EMAIL_DOMAINS — ANY user who can " +
      "authenticate with your issuer can reach this server. Set OAUTH_ALLOWED_EMAIL_DOMAINS to restrict access.",
  );
}
if (config.auth.mode === "none") {
  console.error(
    "[lexware-mcp] WARNING: /mcp is UNAUTHENTICATED (MCP_ALLOW_UNAUTHENTICATED=true). Anyone who can reach " +
      "this port can use every enabled tool. Bind to localhost / a private network only, and prefer a browser " +
      "that blocks DNS-rebinding; configure OAUTH_ISSUER or MCP_AUTH_TOKEN for any shared or public deployment.",
  );
}

// Last in the stack: a JSON-RPC error body for anything that escaped the /mcp handler,
// instead of Express's default HTML page.
app.use("/mcp", (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[lexware-mcp] Error handling MCP request:", err);
  if (!res.headersSent) {
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

const httpServer = app.listen(config.port, config.host, () => {
  console.error(`[lexware-mcp] listening on ${config.host}:${config.port}`);
});
httpServer.on("error", (error) => {
  console.error("[lexware-mcp] Failed to start server:", error);
  process.exit(1);
});

// Drain on SIGTERM (Cloud Run, docker stop) and Ctrl+C. A second signal falls through to
// Node's default and quits at once; a drain that hangs is cut off after 3s.
const shutdown = () => {
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
  mcpHandler.close().catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
