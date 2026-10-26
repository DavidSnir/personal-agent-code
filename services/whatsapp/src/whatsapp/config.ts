import { config as loadDotenv } from "dotenv";

import { getDefaultRuntimeDirectory, resolveRuntimePath, resolveRuntimeServiceDataPath } from "../../../../shared/utils/runtimeDirectory.js";

export const WHATSAPP_SERVICE_NAME = "whatsapp";

export type WhatsappConfig = {
  runtimeDirectory: string;
  dbPath: string;
  workerIntervalSeconds: number;
  sendTimeoutMs: number;
  lifecycleTimeoutMs: number;
  startupReconcileTimeoutMs: number;
  startupRetryIntervalMs: number;
};

export type WhatsappConfigOptions = {
  runtimeDirectory?: string;
};

export function loadWhatsappConfig(options: WhatsappConfigOptions = {}): WhatsappConfig {
  const runtimeDirectory = options.runtimeDirectory ?? getDefaultRuntimeDirectory();
  loadRuntimeDotenv(runtimeDirectory);

  const dbPath = optionalEnv("WHATSAPP_DB_PATH");

  return {
    runtimeDirectory,
    dbPath: dbPath ? resolveRuntimePath(runtimeDirectory, dbPath) : resolveRuntimeServiceDataPath(runtimeDirectory, WHATSAPP_SERVICE_NAME, "whatsapp.sqlite"),
    workerIntervalSeconds: parsePositiveInteger("WHATSAPP_WORKER_INTERVAL_SECONDS", 60),
    sendTimeoutMs: parsePositiveInteger("WHATSAPP_SEND_TIMEOUT_MS", 120000, 600000),
    lifecycleTimeoutMs: parsePositiveInteger("WHATSAPP_LIFECYCLE_TIMEOUT_MS", 10000, 120000),
    startupReconcileTimeoutMs: parsePositiveInteger("WHATSAPP_STARTUP_RECONCILE_TIMEOUT_MS", 30000, 300000),
    startupRetryIntervalMs: parsePositiveInteger("WHATSAPP_STARTUP_RETRY_INTERVAL_MS", 1000, 30000)
  };
}

function loadRuntimeDotenv(runtimeDirectory: string): void {
  const dotenvPath = process.env.DOTENV_CONFIG_PATH ? resolveRuntimePath(runtimeDirectory, process.env.DOTENV_CONFIG_PATH) : resolveRuntimePath(runtimeDirectory, ".env");
  loadDotenv({ path: dotenvPath });
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parsePositiveInteger(name: string, defaultValue: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = optionalEnv(name);
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}
