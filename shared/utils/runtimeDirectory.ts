import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readDagentUserConfig } from "./userConfig.js";

export function normalizeRuntimeDirectory(runtimeDirectory: string): string {
  return resolve(runtimeDirectory);
}

export function getDefaultRuntimeDirectory(): string {
  return normalizeRuntimeDirectory(process.env.DAGENT_RUNTIME_DIRECTORY?.trim() || readDagentUserConfig().runtimeDirectory || process.cwd());
}

export function resolveRuntimePath(runtimeDirectory: string, path: string): string {
  return isAbsolute(path) ? path : resolve(runtimeDirectory, path);
}

export function getRuntimeDataDirectory(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, "data");
}

export function getRuntimeServiceDataDirectory(runtimeDirectory: string, serviceName: string): string {
  assertServiceName(serviceName);
  return resolve(getRuntimeDataDirectory(runtimeDirectory), serviceName);
}

export function resolveRuntimeServiceDataPath(runtimeDirectory: string, serviceName: string, ...pathSegments: string[]): string {
  return resolve(getRuntimeServiceDataDirectory(runtimeDirectory, serviceName), ...pathSegments);
}

export function ensureRuntimeDirectoryStructure(runtimeDirectory: string, serviceNames: string[] = []): void {
  mkdirSync(getRuntimeDataDirectory(runtimeDirectory), { recursive: true });
  for (const serviceName of serviceNames) {
    mkdirSync(getRuntimeServiceDataDirectory(runtimeDirectory, serviceName), { recursive: true });
  }
}

function assertServiceName(serviceName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(serviceName)) {
    throw new Error(`Invalid runtime service data directory name: ${serviceName}`);
  }
}
