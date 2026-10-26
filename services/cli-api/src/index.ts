import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import { getDefaultRuntimeDirectory, resolveRuntimePath } from "../../../shared/utils/runtimeDirectory.js";
import { DagentApiService } from "./dagentApiService.js";
import { loadWhatsappConfig } from "../../whatsapp/src/whatsapp/config.js";
import { WahaClient } from "./whatsapp/wahaClient.js";
import { WhatsappControlService } from "./whatsapp/whatsappControlService.js";

const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_AGENT_CONTAINER_NAME = "dagent-agent";

async function main(): Promise<void> {
  const runtimeDirectory = getDefaultRuntimeDirectory();
  const config = loadCliApiConfig(runtimeDirectory);
  const agentRuntimeDirectory = process.env.DAGENT_AGENT_RUNTIME_DIRECTORY ?? runtimeDirectory;
  const whatsappRuntimeDirectory = requiredEnv("DAGENT_WHATSAPP_RUNTIME_DIRECTORY");
  const whatsappConfig = loadWhatsappConfig({ runtimeDirectory: whatsappRuntimeDirectory });
  const whatsapp = new WhatsappControlService(
    whatsappConfig,
    new WahaClient({
      baseUrl: requiredEnv("WAHA_BASE_URL"),
      apiKey: requiredEnv("WAHA_API_KEY"),
      sendTimeoutMs: whatsappConfig.sendTimeoutMs,
      lifecycleTimeoutMs: whatsappConfig.lifecycleTimeoutMs
    })
  );
  const service = new DagentApiService({
    runtimeDirectory,
    hostname: config.dagentApiHostname,
    port: config.dagentApiPort,
    token: config.dagentApiToken,
    agentRuntimeDirectory,
    agentOpencodeConfigPath: process.env.DAGENT_AGENT_OPENCODE_CONFIG_PATH,
    agentRestartCommand: process.env.DAGENT_AGENT_RESTART_COMMAND ?? getDefaultAgentRestartCommand(),
    telegramRuntimeDirectory: process.env.DAGENT_TELEGRAM_RUNTIME_DIRECTORY,
    whatsapp,
    whatsappWebhookSecret: requiredEnv("WAHA_WEBHOOK_SECRET"),
    loadCalendarCredentialsFile: false
  });

  await service.start();
  await waitForShutdownSignal();
  await service.stop();
}

type CliApiConfig = {
  dagentApiHostname: string;
  dagentApiPort: number;
  dagentApiToken?: string;
};

function loadCliApiConfig(runtimeDirectory: string): CliApiConfig {
  loadRuntimeDotenv(runtimeDirectory);
  return {
    dagentApiHostname: optionalEnv("DAGENT_API_HOSTNAME") ?? "127.0.0.1",
    dagentApiPort: parsePort("DAGENT_API_PORT", 8000),
    dagentApiToken: optionalEnv("DAGENT_API_TOKEN")
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

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(name: string, defaultValue: number): number {
  const value = optionalEnv(name);
  if (!value) return defaultValue;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export function getDefaultAgentRestartCommand(socketPath = DEFAULT_DOCKER_SOCKET_PATH): string | undefined {
  if (!existsSync(socketPath)) return undefined;
  return `node dist/services/cli-api/src/restartDockerContainer.js ${DEFAULT_AGENT_CONTAINER_NAME}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("DAgent CLI API failed:", error);
    process.exitCode = 1;
  });
}
