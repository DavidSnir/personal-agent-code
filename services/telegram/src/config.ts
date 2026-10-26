import { config as loadDotenv } from "dotenv";
import { getDefaultRuntimeDirectory, resolveRuntimePath } from "../../../shared/utils/runtimeDirectory.js";
import { readRuntimeServiceStatus } from "../../../shared/utils/serviceSettings.js";
import { loadPersistedTelegramCredentials, parseTelegramUserId, validateTelegramBotToken } from "./telegram/credentials.js";

export const DEFAULT_OPENCODE_SERVER_DIRECTORY = "/Users/davidsnir/ai-projects/personal-agent";

export type Config = {
  telegramEnabled: boolean;
  telegramBotToken?: string;
  telegramAllowedUserId?: number;
  opencodeServerHostname: string;
  opencodeServerPort: number;
  opencodeServerDirectory: string;
  opencodeServerPrintLogs: boolean;
  opencodeServerAutoStart: boolean;
  opencodeServerUrl: string;
  opencodeServerUsername?: string;
  opencodeServerPassword?: string;
  opencodeAgent?: string;
  opencodeModel?: string;
  opencodeDirectory?: string;
  opencodeRequestTimeoutMs: number;
  dagentApiEnabled: boolean;
  dagentApiHostname: string;
  dagentApiPort: number;
  dagentApiToken?: string;
};

export type ConfigOptions = {
  runtimeDirectory?: string;
  forceTelegramEnabled?: boolean;
};

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(options: ConfigOptions = {}): Config {
  const runtimeDirectory = options.runtimeDirectory ?? getDefaultRuntimeDirectory();
  loadRuntimeDotenv(runtimeDirectory);

  const telegramEnabled = options.forceTelegramEnabled ?? readRuntimeServiceStatus(runtimeDirectory, "telegram").enabled;
  const telegramCredentials = telegramEnabled ? loadTelegramCredentials(runtimeDirectory) : undefined;
  const opencodeServerHostname = optionalEnv("OPENCODE_SERVER_HOSTNAME") ?? "127.0.0.1";
  const opencodeServerPort = parsePort("OPENCODE_SERVER_PORT", 4096);

  return {
    telegramEnabled,
    telegramBotToken: telegramCredentials?.botToken,
    telegramAllowedUserId: telegramCredentials?.allowedUserId,
    opencodeServerHostname,
    opencodeServerPort,
    opencodeServerDirectory: resolveRuntimePath(runtimeDirectory, optionalEnv("OPENCODE_SERVER_DIRECTORY") ?? DEFAULT_OPENCODE_SERVER_DIRECTORY),
    opencodeServerPrintLogs: parseBoolean("OPENCODE_SERVER_PRINT_LOGS", true),
    opencodeServerAutoStart: readRuntimeServiceStatus(runtimeDirectory, "opencode").enabled,
    opencodeServerUrl: optionalEnv("OPENCODE_SERVER_URL") ?? `http://${opencodeServerHostname}:${opencodeServerPort}`,
    opencodeServerUsername: optionalEnv("OPENCODE_SERVER_USERNAME"),
    opencodeServerPassword: optionalEnv("OPENCODE_SERVER_PASSWORD"),
    opencodeAgent: optionalEnv("OPENCODE_AGENT"),
    opencodeModel: optionalEnv("OPENCODE_MODEL"),
    opencodeDirectory: optionalEnv("OPENCODE_DIRECTORY"),
    opencodeRequestTimeoutMs: parsePositiveInteger("OPENCODE_REQUEST_TIMEOUT_MS", 120000, 600000),
    dagentApiEnabled: readRuntimeServiceStatus(runtimeDirectory, "api").enabled,
    dagentApiHostname: optionalEnv("DAGENT_API_HOSTNAME") ?? "127.0.0.1",
    dagentApiPort: parsePort("DAGENT_API_PORT", 8000),
    dagentApiToken: optionalEnv("DAGENT_API_TOKEN")
  };
}

function parsePositiveInteger(name: string, defaultValue: number, maximum: number): number {
  const value = optionalEnv(name);
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function loadTelegramCredentials(runtimeDirectory: string): { botToken: string; allowedUserId: number } {
  const envBotToken = optionalEnv("TELEGRAM_BOT_TOKEN");
  const envAllowedUserId = optionalEnv("TELEGRAM_ALLOWED_USER_ID");
  if (envBotToken && envAllowedUserId) {
    return {
      botToken: validateTelegramBotToken(envBotToken, "TELEGRAM_BOT_TOKEN"),
      allowedUserId: parseTelegramUserId(envAllowedUserId, "TELEGRAM_ALLOWED_USER_ID")
    };
  }

  const persisted = loadPersistedTelegramCredentials(runtimeDirectory);
  const botToken = envBotToken ? validateTelegramBotToken(envBotToken, "TELEGRAM_BOT_TOKEN") : persisted?.botToken;
  const allowedUserId = envAllowedUserId ? parseTelegramUserId(envAllowedUserId, "TELEGRAM_ALLOWED_USER_ID") : persisted?.allowedUserId;

  if (!botToken || !allowedUserId) {
    const missing = [botToken ? undefined : "bot token", allowedUserId ? undefined : "numeric user id"].filter(Boolean).join(" and ");
    throw new Error(
      `Telegram credentials are not configured (${missing} missing). Run \`dagent --runtime-directory ${runtimeDirectory} services auth telegram --bot-token <token> --user-id <numeric-id>\`, or set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID.`
    );
  }

  return { botToken, allowedUserId };
}

function loadRuntimeDotenv(runtimeDirectory: string): void {
  const dotenvPath = process.env.DOTENV_CONFIG_PATH ? resolveRuntimePath(runtimeDirectory, process.env.DOTENV_CONFIG_PATH) : resolveRuntimePath(runtimeDirectory, ".env");
  loadDotenv({ path: dotenvPath });
}

function parsePort(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }

  return port;
}

function parseBoolean(name: string, defaultValue: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
}
