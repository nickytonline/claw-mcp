import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeFileSystem } from "@effect/platform-node";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { Data, Effect, JSONSchema, Schema } from "effect";
import { createErrorResult, createTextResult } from "./lib/utils.ts";

/** Directories never listed or searched: VCS internals and dependency trees. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
/** Files larger than this are listed but not read or searched. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_MATCH_TEXT = 300;

/** A refusal or bad input, reported to the caller as an isError result. */
export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ message: string }> {}

const refuse = (message: string) => Effect.fail(new WorkspaceError({ message }));

/** A directory entry resolved to its real path and confirmed inside the root. */
type Entry = { path: string; real: string; info: FileSystem.File.Info };

/**
 * Read-only access to OpenClaw's agent workspace (`~/.openclaw/workspace`)
 * through Effect's `FileSystem` service.
 *
 * Every path, including each entry met while walking, is resolved through
 * realPath and must stay inside the root. `FileSystem.stat` follows
 * symlinks, so this is what stops a link from pointing list/search outside
 * the workspace; walks also track visited real directories so a link back to
 * an ancestor can't loop.
 */
export class Workspace {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #realRoot = Effect.gen(this, function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.realPath(this.#root);
  });

  #isInside(root: string, real: string): boolean {
    if (real !== root && !real.startsWith(root + path.sep)) return false;
    return !path
      .relative(root, real)
      .split(path.sep)
      .some((part) => SKIPPED_DIRS.has(part));
  }

  /** Resolves a workspace-relative path to an entry inside the root. */
  resolve(
    relative: string,
  ): Effect.Effect<Entry, WorkspaceError | PlatformError, FileSystem.FileSystem> {
    return Effect.gen(this, function* () {
      if (path.isAbsolute(relative)) {
        return yield* refuse("Paths must be relative to the workspace root");
      }
      const fs = yield* FileSystem.FileSystem;
      const root = yield* this.#realRoot;
      const real = yield* fs
        .realPath(path.resolve(root, relative))
        .pipe(Effect.catchAll(() => refuse(`Not found: ${relative}`)));
      if (real !== root && !real.startsWith(root + path.sep)) {
        return yield* refuse(`Outside the workspace: ${relative}`);
      }
      if (!this.#isInside(root, real)) {
        return yield* refuse(`Not accessible: ${relative}`);
      }
      const info = yield* fs.stat(real);
      return { path: path.relative(root, real) || ".", real, info };
    });
  }

  /**
   * Children of a directory, sorted by name. Entries that are broken links,
   * point outside the root, or sit in a skipped directory are dropped.
   */
  #children(dir: Entry) {
    return Effect.gen(this, function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* this.#realRoot;
      const names = (yield* fs.readDirectory(dir.real)).sort((a, b) => a.localeCompare(b));
      const children: Entry[] = [];
      for (const name of names) {
        if (SKIPPED_DIRS.has(name)) continue;
        const real = yield* fs
          .realPath(path.join(dir.real, name))
          .pipe(Effect.option);
        if (real._tag === "None" || !this.#isInside(root, real.value)) continue;
        const info = yield* fs.stat(real.value).pipe(Effect.option);
        if (info._tag === "None") continue;
        const logical = dir.path === "." ? name : path.join(dir.path, name);
        children.push({ path: logical, real: real.value, info: info.value });
      }
      return children;
    });
  }

  /** Breadth-first listing, `depth` levels deep, capped at MAX_LIST_ENTRIES. */
  list(relative: string, depth: number) {
    return Effect.gen(this, function* () {
      const start = yield* this.resolve(relative);
      if (start.info.type !== "Directory") return yield* refuse(`Not a directory: ${relative}`);
      const entries: { path: string; type: "file" | "dir"; size?: number }[] = [];
      const visited = new Set([start.real]);
      let truncated = false;
      let frontier = [start];
      for (let level = 0; level < depth && frontier.length > 0 && !truncated; level++) {
        const next: Entry[] = [];
        for (const dir of frontier) {
          for (const child of yield* this.#children(dir)) {
            if (entries.length >= MAX_LIST_ENTRIES) {
              truncated = true;
              break;
            }
            if (child.info.type === "Directory") {
              entries.push({ path: child.path, type: "dir" });
              if (!visited.has(child.real)) {
                visited.add(child.real);
                next.push(child);
              }
            } else if (child.info.type === "File") {
              entries.push({ path: child.path, type: "file", size: Number(child.info.size) });
            }
          }
          if (truncated) break;
        }
        frontier = next;
      }
      return { entries, truncated };
    });
  }

  /** Reads a 1-based line range of a text file. */
  read(relative: string, startLine: number, maxLines: number) {
    return Effect.gen(this, function* () {
      const file = yield* this.resolve(relative);
      const text = yield* this.#readText(file, relative);
      const lines = text.split("\n");
      const from = Math.max(startLine, 1) - 1;
      const slice = lines.slice(from, from + maxLines);
      return {
        path: file.path,
        startLine: from + 1,
        endLine: from + slice.length,
        totalLines: lines.length,
        content: slice.join("\n"),
      };
    });
  }

  /** Line-by-line search across text files under `relative`. */
  search(
    query: string,
    relative: string,
    options: { regex: boolean; caseSensitive: boolean; maxResults: number },
  ) {
    return Effect.gen(this, function* () {
      const pattern = yield* Effect.try({
        try: () =>
          new RegExp(
            options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            options.caseSensitive ? "" : "i",
          ),
        catch: (error) =>
          new WorkspaceError({ message: `Invalid regex: ${(error as Error).message}` }),
      });

      const start = yield* this.resolve(relative);
      const matches: { path: string; line: number; text: string }[] = [];
      const visited = new Set<string>();
      let truncated = false;
      let filesSearched = 0;
      const stack = [start];

      // Depth-first, keeping name order: children are pushed in reverse.
      while (stack.length > 0 && !truncated) {
        const entry = stack.pop()!;
        if (entry.info.type === "Directory") {
          if (visited.has(entry.real)) continue;
          visited.add(entry.real);
          stack.push(...(yield* this.#children(entry)).reverse());
          continue;
        }
        if (entry.info.type !== "File" || Number(entry.info.size) > MAX_FILE_BYTES) continue;
        const text = yield* this.#readText(entry, entry.path).pipe(Effect.option);
        if (text._tag === "None") continue;
        filesSearched++;
        const lines = text.value.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!pattern.test(lines[i])) continue;
          if (matches.length >= options.maxResults) {
            truncated = true;
            break;
          }
          matches.push({ path: entry.path, line: i + 1, text: lines[i].slice(0, MAX_MATCH_TEXT) });
        }
      }
      return { matches, filesSearched, truncated };
    });
  }

  #readText(file: Entry, label: string) {
    return Effect.gen(function* () {
      if (file.info.type !== "File") return yield* refuse(`Not a file: ${label}`);
      if (Number(file.info.size) > MAX_FILE_BYTES) {
        return yield* refuse(`File too large to read (${file.info.size} bytes): ${label}`);
      }
      const fs = yield* FileSystem.FileSystem;
      const bytes = yield* fs.readFile(file.real);
      if (bytes.includes(0)) return yield* refuse(`Binary file: ${label}`);
      return new TextDecoder().decode(bytes);
    });
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

const decode = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args ?? {}).pipe(
    Effect.mapError((error) => new WorkspaceError({ message: `Invalid arguments: ${error.message}` })),
  );

function runWorkspaceTool(workspace: Workspace, name: string, args: unknown) {
  switch (name) {
    case "workspace_list":
      return decode(ListArgs, args).pipe(
        Effect.flatMap((input) => workspace.list(input.path ?? ".", input.depth ?? 2)),
      );
    case "workspace_read":
      return decode(ReadArgs, args).pipe(
        Effect.flatMap((input) =>
          workspace.read(input.path, input.start_line ?? 1, input.max_lines ?? 400),
        ),
      );
    case "workspace_search":
      return decode(SearchArgs, args).pipe(
        Effect.flatMap((input) =>
          workspace.search(input.query, input.path ?? ".", {
            regex: input.regex ?? false,
            caseSensitive: input.case_sensitive ?? false,
            maxResults: input.max_results ?? 100,
          }),
        ),
      );
    default:
      return refuse(`Unknown workspace tool: ${name}`);
  }
}

/**
 * Runs one workspace tool against the given FileSystem layer (Node's by
 * default). Bad input, refusals and I/O failures come back as isError results.
 */
export function callWorkspaceTool(
  workspace: Workspace,
  name: string,
  args: unknown,
  fileSystem = NodeFileSystem.layer,
): Effect.Effect<CallToolResult> {
  return (runWorkspaceTool(workspace, name, args) as Effect.Effect<
    unknown,
    WorkspaceError | PlatformError,
    FileSystem.FileSystem
  >).pipe(
    Effect.map((data) => createTextResult(data)),
    Effect.catchTags({
      WorkspaceError: (error) => Effect.succeed(createErrorResult({ error: error.message })),
      SystemError: (error) =>
        Effect.succeed(createErrorResult({ error: `Workspace error: ${error.message}` })),
      BadArgument: (error) =>
        Effect.succeed(createErrorResult({ error: `Workspace error: ${error.message}` })),
    }),
    Effect.provide(fileSystem),
  );
}
