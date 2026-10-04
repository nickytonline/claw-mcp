import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { Effect, JSONSchema, Schema } from "effect";
import { createErrorResult, createTextResult } from "./lib/utils.ts";

/** Directories never listed or searched: VCS internals and dependency trees. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
/** Files larger than this are listed but not read or searched. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_MATCH_TEXT = 300;

class WorkspaceError extends Error {}

/**
 * Read-only access to OpenClaw's agent workspace (`~/.openclaw/workspace`).
 *
 * Every path is resolved through realpath and must stay inside the root, so
 * `..` segments and symlinks pointing elsewhere are both rejected.
 */
export class Workspace {
  readonly #root: string;
  #realRoot: Promise<string> | undefined;

  constructor(root: string) {
    this.#root = root;
  }

  #getRealRoot(): Promise<string> {
    this.#realRoot ??= realpath(this.#root);
    return this.#realRoot;
  }

  /** Resolves a workspace-relative path to a real absolute path inside the root. */
  async resolve(relative: string): Promise<string> {
    if (path.isAbsolute(relative)) {
      throw new WorkspaceError("Paths must be relative to the workspace root");
    }
    const root = await this.#getRealRoot();
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(root, relative));
    } catch {
      throw new WorkspaceError(`Not found: ${relative}`);
    }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new WorkspaceError(`Outside the workspace: ${relative}`);
    }
    if (path.relative(root, resolved).split(path.sep).some((part) => SKIPPED_DIRS.has(part))) {
      throw new WorkspaceError(`Not accessible: ${relative}`);
    }
    return resolved;
  }

  async #toRelative(absolute: string): Promise<string> {
    return path.relative(await this.#getRealRoot(), absolute) || ".";
  }

  /** Breadth-first listing, `depth` levels deep, capped at MAX_LIST_ENTRIES. */
  async list(relative: string, depth: number) {
    const start = await this.resolve(relative);
    if (!(await stat(start)).isDirectory()) {
      throw new WorkspaceError(`Not a directory: ${relative}`);
    }
    const entries: { path: string; type: "file" | "dir"; size?: number }[] = [];
    let truncated = false;
    let frontier = [start];
    for (let level = 0; level < depth && frontier.length > 0 && !truncated; level++) {
      const next: string[] = [];
      for (const dir of frontier) {
        const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const child of children) {
          if (entries.length >= MAX_LIST_ENTRIES) {
            truncated = true;
            break;
          }
          const absolute = path.join(dir, child.name);
          if (child.isDirectory()) {
            if (SKIPPED_DIRS.has(child.name)) continue;
            entries.push({ path: await this.#toRelative(absolute), type: "dir" });
            next.push(absolute);
          } else if (child.isFile()) {
            const { size } = await stat(absolute);
            entries.push({ path: await this.#toRelative(absolute), type: "file", size });
          }
        }
        if (truncated) break;
      }
      frontier = next;
    }
    return { entries, truncated };
  }

  /** Reads a 1-based line range of a text file. */
  async read(relative: string, startLine: number, maxLines: number) {
    const file = await this.resolve(relative);
    const text = await this.#readText(file, relative);
    const lines = text.split("\n");
    const from = Math.max(startLine, 1) - 1;
    const slice = lines.slice(from, from + maxLines);
    return {
      path: await this.#toRelative(file),
      startLine: from + 1,
      endLine: from + slice.length,
      totalLines: lines.length,
      content: slice.join("\n"),
    };
  }

  /** Line-by-line search across text files under `relative`. */
  async search(
    query: string,
    relative: string,
    options: { regex: boolean; caseSensitive: boolean; maxResults: number },
  ) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(
        options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        options.caseSensitive ? "" : "i",
      );
    } catch (error) {
      throw new WorkspaceError(`Invalid regex: ${(error as Error).message}`);
    }

    const start = await this.resolve(relative);
    const matches: { path: string; line: number; text: string }[] = [];
    let truncated = false;
    let filesSearched = 0;

    const visit = async (absolute: string): Promise<void> => {
      if (truncated) return;
      const info = await stat(absolute);
      if (info.isDirectory()) {
        const children = (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const child of children) {
          if (child.isDirectory() && SKIPPED_DIRS.has(child.name)) continue;
          if (child.isDirectory() || child.isFile()) {
            await visit(path.join(absolute, child.name));
          }
        }
        return;
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return;
      const text = await this.#readText(absolute, absolute).catch(() => undefined);
      if (text === undefined) return;
      filesSearched++;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!pattern.test(lines[i])) continue;
        if (matches.length >= options.maxResults) {
          truncated = true;
          return;
        }
        matches.push({
          path: await this.#toRelative(absolute),
          line: i + 1,
          text: lines[i].slice(0, MAX_MATCH_TEXT),
        });
      }
    };

    await visit(start);
    return { matches, filesSearched, truncated };
  }

  async #readText(file: string, label: string): Promise<string> {
    const info = await stat(file);
    if (!info.isFile()) throw new WorkspaceError(`Not a file: ${label}`);
    if (info.size > MAX_FILE_BYTES) {
      throw new WorkspaceError(`File too large to read (${info.size} bytes): ${label}`);
    }
    const handle = await open(file, "r");
    try {
      const buffer = await handle.readFile();
      if (buffer.includes(0)) throw new WorkspaceError(`Binary file: ${label}`);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }
}

const ListArgs = Schema.Struct({
  path: Schema.optional(
    Schema.String.annotations({ description: 'Directory relative to the workspace root (default ".")' }),
  ),
  depth: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 5)).annotations({
      description: "How many levels to descend (1-5, default 2)",
    }),
  ),
});

const ReadArgs = Schema.Struct({
  path: Schema.String.annotations({ description: "File path relative to the workspace root" }),
  start_line: Schema.optional(
    Schema.Int.pipe(Schema.positive()).annotations({ description: "First line, 1-based (default 1)" }),
  ),
  max_lines: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 2000)).annotations({
      description: "Maximum lines to return (1-2000, default 400)",
    }),
  ),
});

const SearchArgs = Schema.Struct({
  query: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: "Text to find (a JavaScript regex when `regex` is true)",
  }),
  path: Schema.optional(
    Schema.String.annotations({ description: 'Directory or file to search (default ".")' }),
  ),
  regex: Schema.optional(Schema.Boolean.annotations({ description: "Treat query as a regex" })),
  case_sensitive: Schema.optional(
    Schema.Boolean.annotations({ description: "Match case (default false)" }),
  ),
  max_results: Schema.optional(
    Schema.Int.pipe(Schema.between(1, 500)).annotations({
      description: "Maximum matching lines (1-500, default 100)",
    }),
  ),
});

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

function inputSchema(schema: Schema.Schema.AnyNoContext): Tool["inputSchema"] {
  return JSONSchema.make(schema) as unknown as Tool["inputSchema"];
}

export const workspaceTools: Tool[] = [
  {
    name: "workspace_list",
    title: "List workspace",
    description:
      "List files and directories in the OpenClaw agent workspace (AGENTS.md, SOUL.md, USER.md, memory/, and files the agent created). Skips .git and node_modules.",
    inputSchema: inputSchema(ListArgs),
    annotations: READ_ONLY,
  },
  {
    name: "workspace_read",
    title: "Read workspace file",
    description:
      "Read a text file from the OpenClaw agent workspace, optionally a line range. Files over 1 MB and binary files are refused.",
    inputSchema: inputSchema(ReadArgs),
    annotations: READ_ONLY,
  },
  {
    name: "workspace_search",
    title: "Search workspace",
    description:
      "Search text files in the OpenClaw agent workspace line by line (case-insensitive substring by default, or a regex). Returns path, line number, and line text.",
    inputSchema: inputSchema(SearchArgs),
    annotations: READ_ONLY,
  },
];

const workspaceToolNames = new Set(workspaceTools.map((tool) => tool.name));

export function isWorkspaceTool(name: string): boolean {
  return workspaceToolNames.has(name);
}

function decode<A, I>(schema: Schema.Schema<A, I>, args: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(args ?? {});
  } catch (error) {
    throw new WorkspaceError(
      `Invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runWorkspaceTool(workspace: Workspace, name: string, args: unknown) {
  switch (name) {
    case "workspace_list": {
      const input = decode(ListArgs, args);
      return workspace.list(input.path ?? ".", input.depth ?? 2);
    }
    case "workspace_read": {
      const input = decode(ReadArgs, args);
      return workspace.read(input.path, input.start_line ?? 1, input.max_lines ?? 400);
    }
    case "workspace_search": {
      const input = decode(SearchArgs, args);
      return workspace.search(input.query, input.path ?? ".", {
        regex: input.regex ?? false,
        caseSensitive: input.case_sensitive ?? false,
        maxResults: input.max_results ?? 100,
      });
    }
    default:
      throw new WorkspaceError(`Unknown workspace tool: ${name}`);
  }
}

/** Runs one workspace tool. Bad input and filesystem refusals come back as isError results. */
export function callWorkspaceTool(
  workspace: Workspace,
  name: string,
  args: unknown,
): Effect.Effect<CallToolResult> {
  return Effect.tryPromise({
    try: () => runWorkspaceTool(workspace, name, args),
    catch: (error) => error,
  }).pipe(
    Effect.map((data) => createTextResult(data)),
    Effect.catchAll((error) =>
      Effect.succeed(
        createErrorResult({
          error:
            error instanceof WorkspaceError
              ? error.message
              : `Workspace error: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ),
    ),
  );
}
