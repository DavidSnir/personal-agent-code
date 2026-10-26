import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

type LocalMcpConfig = {
  type: "local";
  command: string[];
  environment: Record<string, string>;
  enabled: true;
};

type RemoteMcpConfig = {
  type: "remote";
  url: string;
  enabled: true;
  headers?: Record<string, string>;
};

type McpConfig = LocalMcpConfig | RemoteMcpConfig;

export type CalendarMcpInstallOptions = {
  transport?: "local" | "remote";
  remoteUrl?: string;
  remoteHeaders?: Record<string, string>;
  configPath?: string;
};

export type WhatsappMcpInstallOptions = {
  transport?: "local" | "remote";
  remoteUrl?: string;
  remoteHeaders?: Record<string, string>;
  configPath?: string;
};

const CALENDAR_MCP_COMMAND = ["dagent", "services", "mcp", "calendar"] as const;
const WHATSAPP_MCP_COMMAND = ["dagent", "services", "mcp", "whatsapp"] as const;

function buildLocalMcpConfig(runtimeDirectory: string, command: readonly string[]): LocalMcpConfig {
  return {
    type: "local",
    command: [...command],
    environment: { DAGENT_RUNTIME_DIRECTORY: runtimeDirectory },
    enabled: true
  };
}

function buildCalendarMcpConfig(runtimeDirectory: string, options: CalendarMcpInstallOptions = {}): McpConfig {
  if (options.transport === "remote") {
    const url = options.remoteUrl?.trim();
    if (!url) {
      throw new Error("Remote Calendar MCP install requires a URL");
    }
    return {
      type: "remote",
      url,
      enabled: true,
      ...(options.remoteHeaders ? { headers: options.remoteHeaders } : {})
    };
  }
  return buildLocalMcpConfig(runtimeDirectory, CALENDAR_MCP_COMMAND);
}

function buildWhatsappMcpConfig(runtimeDirectory: string, options: WhatsappMcpInstallOptions = {}): McpConfig {
  if (options.transport === "remote") {
    const url = options.remoteUrl?.trim();
    if (!url) {
      throw new Error("Remote WhatsApp MCP install requires a URL");
    }
    return {
      type: "remote",
      url,
      enabled: true,
      ...(options.remoteHeaders ? { headers: options.remoteHeaders } : {})
    };
  }
  return buildLocalMcpConfig(runtimeDirectory, WHATSAPP_MCP_COMMAND);
}

export type OpencodeRuntimeConfigInstallResult = {
  configPath: string;
  calendarMcp: McpConfig;
  changed: boolean;
};

export type OpencodeRuntimeWhatsappConfigInstallResult = {
  configPath: string;
  whatsappMcp: McpConfig;
  changed: boolean;
};

export type OpencodeRuntimeMcpInstallResult = {
  configPath: string;
  mcp: Record<string, McpConfig>;
  changed: boolean;
};

export const COMPOSE_CALENDAR_MCP_URL = "http://calendar-mcp:7332/mcp";
export const COMPOSE_WHATSAPP_MCP_URL = "http://whatsapp-mcp:7333/mcp";

export function installCalendarMcpInRuntimeOpencodeConfig(runtimeDirectory: string, options: CalendarMcpInstallOptions = {}): OpencodeRuntimeConfigInstallResult {
  const calendarMcp = buildCalendarMcpConfig(runtimeDirectory, options);
  const result = installMcpEntriesInRuntimeOpencodeConfig(runtimeDirectory, { calendar: calendarMcp }, options.configPath);
  return { configPath: result.configPath, calendarMcp, changed: result.changed };
}

export function installWhatsappMcpInRuntimeOpencodeConfig(runtimeDirectory: string, options: WhatsappMcpInstallOptions = {}): OpencodeRuntimeWhatsappConfigInstallResult {
  const whatsappMcp = buildWhatsappMcpConfig(runtimeDirectory, options);
  const result = installMcpEntriesInRuntimeOpencodeConfig(runtimeDirectory, { whatsapp: whatsappMcp }, options.configPath);
  return { configPath: result.configPath, whatsappMcp, changed: result.changed };
}

export function installDefaultMcpInRuntimeOpencodeConfig(runtimeDirectory: string): OpencodeRuntimeMcpInstallResult {
  return installMcpEntriesInRuntimeOpencodeConfig(runtimeDirectory, {
    calendar: buildCalendarMcpConfig(runtimeDirectory, readCalendarMcpInstallOptionsFromEnv()),
    whatsapp: buildWhatsappMcpConfig(runtimeDirectory, readWhatsappMcpInstallOptionsFromEnv())
  });
}

export function installComposeMcpInRuntimeOpencodeConfig(runtimeDirectory: string, configPath?: string): OpencodeRuntimeMcpInstallResult {
  return installMcpEntriesInRuntimeOpencodeConfig(runtimeDirectory, {
    calendar: buildCalendarMcpConfig(runtimeDirectory, { transport: "remote", remoteUrl: COMPOSE_CALENDAR_MCP_URL }),
    whatsapp: buildWhatsappMcpConfig(runtimeDirectory, { transport: "remote", remoteUrl: COMPOSE_WHATSAPP_MCP_URL })
  }, configPath);
}

export function readCalendarMcpInstallOptionsFromEnv(): CalendarMcpInstallOptions {
  const transport = process.env.DAGENT_CALENDAR_MCP_TRANSPORT?.trim().toLowerCase();
  if (!transport || transport === "local") return {};
  if (transport !== "remote") {
    throw new Error("DAGENT_CALENDAR_MCP_TRANSPORT must be local or remote");
  }
  return { transport: "remote", remoteUrl: process.env.DAGENT_CALENDAR_MCP_REMOTE_URL?.trim() };
}

export function readWhatsappMcpInstallOptionsFromEnv(): WhatsappMcpInstallOptions {
  const transport = process.env.DAGENT_WHATSAPP_MCP_TRANSPORT?.trim().toLowerCase();
  if (!transport || transport === "local") return {};
  if (transport !== "remote") {
    throw new Error("DAGENT_WHATSAPP_MCP_TRANSPORT must be local or remote");
  }
  return { transport: "remote", remoteUrl: process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL?.trim() };
}

function readOpencodeConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read opencode config ${configPath}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`opencode config ${configPath} must contain a JSON object`);
  }

  return parsed;
}

function installMcpEntriesInRuntimeOpencodeConfig(runtimeDirectory: string, entries: Record<string, McpConfig>, explicitConfigPath?: string): OpencodeRuntimeMcpInstallResult {
  const configPath = explicitConfigPath ? resolve(explicitConfigPath) : resolve(runtimeDirectory, "opencode.json");
  const existingConfig = readOpencodeConfig(configPath);
  const nextConfig = buildOpencodeConfigWithMcpEntries(existingConfig, entries);
  const changed = JSON.stringify(nextConfig) !== JSON.stringify(existingConfig);

  if (changed) {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  chmodSync(configPath, 0o600);

  return { configPath, mcp: entries, changed };
}

function buildOpencodeConfigWithMcpEntries(existingConfig: Record<string, unknown>, entries: Record<string, McpConfig>): Record<string, unknown> {
  const existingMcp = existingConfig.mcp;
  if (existingMcp !== undefined && !isRecord(existingMcp)) {
    throw new Error("opencode config field mcp must be a JSON object before MCP entries can be installed");
  }

  const nextConfig: Record<string, unknown> = {
    $schema: OPENCODE_SCHEMA,
    ...existingConfig
  };
  nextConfig.$schema = OPENCODE_SCHEMA;
  nextConfig.mcp = {
    ...(existingMcp ?? {}),
    ...entries
  };
  return nextConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
