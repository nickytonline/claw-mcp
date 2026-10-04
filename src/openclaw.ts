import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/server";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import { Effect } from "effect";
import { getConfig } from "./config.ts";
import { logger } from "./logger.ts";
import { runMcpEffect } from "./lib/utils.ts";
import { Workspace, callWorkspaceTool, isWorkspaceTool, workspaceTools } from "./workspace.ts";

/**
 * Bridges stateless HTTP MCP requests onto one long-lived
 * `openclaw mcp serve` stdio child.
 *
 * The HTTP side builds a fresh server per request, but the OpenClaw bridge is
 * stateful: its live event queue (events_poll / events_wait) and observed
 * approvals only exist while the child stays connected to the Gateway. So the
 * child is shared across requests and respawned lazily if it exits.
 */
export class OpenClawBridge {
  #client: Promise<Client> | undefined;
  #tools: Tool[] | undefined;
  readonly #command: string;
  readonly #args: string[];
  readonly #excludedTools: ReadonlySet<string>;
  readonly #callTimeoutMs: number;

  constructor(
    command: string,
    args: string[],
    excludedTools: ReadonlySet<string>,
    callTimeoutMs: number,
  ) {
    this.#command = command;
    this.#args = args;
    this.#excludedTools = excludedTools;
    this.#callTimeoutMs = callTimeoutMs;
  }

  #connect(): Promise<Client> {
    if (!this.#client) {
      const attempt = this.#spawn();
      this.#client = attempt;
      // A failed spawn must not poison later requests; let the next one retry.
      attempt.catch(() => {
        if (this.#client === attempt) this.#reset();
      });
    }
    return this.#client;
  }

  async #spawn(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.#command,
      args: this.#args,
      // Child diagnostics (Gateway connect failures etc.) go to our stderr so
      // they land in the container log next to ours.
      stderr: "inherit",
    });
    const client = new Client({
      name: "openclaw-remote-mcp",
      version: "1.0.0",
    });
    client.onclose = () => {
      void runMcpEffect(
        logger.warn("openclaw mcp serve exited; will respawn on next request"),
      );
      this.#reset();
    };
    await client.connect(transport);
    void runMcpEffect(
      logger.info(
        { command: this.#command },
        "Connected to openclaw mcp serve",
      ),
    );
    return client;
  }

  #reset() {
    this.#client = undefined;
    this.#tools = undefined;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.#tools) {
      const client = await this.#connect();
      const result = await client.listTools();
      this.#tools = result.tools.filter(
        (tool) => !this.#excludedTools.has(tool.name),
      );
    }
    return this.#tools;
  }

  async callTool(params: CallToolRequest["params"]): Promise<CallToolResult> {
    // Exclusion is enforced here too, not just hidden from tools/list.
    const tools = await this.listTools();
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${params.name}`,
      );
    }
    const client = await this.#connect();
    return client.callTool(
      { name: params.name, arguments: params.arguments },
      {
        // events_wait may block for up to 300s upstream.
        timeout: this.#callTimeoutMs,
        toolDefinition: tool,
      },
    );
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#reset();
    if (client) await (await client).close();
  }
}

export function createOpenClawBridge(): OpenClawBridge {
  const config = getConfig();
  const args = [
    "mcp",
    "serve",
    "--url",
    config.OPENCLAW_GATEWAY_URL,
    // Claude channel push needs a live MCP session to push into; the HTTP
    // side is stateless, so there is nobody to receive it.
    "--claude-channel-mode",
    "off",
  ];
  if (config.OPENCLAW_GATEWAY_PASSWORD_FILE) {
    args.push("--password-file", config.OPENCLAW_GATEWAY_PASSWORD_FILE);
  }
  return new OpenClawBridge(
    config.OPENCLAW_BIN,
    args,
    new Set(config.OPENCLAW_EXCLUDED_TOOLS),
    config.OPENCLAW_CALL_TIMEOUT_MS,
  );
}

export function createWorkspace(): Workspace | undefined {
  const dir = getConfig().OPENCLAW_WORKSPACE_DIR;
  return dir ? new Workspace(dir) : undefined;
}

/**
 * Per-request MCP server: OpenClaw bridge tools proxied to the shared stdio
 * child, plus the read-only workspace tools served locally when a workspace
 * directory is configured.
 */
export function createOpenClawProxyServer(bridge: OpenClawBridge, workspace?: Workspace): Server {
  const config = getConfig();
  const server = new Server(
    { name: config.SERVER_NAME, version: config.SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => {
    const local = workspace ? workspaceTools : [];
    return { tools: [...local, ...(await bridge.listTools())] };
  });

  server.setRequestHandler(
    "tools/call",
    async (request): Promise<CallToolResult> => {
      const toolName = request.params.name;
      if (workspace && isWorkspaceTool(toolName)) {
        const result = await runMcpEffect(
          callWorkspaceTool(workspace, toolName, request.params.arguments),
        );
        await runMcpEffect(
          logger.info({ toolName, isError: result.isError === true }, "Workspace tool executed"),
        );
        return result;
      }
      try {
        const result = await bridge.callTool(request.params);
        await runMcpEffect(
          logger.info({ toolName }, "Tool proxied to OpenClaw"),
        );
        return result;
      } catch (error) {
        await runMcpEffect(
          logger.error(
            {
              toolName,
              error: error instanceof Error ? error.message : String(error),
            },
            "OpenClaw tool call failed",
          ),
        );
        throw error;
      }
    },
  );

  return server;
}

export const closeBridge = (bridge: OpenClawBridge) =>
  Effect.tryPromise({ try: () => bridge.close(), catch: (error) => error });
