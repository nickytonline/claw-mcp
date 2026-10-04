import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
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
  // Directory link out of the workspace, and one back to an ancestor (a loop).
  await symlink(base, path.join(root, "notes", "outside"));
  await symlink(root, path.join(root, "notes", "loop"));
  workspace = new Workspace(root);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const call = (name: string, args: unknown) =>
  Effect.runPromise(callWorkspaceTool(workspace, name, args));

/** Runs a Workspace effect with Node's FileSystem; rejects with the failure. */
const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.mapError((error) => new Error((error as { message: string }).message)),
      Effect.provide(NodeFileSystem.layer),
    ),
  );

describe("Workspace", () => {
  it("rejects paths that leave the root", async () => {
    await expect(run(workspace.resolve("../secret.txt"))).rejects.toThrow(/Outside the workspace/);
    await expect(run(workspace.resolve("escape.txt"))).rejects.toThrow(/Outside the workspace/);
    await expect(run(workspace.resolve("notes/outside/secret.txt"))).rejects.toThrow(
      /Outside the workspace/,
    );
    await expect(run(workspace.resolve("/etc/passwd"))).rejects.toThrow(/relative/);
  });

  it("refuses skipped directories", async () => {
    await expect(run(workspace.resolve(".git/config"))).rejects.toThrow(/Not accessible/);
  });

  it("lists files without .git or node_modules", async () => {
    const { entries, truncated } = await run(workspace.list(".", 5));
    const paths = entries.map((entry) => entry.path);
    expect(truncated).toBe(false);
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("notes/a.md");
    expect(paths.some((p) => p.startsWith(".git") || p.startsWith("node_modules"))).toBe(false);
    // Links out of the root are dropped; the loop link is listed but not descended.
    expect(paths.some((p) => p.includes("outside") || p.includes("escape"))).toBe(false);
    expect(paths).toContain("notes/loop");
    expect(paths.some((p) => p.startsWith("notes/loop/"))).toBe(false);
  });

  it("reads a line range", async () => {
    const result = await run(workspace.read("AGENTS.md", 2, 1));
    expect(result).toMatchObject({ startLine: 2, endLine: 2, content: "line two" });
  });

  it("refuses binary files", async () => {
    await expect(run(workspace.read("blob.bin", 1, 10))).rejects.toThrow(/Binary/);
  });

  it("searches case-insensitively and skips hidden trees", async () => {
    const { matches } = await run(
      workspace.search("todo:", ".", { regex: false, caseSensitive: false, maxResults: 100 }),
    );
    expect(matches.map((m) => `${m.path}:${m.line}`)).toEqual(["AGENTS.md:3", "notes/a.md:2"]);
  });

  it("caps search results", async () => {
    const result = await run(
      workspace.search("TODO", ".", { regex: false, caseSensitive: true, maxResults: 1 }),
    );
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

  it("reports invalid regexes as isError", async () => {
    const result = await call("workspace_search", { query: "(", regex: true });
    expect(result.isError).toBe(true);
  });

  it("reports refusals as isError", async () => {
    const result = await call("workspace_read", { path: "../secret.txt" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: "Outside the workspace: ../secret.txt" });
  });
});
