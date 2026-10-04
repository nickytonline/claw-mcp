import { Config as EffectConfig, ConfigProvider, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };

const configEffect = EffectConfig.all({
  PORT: EffectConfig.number("PORT").pipe(EffectConfig.withDefault(3000)),
  NODE_ENV: EffectConfig.literal("development", "production", "test")("NODE_ENV").pipe(
    EffectConfig.withDefault("development"),
  ),
  SERVER_NAME: EffectConfig.string("SERVER_NAME").pipe(
    EffectConfig.withDefault(packageJson.name),
  ),
  SERVER_VERSION: EffectConfig.string("SERVER_VERSION").pipe(
    EffectConfig.withDefault(packageJson.version),
  ),
  LOG_LEVEL: EffectConfig.literal("error", "warn", "info", "debug")("LOG_LEVEL").pipe(
    EffectConfig.withDefault("info"),
  ),
  OPENCLAW_BIN: EffectConfig.string("OPENCLAW_BIN").pipe(EffectConfig.withDefault("openclaw")),
  // The bridge must reach the Gateway over loopback: a trusted-proxy Gateway
  // only accepts the password fallback from same-host callers.
  OPENCLAW_GATEWAY_URL: EffectConfig.string("OPENCLAW_GATEWAY_URL").pipe(
    EffectConfig.withDefault("ws://127.0.0.1:18789"),
  ),
  OPENCLAW_GATEWAY_PASSWORD_FILE: EffectConfig.string("OPENCLAW_GATEWAY_PASSWORD_FILE").pipe(
    EffectConfig.withDefault(""),
  ),
  // Tools to hide from callers entirely. Empty by default: per-tool access is
  // normally enforced by the Pomerium route's mcp_tool policy instead.
  OPENCLAW_EXCLUDED_TOOLS: EffectConfig.array(EffectConfig.string(), "OPENCLAW_EXCLUDED_TOOLS").pipe(
    EffectConfig.withDefault([]),
  ),
  // OpenClaw agent workspace (~/.openclaw/workspace), mounted read-only.
  // Empty disables the workspace_* tools.
  OPENCLAW_WORKSPACE_DIR: EffectConfig.string("OPENCLAW_WORKSPACE_DIR").pipe(
    EffectConfig.withDefault(""),
  ),
  // events_wait accepts timeout_ms up to 300000, so allow a little headroom.
  OPENCLAW_CALL_TIMEOUT_MS: EffectConfig.number("OPENCLAW_CALL_TIMEOUT_MS").pipe(
    EffectConfig.withDefault(310_000),
  ),
});

export type Config = typeof configEffect extends EffectConfig.Config<infer ConfigValue>
  ? ConfigValue
  : never;

const loadConfig = Effect.withConfigProvider(ConfigProvider.fromEnv())(configEffect);

let config: Config | undefined;

function failInvalidConfig(error: unknown): never {
  process.stderr.write(`Invalid environment configuration: ${String(error)}\n`);
  process.exit(1);
}

export function getConfig(): Config {
  if (!config) {
    try {
      config = Effect.runSync(loadConfig);
    } catch (error) {
      return failInvalidConfig(error);
    }
  }
  return config;
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === "production";
}

export function isDevelopment(): boolean {
  return getConfig().NODE_ENV === "development";
}
