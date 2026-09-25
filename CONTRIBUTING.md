# Contributing

Thanks for your interest in improving the Lexware Office MCP server!

## Development setup

```bash
npm install
cp .env.example .env   # fill in LEXWARE_API_KEY and MCP_AUTH_TOKEN
npm run dev            # server with reload on change, at http://127.0.0.1:8080/mcp
```

> There is no Lexware sandbox host — test against a free [trial account](https://www.lexware.de/).

## Before opening a PR

```bash
npm run build   # typecheck (tsc)
npm test        # vitest
```

CI runs the same checks plus `docker build` and `npm audit`.

## Guidelines

- **Keep Lexware logic transport-agnostic.** Everything in `src/lexware`,
  `src/config.ts`, and `src/tools` should stay independent of the HTTP layer
  (`src/server.ts`, `src/http-app.ts`) so the transport can evolve.
- **Respect the capability tiers.** New write tools must be gated behind the
  appropriate flag (`LEXWARE_ENABLE_DRAFTS` / `LEXWARE_ENABLE_FINALIZE`) and
  registered conditionally in `src/tools/index.ts`. Read tools are always on.
- **Finalizing is irreversible.** Any tool that issues a legally binding
  document must be a separate, finalize-tier tool with an explicit confirmation
  argument — never a flag on a draft tool.
- **Never log secrets or PII.** Add tests for safety-critical behavior.
- Add a `CHANGELOG.md` entry for user-facing changes.
