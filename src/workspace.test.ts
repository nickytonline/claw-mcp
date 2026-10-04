import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace, callWorkspaceTool, workspaceTools } from "./workspace.ts";

let base: string;
let root: string;
let workspace: Workspace;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "workspace-test-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "notes"), { recursive: true });
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# Agents\nline two\nTODO: first\n");
  await writeFile(path.join(root, "notes", "a.md"), "alpha\nTODO: second\n");
  await writeFile(path.join(root, ".git", "config"), "TODO: hidden\n");
  await writeFile(path.join(root, "node_modules", "pkg", "x.js"), "TODO: hidden\n");
  await writeFile(path.join(root, "blob.bin"), Buffer.from([0x54, 0x00, 0x44]));
  await writeFile(path.join(base, "secret.txt"), "outside\n");
  await symlink(path.join(base, "secret.txt"), path.join(root, "escape.txt"));
  workspace = new Workspace(root);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const call = (name: string, args: unknown) =>
  Effect.runPromise(callWorkspaceTool(workspace, name, args));

describe("Workspace", () => {
  it("rejects paths that leave the root", async () => {
    await expect(workspace.resolve("../secret.txt")).rejects.toThrow(/Outside the workspace/);
    await expect(workspace.resolve("escape.txt")).rejects.toThrow(/Outside the workspace/);
    await expect(workspace.resolve("/etc/passwd")).rejects.toThrow(/relative/);
  });

  it("refuses skipped directories", async () => {
    await expect(workspace.resolve(".git/config")).rejects.toThrow(/Not accessible/);
  });

  it("lists files without .git or node_modules", async () => {
    const { entries, truncated } = await workspace.list(".", 2);
    const paths = entries.map((entry) => entry.path);
    expect(truncated).toBe(false);
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("notes/a.md");
    expect(paths.some((p) => p.startsWith(".git") || p.startsWith("node_modules"))).toBe(false);
  });

  it("reads a line range", async () => {
    const result = await workspace.read("AGENTS.md", 2, 1);
    expect(result).toMatchObject({ startLine: 2, endLine: 2, content: "line two" });
  });

  it("refuses binary files", async () => {
    await expect(workspace.read("blob.bin", 1, 10)).rejects.toThrow(/Binary/);
  });

  it("searches case-insensitively and skips hidden trees", async () => {
    const { matches } = await workspace.search("todo:", ".", {
      regex: false,
      caseSensitive: false,
      maxResults: 100,
    });
    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["AGENTS.md:3", "notes/a.md:2"]);
  });

  it("caps search results", async () => {
    const result = await workspace.search("TODO", ".", {
      regex: false,
      caseSensitive: true,
      maxResults: 1,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe("callWorkspaceTool", () => {
  it("advertises object input schemas", () => {
    expect(workspaceTools.map((tool) => tool.name)).toEqual([
      "workspace_list",
      "workspace_read",
      "workspace_search",
    ]);
    for (const tool of workspaceTools) expect(tool.inputSchema.type).toBe("object");
  });

  it("returns structured results", async () => {
    const result = await call("workspace_read", { path: "notes/a.md" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ content: "alpha\nTODO: second\n" });
  });

  it("reports invalid arguments as isError", async () => {
    const result = await call("workspace_read", { path: 42 });
    expect(result.isError).toBe(true);
  });

  it("reports refusals as isError", async () => {
    const result = await call("workspace_read", { path: "../secret.txt" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "Outside the workspace: ../secret.txt" });
  });
});
