/**
 * The files that put seatledger where people already are: the README and its screenshot, the
 * registry entry, this package's CHANGELOG, and the repo-root files the sync copies from
 * `distribution/root` (Claude Code plugin marketplace, Gemini CLI extension). The public repo has
 * those at its root, so their checks run in the monorepo only; `scripts/sync-oss-repos.sh`
 * re-validates them when it copies them.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runDemo, screenshotText, textToSvg } from "./demo.js";
import { TOOLS } from "./mcp.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{
  name: string;
  version: string;
  mcpName: string;
  dependencies?: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
}>("package.json");

describe("package", () => {
  it("has no runtime dependencies, as the README promises", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("ships the CLI and the files the README and registry point at", () => {
    expect(pkg.bin).toEqual({ seatledger: "./dist/cli.js" });
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "README.md", "CHANGELOG.md", "server.json"]),
    );
  });

  it("CHANGELOG has a section for this version", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });

  it("server.json describes this package, run as `seatledger mcp` over stdio", () => {
    const s = json<{
      name: string;
      description: string;
      version: string;
      packages: {
        identifier: string;
        version: string;
        transport: { type: string };
        packageArguments: { value: string }[];
      }[];
    }>("server.json");
    expect(s.name).toBe(pkg.mcpName);
    expect(s.version).toBe(pkg.version);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.packages[0]).toMatchObject({
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: "stdio" },
    });
    expect(s.packages[0]!.packageArguments.map((a) => a.value)).toEqual(["mcp"]);
  });
});

describe("README", () => {
  const readme = read("README.md");

  it("leads with the one-line use and the screenshot", () => {
    expect(readme).toContain("```sh\nnpx seatledger\n```");
    expect(readme).toContain("docs/screenshot.svg");
    expect(readme).toContain("npx github:agentwares/seatledger");
  });

  it("names both MCP tools and labels dollars API-equivalent", () => {
    for (const t of TOOLS) expect(readme).toContain(t.name);
    expect(readme).toContain("API-equivalent");
  });

  it("the screenshot is the CLI's real output on synthetic history (run `pnpm screenshot` after changing it)", async () => {
    expect(read("docs/screenshot.svg")).toBe(textToSvg(screenshotText(await runDemo())));
  });
});

const root = "distribution/root";
const frontmatter = (text: string): Record<string, string> =>
  Object.fromEntries(
    (text.split("---")[1] ?? "")
      .split("\n")
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, "")]),
  );

describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and versions match this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    // agentguard's marketplace is "agentwares"; the same name here would clash for anyone with both
    expect(marketplace.name).toBe("seatledger");
    expect(marketplace.owner.name).toBe("agentwares");
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
    const gemini = json<{ name: string; version: string }>(`${root}/gemini-extension.json`);
    expect(gemini).toMatchObject({ name: "seatledger", version: pkg.version });
  });

  it("every skill and Gemini command runs the published CLI, read-only", () => {
    const skills = readdirSync(here(`${root}/plugins/seatledger/skills`)).sort();
    expect(skills).toEqual(["rates", "usage"]);
    for (const skill of skills) {
      const text = read(`${root}/plugins/seatledger/skills/${skill}/SKILL.md`);
      const front = frontmatter(text);
      expect(front.name).toBe(skill);
      expect(front.description!.length).toBeGreaterThan(80);
      const run = skill === "usage" ? "npx -y seatledger@latest" : "npx -y seatledger@latest rates";
      expect(text).toContain(run);
      expect(text).not.toMatch(/limits (set|clear) .*\$ARGUMENTS/);
    }
    for (const command of ["usage", "rates"]) {
      const toml = read(`${root}/commands/seatledger/${command}.toml`);
      expect(toml).toMatch(/^description = ".+"$/m);
      expect(toml).toMatch(/^prompt = """\n[\s\S]+\n"""\n$/m);
      expect(toml).toContain(
        command === "usage"
          ? "npx -y seatledger@latest"
          : "npx -y seatledger@latest rates {{args}}",
      );
    }
  });

  it("no skill, command or agent pre-approves a tool: Claude Code asks before every command", () => {
    // Anthropic's directory holds any allowed-tools for review as "pre-approves broad shell
    // access", even a form naming the exact command (its validator, 8 Oct 2026).
    const walk = (dir: string): string[] =>
      readdirSync(here(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const files = walk(`${root}/plugins`);
    const markdown = files.filter((f) => f.endsWith(".md"));
    expect(markdown.filter((f) => f.endsWith("/SKILL.md"))).toHaveLength(2);
    for (const f of markdown) {
      const text = read(f);
      const front = text.startsWith("---") ? (text.split("---")[1] ?? "") : "";
      expect(front, f).not.toMatch(/^\s*(allowed-tools|allowedTools)\s*:/m);
    }
    for (const f of [
      ...files.filter((x) => x.endsWith(".json")),
      `${root}/.claude-plugin/marketplace.json`,
    ])
      expect(read(f), f).not.toMatch(/allowed-?tools/i);
  });

  it("the listing icon is a square PNG of 512-2048 px under 2 MB, drawn from distribution/icon.svg (`pnpm icon`)", () => {
    const plugin = json<{ icon?: string }>(`${root}/plugins/seatledger/.claude-plugin/plugin.json`);
    expect(plugin.icon).toBe("./.claude-plugin/icon.png");
    const file = `${root}/plugins/seatledger/${plugin.icon!.slice(2)}`;
    const png = readFileSync(here(file));
    expect(statSync(here(file)).size).toBeLessThan(2 * 1024 * 1024);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    const width = png.readUInt32BE(16);
    expect(png.readUInt32BE(20)).toBe(width);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    // the tEXt chunk scripts/icon.mjs writes: the SHA-256 of the SVG the PNG was drawn from
    const key = "seatledger-icon-source-sha256\0";
    const at = png.indexOf(key, 0, "latin1");
    expect(at, "icon.png carries no source hash: run `pnpm icon`").toBeGreaterThan(0);
    const drawnFrom = png.subarray(at + key.length, at + key.length + 64).toString("latin1");
    const svg = createHash("sha256").update(read("distribution/icon.svg")).digest("hex");
    expect(drawnFrom, "distribution/icon.svg changed: run `pnpm icon`").toBe(svg);
  });

  it("the plugin folder has the README the directory lists it by, naming what it runs", () => {
    const readme = read(`${root}/plugins/seatledger/README.md`);
    const prose = readme.replace(/```[\s\S]*?```/g, "");
    expect(prose.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readme).toContain("npx -y seatledger@latest");
    expect(readme).toContain("pre-approve nothing");
    // the directory holds a version whose text names a bundled image in code
    expect(readme).not.toMatch(/`[^`]*\.png[^`]*`/);
  });
});
