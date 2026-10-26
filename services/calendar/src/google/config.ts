import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { getDefaultRuntimeDirectory, resolveRuntimePath, resolveRuntimeServiceDataPath } from "../../../../shared/utils/runtimeDirectory.js";
import { readRuntimeServiceStatus } from "../../../../shared/utils/serviceSettings.js";

export const GOOGLE_CALENDAR_SERVICE_NAME = "google-calendar";

export type GoogleCalendarConfig = {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  credentialsPath?: string;
  dbPath: string;
  syncPastDays: number;
  syncFutureDays: number;
  syncIntervalSeconds: number;
  authRedirectPort: number;
  runtimeDirectory: string;
};

export type GoogleCalendarConfigOptions = {
  credentialsPath?: string;
  loadCredentials?: boolean;
  runtimeDirectory?: string;
};

export function loadGoogleCalendarConfig(options: GoogleCalendarConfigOptions = {}): GoogleCalendarConfig {
  const runtimeDirectory = options.runtimeDirectory ?? getDefaultRuntimeDirectory();
  loadRuntimeDotenv(runtimeDirectory);

  const enabled = readRuntimeServiceStatus(runtimeDirectory, "calendar").enabled;
  const envCredentialsPath = optionalEnv("GOOGLE_CALENDAR_CREDENTIALS_PATH");
  const credentialsPath = resolveOptionalRuntimePath(runtimeDirectory, options.credentialsPath ?? envCredentialsPath);
  const shouldLoadCredentials = Boolean(credentialsPath && (options.loadCredentials ?? enabled));
  const credentials = shouldLoadCredentials && credentialsPath ? loadCredentialsFile(credentialsPath) : undefined;
  const dbPath = optionalEnv("GOOGLE_CALENDAR_DB_PATH");
  return {
    enabled,
    clientId: options.credentialsPath ? credentials?.clientId : optionalEnv("GOOGLE_CALENDAR_CLIENT_ID") ?? credentials?.clientId,
    clientSecret: options.credentialsPath ? credentials?.clientSecret : optionalEnv("GOOGLE_CALENDAR_CLIENT_SECRET") ?? credentials?.clientSecret,
    credentialsPath,
    dbPath: dbPath ? resolveRuntimePath(runtimeDirectory, dbPath) : resolveRuntimeServiceDataPath(runtimeDirectory, GOOGLE_CALENDAR_SERVICE_NAME, "google-calendar.sqlite"),
    syncPastDays: parseNonNegativeInteger("GOOGLE_CALENDAR_SYNC_PAST_DAYS", 30),
    syncFutureDays: parseNonNegativeInteger("GOOGLE_CALENDAR_SYNC_FUTURE_DAYS", 90),
    syncIntervalSeconds: parsePositiveInteger("GOOGLE_CALENDAR_SYNC_INTERVAL_SECONDS", 60),
    authRedirectPort: parsePort("GOOGLE_CALENDAR_AUTH_REDIRECT_PORT", 0),
    runtimeDirectory
  };
}

function loadRuntimeDotenv(runtimeDirectory: string): void {
  const dotenvPath = process.env.DOTENV_CONFIG_PATH ? resolveRuntimePath(runtimeDirectory, process.env.DOTENV_CONFIG_PATH) : resolveRuntimePath(runtimeDirectory, ".env");
  loadDotenv({ path: dotenvPath });
}

export function requireGoogleOAuthConfig(config: GoogleCalendarConfig): { clientId: string; clientSecret: string } {
  if (!config.clientId) {
    throw new Error("Google Calendar OAuth client ID is required. Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, or pass -f <credentials.json>.");
  }
  if (!config.clientSecret) {
    throw new Error("Google Calendar OAuth client secret is required. Set GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET, or pass -f <credentials.json>.");
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

function loadCredentialsFile(credentialsPath: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Google Calendar credentials file ${credentialsPath}: ${message}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`Google Calendar credentials file ${credentialsPath} must contain a JSON object`);
  }

  const client = readOAuthClient(parsed.installed) ?? readOAuthClient(parsed.web);
  if (!client) {
    throw new Error(`Google Calendar credentials file ${credentialsPath} must contain installed.client_id/client_secret or web.client_id/client_secret`);
  }

  return client;
}

function readOAuthClient(value: unknown): { clientId: string; clientSecret: string } | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const clientId = typeof value.client_id === "string" ? value.client_id.trim() : "";
  const clientSecret = typeof value.client_secret === "string" ? value.client_secret.trim() : "";
  if (!clientId || !clientSecret) {
    return undefined;
  }

  return { clientId, clientSecret };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveOptionalRuntimePath(runtimeDirectory: string, path: string | undefined): string | undefined {
  return path ? resolveRuntimePath(runtimeDirectory, path) : undefined;
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

function parseNonNegativeInteger(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveInteger(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parsePort(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 0 and 65535`);
  }

  return port;
}
