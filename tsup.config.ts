import { defineConfig } from "tsup";

/**
 * No runtime dependencies: the CLI, the MCP server and the library are this package's own code,
 * so `npx seatledger` installs one package, and the only requests it ever makes are the team
 * ledger's (`push`, `team`, `seatledger_team_summary`), in `src/team.ts`.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: { entry: { index: "src/index.ts" } },
  sourcemap: true,
  clean: true,
  splitting: false,
});
