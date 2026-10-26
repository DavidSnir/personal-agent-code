import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { config as loadDotenv } from "dotenv";

import { getDefaultRuntimeDirectory, getRuntimeServiceDataDirectory, resolveRuntimePath, resolveRuntimeServiceDataPath } from "./runtimeDirectory.js";

export const TELEGRAM_SERVICE_NAME = "telegram";

export type TelegramCredentials = {
  botToken: string;
  allowedUserId: number;
  updatedAt?: number;
};

export type TelegramCredentialStatus = {
  runtimeDirectory: string;
  currentDirectory: string;
  credentialsPath: string;
  env: { botTokenConfigured: boolean; allowedUserIdConfigured: boolean };
  persisted: { present: boolean; botTokenPresent: boolean; allowedUserIdPresent: boolean; updatedAt?: number };
  effective: { configured: boolean; botTokenConfigured: boolean; allowedUserIdConfigured: boolean };
};

export function loadPersistedTelegramCredentials(runtimeDirectory: string = getDefaultRuntimeDirectory()): TelegramCredentials | undefined {
  const credentialsPath = getTelegramCredentialsPath(runtimeDirectory);
  if (!existsSync(credentialsPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Telegram credentials file ${credentialsPath}: ${message}`);
  }
  if (!isObject(parsed)) throw new Error(`Telegram credentials file ${credentialsPath} must contain a JSON object`);

  const botToken = validateTelegramBotToken(parsed.botToken, `Telegram credentials file ${credentialsPath} botToken`);
  const allowedUserId = parseTelegramUserId(parsed.allowedUserId, `Telegram credentials file ${credentialsPath} allowedUserId`);
  const updatedAt = typeof parsed.updatedAt === "number" && Number.isSafeInteger(parsed.updatedAt) && parsed.updatedAt > 0 ? parsed.updatedAt : undefined;
  return { botToken, allowedUserId, updatedAt };
}

export function persistTelegramCredentials(runtimeDirectory: string, credentials: { botToken: string; allowedUserId: string | number }): TelegramCredentials {
  const stored = {
    botToken: validateTelegramBotToken(credentials.botToken, "--bot-token"),
    allowedUserId: parseTelegramUserId(credentials.allowedUserId, "--user-id"),
    updatedAt: Date.now()
  };
  const dataDirectory = getRuntimeServiceDataDirectory(runtimeDirectory, TELEGRAM_SERVICE_NAME);
  const credentialsPath = getTelegramCredentialsPath(runtimeDirectory);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(credentialsPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(credentialsPath, 0o600);
  return stored;
}

export function getTelegramCredentialStatus(runtimeDirectory: string = getDefaultRuntimeDirectory()): TelegramCredentialStatus {
  loadRuntimeDotenv(runtimeDirectory);
  const credentialsPath = getTelegramCredentialsPath(runtimeDirectory);
  const envBotToken = optionalEnv("TELEGRAM_BOT_TOKEN");
  const envUserId = optionalEnv("TELEGRAM_ALLOWED_USER_ID");
  const persisted = loadPersistedTelegramCredentials(runtimeDirectory);
  const botTokenConfigured = Boolean(envBotToken ?? persisted?.botToken);
  const allowedUserIdConfigured = Boolean(envUserId ?? persisted?.allowedUserId);
  return {
    runtimeDirectory,
    currentDirectory: process.cwd(),
    credentialsPath,
    env: { botTokenConfigured: Boolean(envBotToken), allowedUserIdConfigured: Boolean(envUserId) },
    persisted: {
      present: Boolean(persisted),
      botTokenPresent: Boolean(persisted?.botToken),
      allowedUserIdPresent: Boolean(persisted?.allowedUserId),
      updatedAt: persisted?.updatedAt
    },
    effective: { configured: botTokenConfigured && allowedUserIdConfigured, botTokenConfigured, allowedUserIdConfigured }
  };
}

export function getTelegramCredentialsPath(runtimeDirectory: string): string {
  return resolveRuntimeServiceDataPath(runtimeDirectory, TELEGRAM_SERVICE_NAME, "credentials.json");
}

export function validateTelegramBotToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty Telegram bot token`);
  return value.trim();
}

export function parseTelegramUserId(value: unknown, label: string): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} must be a positive numeric Telegram user id`);
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} must be a positive numeric Telegram user id`);
  const userId = Number(text);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error(`${label} must be a positive numeric Telegram user id`);
  return userId;
}

function loadRuntimeDotenv(runtimeDirectory: string): void {
  const dotenvPath = process.env.DOTENV_CONFIG_PATH ? resolveRuntimePath(runtimeDirectory, process.env.DOTENV_CONFIG_PATH) : resolveRuntimePath(runtimeDirectory, ".env");
  loadDotenv({ path: dotenvPath });
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
