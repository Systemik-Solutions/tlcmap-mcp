# TLCMap MCP

`tlcmap-mcp` is a stateless Model Context Protocol (MCP) server, written in TypeScript for Node 24,
that fronts the public TLCMap API. Version 0.2.0 reads TLCMap's API v2 and offers four read-only
tools:

- `tlcmap_list_layers`
- `tlcmap_search_places`
- `tlcmap_get_layer`
- `tlcmap_get_layer_metadata`

Pages of features are never returned inline. They are handed out as resources, through the templates
`tlcmap://layer/{id}/features/{sha256}` and `tlcmap://search/{sha256}`. The server carries provenance
and licence text through unchanged, reports typed errors and holds no state between requests. Which
TLCMap application it reads is set by `TLCMAP_BASE_URL`, which must name an application that serves
`/api/v2`.

The specifications are in the `tlcmap-skills` repository:
[A0, the server skeleton](https://github.com/Systemik-Solutions/tlcmap-skills/blob/main/documents/specs/A0-SERVER-SKELETON.md),
and [A1, the tools and v2](https://github.com/Systemik-Solutions/tlcmap-skills/blob/main/documents/specs/A1-MCP.md).

## Environments

| Stage | MCP server | `TLCMAP_BASE_URL` | State |
| --- | --- | --- | --- |
| Local | `http://localhost:3100` | `http://tlcmap-ghap.laragon.local` | Where 0.2.0 runs and its fixtures are captured |
| Staging | `https://test-mcp.tlcmap.org` | `https://test-ghap.tlcmap.org` | Still serves 0.1.0 against production's v1, until v2 is deployed to the staging TLCMap application |
| Production | none yet | `https://tlcmap.org` | v2 is not released; only `npm run test:compat` runs against it |

The three environments hold different data, so the same layer id can be a different layer, or absent.

To connect Claude Code to staging:

```sh
claude mcp add --transport http tlcmap https://test-mcp.tlcmap.org/mcp
```

Staging serves 0.1.0, which offers only the old `tlcmap_get_layer` (on production's v1), until v2
reaches test-ghap; the four v2 tools appear once 0.2.0 is deployed there.

Health: `https://test-mcp.tlcmap.org/healthz`. Acceptance records, for every milestone, are kept in tlcmap-skills: [documents/acceptance](https://github.com/Systemik-Solutions/tlcmap-skills/tree/main/documents/acceptance).

## Running locally

Run the TLCMap application locally (it serves `http://tlcmap-ghap.laragon.local`), then build and
start the server against it:

```sh
npm run build
PUBLIC_URL=http://localhost:3100 TLCMAP_BASE_URL=http://tlcmap-ghap.laragon.local npm start
```

Connect Claude Code:

```sh
claude mcp add --transport http tlcmap-local http://localhost:3100/mcp
```

Paging makes requests add up, so raise `API_V2_RATE_LIMIT` in the application's local `.env` (for
example `600,1`) and run `php artisan config:clear` to apply it.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run build` | `tsc -p tsconfig.build.json` | Compile `src` to `dist` |
| `npm run typecheck` | `tsc --noEmit` | Type-check source, tests and scripts |
| `npm run lint` | `eslint .` | Lint the repository |
| `npm test` | `vitest run` | Run unit, integration and deploy tests (no network) |
| `npm run test:compat` | `vitest run --config vitest.compat.config.ts` | Run the compatibility check against `TLCMAP_BASE_URL` (default `https://tlcmap.org`) |
| `npm run capture-fixtures` | `tsx scripts/capture-fixtures.ts` | Capture fixtures from v2; requires `TLCMAP_BASE_URL` and never defaults to production |
| `npm start` | `node dist/index.js` | Run the built server |

Deployment: see `deploy/DEPLOY.md`.
