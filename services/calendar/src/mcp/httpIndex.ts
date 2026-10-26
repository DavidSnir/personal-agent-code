import { pathToFileURL } from "node:url";
import { getDefaultRuntimeDirectory } from "../../../../shared/utils/runtimeDirectory.js";
import { loadGoogleCalendarConfig } from "../google/config.js";
import { resolveStoredGoogleOAuthCredentials } from "../google/credentials.js";
import { GoogleCalendarRepository } from "../google/repository.js";
import { runGoogleCalendarHttpMcpServer } from "./googleCalendarMcpServer.js";
import { safeCalendarErrorMessage } from "../google/calendarError.js";

const DEFAULT_HOSTNAME = "0.0.0.0";
const DEFAULT_PORT = 7332;
const DEFAULT_PATH = "/mcp";

async function main(): Promise<void> {
  const runtimeDirectory = getDefaultRuntimeDirectory();
  const config = loadGoogleCalendarHttpMcpConfig(runtimeDirectory);
  await runGoogleCalendarHttpMcpServer(config, {
    hostname: process.env.DAGENT_CALENDAR_MCP_HOSTNAME?.trim() || DEFAULT_HOSTNAME,
    port: parsePort(process.env.DAGENT_CALENDAR_MCP_PORT, DEFAULT_PORT),
    path: process.env.DAGENT_CALENDAR_MCP_PATH?.trim() || DEFAULT_PATH
  });
}

export function loadGoogleCalendarHttpMcpConfig(runtimeDirectory: string) {
  const config = loadGoogleCalendarConfig({ runtimeDirectory, loadCredentials: false });
  const repository = new GoogleCalendarRepository(config.dbPath);
  repository.initialize();
  try {
    return resolveStoredGoogleOAuthCredentials(config, repository);
  } finally {
    repository.close();
  }
}

function parsePort(value: string | undefined, defaultValue: number): number {
  if (!value?.trim()) return defaultValue;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("DAGENT_CALENDAR_MCP_PORT must be a TCP port between 1 and 65535");
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Google Calendar MCP failed: ${safeCalendarErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
