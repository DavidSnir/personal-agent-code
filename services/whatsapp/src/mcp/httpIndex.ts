import { pathToFileURL } from "node:url";
import { getDefaultRuntimeDirectory } from "../../../../shared/utils/runtimeDirectory.js";
import { loadWhatsappConfig } from "../whatsapp/config.js";
import { runWhatsappHttpMcpServer } from "./whatsappMcpServer.js";

const DEFAULT_HOSTNAME = "0.0.0.0";
const DEFAULT_PORT = 7333;
const DEFAULT_PATH = "/mcp";

async function main(): Promise<void> {
  const runtimeDirectory = getDefaultRuntimeDirectory();
  const config = loadWhatsappConfig({ runtimeDirectory });
  await runWhatsappHttpMcpServer(config, {
    hostname: process.env.DAGENT_WHATSAPP_MCP_HOSTNAME?.trim() || DEFAULT_HOSTNAME,
    port: parsePort(process.env.DAGENT_WHATSAPP_MCP_PORT, DEFAULT_PORT),
    path: process.env.DAGENT_WHATSAPP_MCP_PATH?.trim() || DEFAULT_PATH
  });
}

function parsePort(value: string | undefined, defaultValue: number): number {
  if (!value?.trim()) return defaultValue;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error("DAGENT_WHATSAPP_MCP_PORT must be a TCP port between 1 and 65535");
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("WhatsApp MCP failed:", error);
    process.exitCode = 1;
  });
}
