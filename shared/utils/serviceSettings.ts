import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { resolveRuntimePath } from "./runtimeDirectory.js";

export type RuntimeServiceName = "opencode" | "telegram" | "calendar" | "api";

export type RuntimeServiceDefinition = {
  name: RuntimeServiceName;
  envName: string;
  defaultEnabled: boolean;
  description: string;
};

export type RuntimeServiceStatus = RuntimeServiceDefinition & {
  enabled: boolean;
  source: "environment" | "runtime-env" | "runtime-settings" | "default";
  persistedEnabled?: boolean;
  envPath: string;
  settingsPath: string;
};

export const RUNTIME_SERVICE_DEFINITIONS: RuntimeServiceDefinition[] = [
  {
    name: "opencode",
    envName: "OPENCODE_SERVER_AUTO_START",
    defaultEnabled: true,
    description: "Managed opencode serve process"
  },
  {
    name: "telegram",
    envName: "TELEGRAM_ENABLED",
    defaultEnabled: true,
    description: "Telegram Bot API long polling connection"
  },
  {
    name: "calendar",
    envName: "GOOGLE_CALENDAR_ENABLED",
    defaultEnabled: false,
    description: "Google Calendar background cache sync"
  },
  {
    name: "api",
    envName: "DAGENT_API_ENABLED",
    defaultEnabled: false,
    description: "DAgent HTTP control API"
  }
];

export function normalizeRuntimeServiceName(value: string): RuntimeServiceName | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "opencode" || normalized === "opencode-server") {
    return "opencode";
  }
  if (normalized === "telegram") {
    return "telegram";
  }
  if (normalized === "calendar" || normalized === "google-calendar") {
    return "calendar";
  }
  if (normalized === "api" || normalized === "dagent-api") {
    return "api";
  }
  return undefined;
}

export function getRuntimeServiceDefinition(serviceName: RuntimeServiceName): RuntimeServiceDefinition {
  const definition = RUNTIME_SERVICE_DEFINITIONS.find((service) => service.name === serviceName);
  if (!definition) {
    throw new Error(`Unknown runtime service: ${serviceName}`);
  }
  return definition;
}

export function getRuntimeSettingsPath(runtimeDirectory: string): string {
  return resolveRuntimePath(runtimeDirectory, ".settings");
}

export function getRuntimeEnvPath(runtimeDirectory: string): string {
  const dotenvConfigPath = process.env.DOTENV_CONFIG_PATH?.trim();
  return resolveRuntimePath(runtimeDirectory, dotenvConfigPath || ".env");
}

export function readRuntimeServiceStatuses(runtimeDirectory: string): RuntimeServiceStatus[] {
  return RUNTIME_SERVICE_DEFINITIONS.map((definition) => readRuntimeServiceStatus(runtimeDirectory, definition.name));
}

export function readRuntimeServiceStatus(runtimeDirectory: string, serviceName: RuntimeServiceName): RuntimeServiceStatus {
  const definition = getRuntimeServiceDefinition(serviceName);
  const envPath = getRuntimeEnvPath(runtimeDirectory);
  const settingsPath = getRuntimeSettingsPath(runtimeDirectory);
  const runtimeEnv = readRuntimeFile(envPath);
  const runtimeSettings = readRuntimeSettings(settingsPath);
  const processValue = process.env[definition.envName]?.trim();
  const runtimeEnvValue = runtimeEnv[definition.envName]?.trim();
  const persistedValue = runtimeSettings[definition.envName]?.trim();

  if (processValue) {
    return {
      ...definition,
      enabled: parseBooleanValue(definition.envName, processValue),
      source: "environment",
      persistedEnabled: persistedValue ? parseBooleanValue(definition.envName, persistedValue) : undefined,
      envPath,
      settingsPath
    };
  }

  if (runtimeEnvValue) {
    return {
      ...definition,
      enabled: parseBooleanValue(definition.envName, runtimeEnvValue),
      source: "runtime-env",
      persistedEnabled: persistedValue ? parseBooleanValue(definition.envName, persistedValue) : undefined,
      envPath,
      settingsPath
    };
  }

  if (persistedValue) {
    return {
      ...definition,
      enabled: parseBooleanValue(definition.envName, persistedValue),
      source: "runtime-settings",
      persistedEnabled: parseBooleanValue(definition.envName, persistedValue),
      envPath,
      settingsPath
    };
  }

  return {
    ...definition,
    enabled: definition.defaultEnabled,
    source: "default",
    envPath,
    settingsPath
  };
}

export function persistRuntimeServiceEnabled(runtimeDirectory: string, serviceName: RuntimeServiceName, enabled: boolean): RuntimeServiceStatus {
  const definition = getRuntimeServiceDefinition(serviceName);
  const settingsPath = getRuntimeSettingsPath(runtimeDirectory);
  writeRuntimeSettingsValue(settingsPath, definition.envName, enabled ? "true" : "false");
  return readRuntimeServiceStatus(runtimeDirectory, serviceName);
}

function readRuntimeSettings(settingsPath: string): Record<string, string> {
  return readRuntimeFile(settingsPath);
}

function readRuntimeFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  return parseDotenv(readFileSync(path, "utf8"));
}

function writeRuntimeSettingsValue(settingsPath: string, name: string, value: string): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const assignment = `${name}=${value}`;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=`);
  let replaced = false;

  const nextLines = lines.map((line) => {
    if (pattern.test(line)) {
      replaced = true;
      return assignment;
    }
    return line;
  });

  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
    nextLines.pop();
  }

  if (!replaced) {
    nextLines.push(assignment);
  }

  writeFileSync(settingsPath, `${nextLines.join("\n")}\n`);
}

function parseBooleanValue(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
