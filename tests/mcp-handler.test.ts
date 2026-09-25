import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LexwareClient } from "../src/lexware/client.js";
import { registerTools } from "../src/tools/index.js";
import { TicketStore } from "../src/uploads/tickets.js";

/**
 * The tools, registered on the REAL SDK server and driven through `createMcpHandler`, the
 * same wiring server.ts mounts on /mcp. Every other tool test uses a fake `registerTool`,
 * which cannot notice a call shape the SDK rejects or a schema it cannot convert.
 */
const config = loadConfig({ LEXWARE_API_KEY: "key", MCP_ALLOW_UNAUTHENTICATED: "true" } as NodeJS.ProcessEnv);
const profile = { organizationId: "org-1", companyName: "Acme GmbH" };
const client = { get: async () => profile } as unknown as LexwareClient;

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "lexware-office", version: "0.0.0-test" }, { capabilities: {} });
  registerTools(server, client, config, new TicketStore());
  return server;
});

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  // Stateless 2025 serving may answer as a one-event SSE stream or as plain JSON.
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  return JSON.parse(json) as { result?: Record<string, unknown>; error?: unknown };
}

describe("tools on the real SDK server", () => {
  it("lists every tool with its input schema and a mirrored annotations.title", async () => {
    const { result, error } = await rpc("tools/list");
    expect(error).toBeUndefined();
    const tools = result!.tools as {
      name: string;
      title?: string;
      inputSchema: { type: string; properties?: Record<string, unknown> };
      annotations?: { title?: string };
    }[];
    expect(tools.length).toBeGreaterThan(20);
    const getArticle = tools.find((t) => t.name === "get-article")!;
    expect(getArticle.inputSchema.type).toBe("object");
    expect(Object.keys(getArticle.inputSchema.properties ?? {})).toEqual(["id"]);
    for (const t of tools) expect(t.annotations?.title, t.name).toBe(t.title);
  });

  it("calls a tool and appends the structured result as JSON text", async () => {
    const { result, error } = await rpc("tools/call", { name: "get-profile", arguments: {} });
    expect(error).toBeUndefined();
    expect(result!.structuredContent).toEqual(profile);
    const content = result!.content as { type: string; text: string }[];
    expect(content.at(-1)).toEqual({ type: "text", text: JSON.stringify(profile) });
  });

  it("rejects arguments that fail the input schema", async () => {
    const { result } = await rpc("tools/call", { name: "get-article", arguments: {} });
    expect(result!.isError).toBe(true);
  });
});
