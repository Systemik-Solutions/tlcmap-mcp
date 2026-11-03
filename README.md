# TLCMap MCP

`tlcmap-mcp` is a stateless Model Context Protocol (MCP) server, written in TypeScript for Node 24,
that fronts the public TLCMap API. It exposes read-only tools and resources, carries provenance and
licence text through unchanged, and reports typed errors. It calls production tlcmap.org and holds no
state between requests.

The specification is in the `tlcmap-skills` repository:
[documents/specs/A0-SERVER-SKELETON.md](https://github.com/Systemik-Solutions/tlcmap-skills/blob/main/documents/specs/A0-SERVER-SKELETON.md).

## Scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `npm run build` | `tsc -p tsconfig.build.json` | Compile `src` to `dist` |
| `npm run typecheck` | `tsc --noEmit` | Type-check source, tests and scripts |
| `npm run lint` | `eslint .` | Lint the repository |
| `npm test` | `vitest run` | Run unit, integration and deploy tests (no network) |
| `npm run test:prod` | `vitest run --config vitest.prod.config.ts` | Run the production compatibility check |
| `npm run capture-fixtures` | `tsx scripts/capture-fixtures.ts` | Capture feed fixtures from tlcmap.org |
| `npm start` | `node dist/index.js` | Run the built server |

Deployment: see `deploy/DEPLOY.md`.
