import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export type DagentUserConfig = { runtimeDirectory?: string };

export function getDagentUserConfigPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), ".config");
  return resolve(configHome, "dagent", "config.json");
}

export function readDagentUserConfig(): DagentUserConfig {
  const configPath = getDagentUserConfigPath();
  if (!existsSync(configPath)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read DAgent user config ${configPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid DAgent user config ${configPath}: expected a JSON object`);
  }
  const runtimeDirectory = (parsed as Record<string, unknown>).runtimeDirectory;
  if (runtimeDirectory === undefined) return {};
  if (typeof runtimeDirectory !== "string" || !isAbsolute(runtimeDirectory)) {
    throw new Error(`Invalid DAgent user config ${configPath}: runtimeDirectory must be an absolute path`);
  }
  return { runtimeDirectory: resolve(runtimeDirectory) };
}

export function writeDagentUserConfig(config: DagentUserConfig): void {
  const configPath = getDagentUserConfigPath();
  const configDirectory = dirname(configPath);
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  chmodSync(configDirectory, 0o700);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, configPath);
    chmodSync(configPath, 0o600);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
