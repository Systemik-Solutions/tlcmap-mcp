# TLCMap MCP

`tlcmap-mcp` is a stateless Model Context Protocol (MCP) server, written in TypeScript for Node 24,
that fronts the public TLCMap API. It exposes read-only tools and resources, carries provenance and
licence text through unchanged, and reports typed errors. It calls production tlcmap.org and holds no
state between requests.

The specification is in the `tlcmap-skills` repository:
[documents/specs/A0-SERVER-SKELETON.md](https://github.com/Systemik-Solutions/tlcmap-skills/blob/main/documents/specs/A0-SERVER-SKELETON.md).

## Staging

The server runs at `https://test-mcp.tlcmap.org`, reading from production tlcmap.org. It offers one
read-only tool, `tlcmap_get_layer`. To connect Claude Code:

```sh
claude mcp add --transport http tlcmap https://test-mcp.tlcmap.org/mcp
```

Health: `https://test-mcp.tlcmap.org/healthz`. Acceptance record: `docs/acceptance/A0.md`.

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run build` | `tsc -p tsconfig.build.json` | Compile `src` to `dist` |
| `npm run typecheck` | `tsc --noEmit` | Type-check source, tests and scripts |
| `npm run lint` | `eslint .` | Lint the repository |
| `npm test` | `vitest run` | Run unit, integration and deploy tests (no network) |
| `npm run test:compat` | `vitest run --config vitest.compat.config.ts` | Run the compatibility check against `TLCMAP_BASE_URL` |
| `npm run capture-fixtures` | `tsx scripts/capture-fixtures.ts` | Capture feed fixtures from tlcmap.org |
| `npm start` | `node dist/index.js` | Run the built server |

Deployment: see `deploy/DEPLOY.md`.
