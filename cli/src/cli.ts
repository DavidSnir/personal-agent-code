#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runApp } from "../../services/telegram/src/app.js";
import { GOOGLE_CALENDAR_SERVICE_NAME, loadGoogleCalendarConfig } from "../../services/calendar/src/google/config.js";
import { resolveStoredGoogleOAuthCredentials } from "../../services/calendar/src/google/credentials.js";
import { runGoogleCalendarAuth } from "../../services/calendar/src/google/oauth.js";
import { GoogleCalendarRepository } from "../../services/calendar/src/google/repository.js";
import { GoogleCalendarSync } from "../../services/calendar/src/google/sync.js";
import { runGoogleCalendarMcpServer } from "../../services/calendar/src/mcp/googleCalendarMcpServer.js";
import { runWhatsappMcpServer } from "../../services/whatsapp/src/mcp/whatsappMcpServer.js";
import { installCalendarMcpInRuntimeOpencodeConfig, installComposeMcpInRuntimeOpencodeConfig, installDefaultMcpInRuntimeOpencodeConfig, installWhatsappMcpInRuntimeOpencodeConfig } from "../../services/agent/src/opencode/runtimeConfig.js";
import { ensureRuntimeDirectoryStructure, getDefaultRuntimeDirectory, getRuntimeDataDirectory, getRuntimeServiceDataDirectory, normalizeRuntimeDirectory, resolveRuntimePath, resolveRuntimeServiceDataPath } from "../../shared/utils/runtimeDirectory.js";
import { normalizeRuntimeServiceName, persistRuntimeServiceEnabled, readRuntimeServiceStatus, readRuntimeServiceStatuses, RUNTIME_SERVICE_DEFINITIONS, type RuntimeServiceName } from "../../shared/utils/serviceSettings.js";
import { getTelegramCredentialStatus, getTelegramCredentialsPath, persistTelegramCredentials, TELEGRAM_SERVICE_NAME } from "../../services/telegram/src/telegram/credentials.js";
import { loadWhatsappConfig, WHATSAPP_SERVICE_NAME } from "../../services/whatsapp/src/whatsapp/config.js";
import { WhatsappRepository } from "../../services/whatsapp/src/whatsapp/repository.js";
import { getDagentUserConfigPath, readDagentUserConfig, writeDagentUserConfig } from "../../shared/utils/userConfig.js";

type GoogleCalendarCommand = "auth" | "sync" | "status" | "mcp";
type WhatsappCommand = "mcp";
type TelegramCommand = "auth" | "status";
type ServicesAction = "list" | "status" | "enable" | "disable" | "auth" | "logout" | "sync" | "init" | "mcp";
type ServiceTargetName = RuntimeServiceName | "whatsapp";
type CliApiConfig = { url?: string; token?: string };
type WorkerPidFile = { pid: number; runtimeDirectory: string; logPath: string; startedAt: string };

const DAGENT_SERVICE_NAME = "dagent";
const DETACHED_APP_COMMAND = "__run-detached-app";
const STOP_TIMEOUT_MS = 10_000;
const STOP_POLL_INTERVAL_MS = 250;
const CLI_ENTRY_PATH = fileURLToPath(import.meta.url);

type GoogleCalendarArgs = {
  command?: string;
  credentialsPath?: string;
  help: boolean;
};

type TelegramArgs = {
  command?: string;
  botToken?: string;
  userId?: string;
  help: boolean;
};

type ParsedCliArgs = {
  args: string[];
  runtimeDirectory?: string;
};

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const [command, ...rest] = parsed.args;

  if (command === "config") {
    runConfigCommand(rest, parsed.runtimeDirectory);
    return;
  }

  const runtimeDirectory = parsed.runtimeDirectory ? normalizeRuntimeDirectory(parsed.runtimeDirectory) : getDefaultRuntimeDirectory();

  if (!command) {
    printUsage(runtimeDirectory);
    process.exitCode = 1;
    return;
  }

  if (command === "help" || command === "-h" || command === "--help") {
    printUsage(runtimeDirectory);
    return;
  }

  const cliApiUrl = getCliApiUrl(runtimeDirectory);
  if (cliApiUrl && (command === "start" || command === "stop" || command === DETACHED_APP_COMMAND)) {
    throw new Error(`${command} is a native supervisor operation and is disabled while a CLI API URL is configured. Manage the Compose deployment directly, or clear DAGENT_CLI_API_URL/runtime cli-api config before using the native supervisor.`);
  }

  if (isRemoteCalendarAuthCommand(command, rest) && cliApiUrl) {
    await runRemoteCalendarAuthCommand(rest, runtimeDirectory);
    return;
  }

  if (isRemoteTelegramAuthCommand(command, rest) && cliApiUrl) {
    await runRemoteTelegramAuthCommand(rest, runtimeDirectory);
    return;
  }

  if (isRemoteWhatsappCommand(command, rest)) {
    await runRemoteWhatsappCommand(rest, runtimeDirectory);
    return;
  }

  if (cliApiUrl && command === "init") {
    if (rest.length > 0) throw new Error(`Unknown argument for init: ${rest[0]}`);
    await printCliApiJson(runtimeDirectory, "POST", "/deployment/init");
    return;
  }

  if (cliApiUrl && command === "services" && rest[0] !== "mcp") {
    await runRemoteServicesCommand(rest, runtimeDirectory);
    return;
  }

  switch (command) {
    case "start":
      await runStartCommand(rest, runtimeDirectory);
      return;
    case "stop":
      await runStopCommand(rest, runtimeDirectory);
      return;
    case "init":
      runInitCommand(rest, runtimeDirectory);
      return;
    case "services":
      await runServicesCommand(rest, runtimeDirectory);
      return;
    case "cli-api":
      runCliApiCommand(rest, runtimeDirectory);
      return;
    case "completion":
      runCompletionCommand(rest);
      return;
    case DETACHED_APP_COMMAND:
      await runDetachedAppCommand(rest, runtimeDirectory);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function runConfigCommand(args: string[], explicitRuntimeDirectory?: string): void {
  const [subject, ...rest] = args;
  if (!subject || subject === "help" || isHelpArg(subject)) {
    printConfigUsage();
    process.exitCode = subject ? 0 : 1;
    return;
  }
  if (subject !== "runtime-directory") throw new Error(`Unknown config command: ${subject}`);

  let path: string | undefined;
  let clear = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (isHelpArg(arg)) {
      printConfigRuntimeDirectoryUsage();
      return;
    }
    if (arg === "--clear") {
      clear = true;
      continue;
    }
    if (arg === "--path") {
      path = rest[index + 1];
      if (!path || path.startsWith("-")) throw new Error("--path requires an absolute runtime directory path");
      index += 1;
      continue;
    }
    if (arg.startsWith("--path=")) {
      path = arg.slice("--path=".length).trim();
      if (!path) throw new Error("--path requires an absolute runtime directory path");
      continue;
    }
    throw new Error(`Unknown argument for config runtime-directory: ${arg}`);
  }
  if (path && clear) throw new Error("config runtime-directory accepts either --path or --clear, not both");
  if (path && !isAbsolute(path)) throw new Error("--path must be an absolute runtime directory path");

  if (clear) {
    writeDagentUserConfig({});
  } else if (path) {
    writeDagentUserConfig({ runtimeDirectory: resolve(path) });
  }

  const configuredPath = readDagentUserConfig().runtimeDirectory;
  const envPath = process.env.DAGENT_RUNTIME_DIRECTORY?.trim();
  const effectivePath = normalizeRuntimeDirectory(explicitRuntimeDirectory || envPath || configuredPath || process.cwd());
  const source = explicitRuntimeDirectory ? "flag" : envPath ? "env" : configuredPath ? "config" : "cwd";
  console.log(JSON.stringify({ configPath: getDagentUserConfigPath(), configuredPath: configuredPath ?? null, effectivePath, source }, null, 2));
}

function runInitCommand(args: string[], runtimeDirectory: string, compose = false): void {
  if (args.length > 0) {
    if (args.length === 1 && isHelpArg(args[0])) {
      printInitUsage(runtimeDirectory);
      return;
    }
    throw new Error(`Unknown argument for init: ${args[0]}`);
  }

  ensureRuntimeDirectoryStructure(runtimeDirectory, [GOOGLE_CALENDAR_SERVICE_NAME, TELEGRAM_SERVICE_NAME, WHATSAPP_SERVICE_NAME, "opencode"]);
  if (compose) ensureComposeRuntimeBindSources(runtimeDirectory);
  const opencodeConfig = compose ? installComposeMcpInRuntimeOpencodeConfig(runtimeDirectory) : installDefaultMcpInRuntimeOpencodeConfig(runtimeDirectory);
  const loadedCalendarConfig = loadGoogleCalendarConfig({ runtimeDirectory, loadCredentials: false });
  const loadedWhatsappConfig = loadWhatsappConfig({ runtimeDirectory });
  const config = compose
    ? { ...loadedCalendarConfig, dbPath: resolveRuntimeServiceDataPath(runtimeDirectory, GOOGLE_CALENDAR_SERVICE_NAME, "google-calendar.sqlite") }
    : loadedCalendarConfig;
  const whatsappConfig = compose
    ? { ...loadedWhatsappConfig, dbPath: resolveRuntimeServiceDataPath(runtimeDirectory, WHATSAPP_SERVICE_NAME, "whatsapp.sqlite") }
    : loadedWhatsappConfig;
  const repository = new GoogleCalendarRepository(config.dbPath);
  const whatsappRepository = new WhatsappRepository(whatsappConfig.dbPath);
  try {
    repository.initialize();
    whatsappRepository.initialize();
    console.log(
      JSON.stringify(
        {
          ...repository.getStatus(config),
          runtimeDataDirectory: getRuntimeDataDirectory(runtimeDirectory),
          googleCalendarDataDirectory: getRuntimeServiceDataDirectory(runtimeDirectory, GOOGLE_CALENDAR_SERVICE_NAME),
          telegramDataDirectory: getRuntimeServiceDataDirectory(runtimeDirectory, TELEGRAM_SERVICE_NAME),
          whatsappDataDirectory: getRuntimeServiceDataDirectory(runtimeDirectory, WHATSAPP_SERVICE_NAME),
          whatsapp: whatsappRepository.getStatus(whatsappConfig),
          opencodeConfig,
          deploymentMode: compose ? "compose" : "native"
        },
        null,
        2
      )
    );
  } finally {
    repository.close();
    whatsappRepository.close();
  }
}

function ensureComposeRuntimeBindSources(runtimeDirectory: string): void {
  const privateDirectories = [
    resolve(runtimeDirectory, "agent", "workspace"),
    getRuntimeServiceDataDirectory(runtimeDirectory, GOOGLE_CALENDAR_SERVICE_NAME),
    getRuntimeServiceDataDirectory(runtimeDirectory, TELEGRAM_SERVICE_NAME),
    getRuntimeServiceDataDirectory(runtimeDirectory, WHATSAPP_SERVICE_NAME),
    getRuntimeServiceDataDirectory(runtimeDirectory, "opencode"),
    resolveRuntimeServiceDataPath(runtimeDirectory, WHATSAPP_SERVICE_NAME, "waha-sessions")
  ];
  for (const directory of privateDirectories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const settingsPath = resolve(runtimeDirectory, ".settings");
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, "", { mode: 0o600 });
  chmodSync(settingsPath, 0o600);
}

function runTelegramCommand(args: string[], runtimeDirectory: string): void {
  const { command, botToken, userId, help } = parseTelegramArgs(args);
  if (!command || command === "help" || help) {
    printTelegramUsage(runtimeDirectory);
    process.exitCode = command || help ? 0 : 1;
    return;
  }
  if (!isTelegramCommand(command)) {
    printTelegramUsage(runtimeDirectory);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "auth": {
      if (!botToken) {
        throw new Error("telegram auth requires --bot-token <token>");
      }
      if (!userId) {
        throw new Error("telegram auth requires --user-id <numeric-id>");
      }
      persistTelegramCredentials(runtimeDirectory, { botToken, allowedUserId: userId });
      console.log(`Telegram credentials stored in ${getTelegramCredentialsPath(runtimeDirectory)}`);
      console.log("Token present: true");
      console.log("User id present: true");
      break;
    }
    case "status":
      if (botToken || userId) {
        throw new Error("telegram status does not accept --bot-token or --user-id");
      }
      console.log(JSON.stringify(getTelegramCredentialStatus(runtimeDirectory), null, 2));
      break;
    default:
      printUsage(runtimeDirectory);
      process.exitCode = 1;
  }
}

async function runServicesCommand(args: string[], runtimeDirectory: string): Promise<void> {
  const [action, serviceArg, ...rest] = args;
  const help = args.some(isHelpArg);
  if (!action || action === "help" || help) {
    printServicesUsage(runtimeDirectory);
    process.exitCode = action || help ? 0 : 1;
    return;
  }
  if (!isServicesAction(action)) {
    printServicesUsage(runtimeDirectory);
    process.exitCode = 1;
    return;
  }

  switch (action) {
    case "list":
      if (serviceArg) {
        throw new Error("services list does not accept a service name");
      }
      console.log(JSON.stringify(readRuntimeServiceStatuses(runtimeDirectory), null, 2));
      return;
    case "status":
      if (!serviceArg) {
        console.log(JSON.stringify(readRuntimeServiceStatuses(runtimeDirectory), null, 2));
        return;
      }
      await runServicesStatusCommand(serviceArg, rest, runtimeDirectory);
      return;
    case "enable":
    case "disable": {
      if (!serviceArg) {
        throw new Error(`services ${action} requires a service name: ${formatRuntimeServiceNames()}`);
      }
      if (rest.length > 0) {
        throw new Error(`Unknown argument for services ${action} ${serviceArg}: ${rest[0]}`);
      }
      const serviceName = parseRuntimeServiceName(serviceArg);
      console.log(JSON.stringify(persistRuntimeServiceEnabled(runtimeDirectory, serviceName, action === "enable"), null, 2));
      return;
    }
    case "auth":
      await runServicesAuthCommand(serviceArg, rest, runtimeDirectory);
      return;
    case "logout":
      await runServicesLogoutCommand(serviceArg, rest, runtimeDirectory);
      return;
    case "sync":
      await runServicesSyncCommand(serviceArg, rest, runtimeDirectory);
      return;
    case "init":
      await runServicesInitCommand(serviceArg, rest, runtimeDirectory);
      return;
    case "mcp":
      await runServicesMcpCommand(serviceArg, rest, runtimeDirectory);
      return;
    default:
      printServicesUsage(runtimeDirectory);
      process.exitCode = 1;
  }
}

async function printCliApiJson(runtimeDirectory: string, method: "GET" | "POST", path: string, requestBody?: unknown): Promise<void> {
  process.stdout.write(await requestCliApiText(runtimeDirectory, method, path, requestBody));
}

async function requestCliApiJson(runtimeDirectory: string, method: "GET" | "POST", path: string, requestBody?: unknown): Promise<unknown> {
  const responseBody = await requestCliApiText(runtimeDirectory, method, path, requestBody);
  return responseBody ? JSON.parse(responseBody) : undefined;
}

async function requestCliApiText(runtimeDirectory: string, method: "GET" | "POST", path: string, requestBody?: unknown): Promise<string> {
  const apiUrl = getCliApiUrl(runtimeDirectory);
  if (!apiUrl) {
    throw new Error("DAGENT_CLI_API_URL is not configured");
  }
  const url = new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`);
  const token = getCliApiToken(runtimeDirectory);
  const timeoutMs = parseBoundedTimeout("DAGENT_CLI_API_TIMEOUT_MS", 120000, 600000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(requestBody === undefined ? {} : { "content-type": "application/json" })
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      signal: controller.signal
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`DAgent CLI API request failed (${response.status}): ${responseBody.trim() || response.statusText}`);
    }
    return responseBody;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`DAgent CLI API request to ${path} timed out after ${timeoutMs}ms; check the configured CLI API URL and DAGENT_CLI_API_TIMEOUT_MS`);
    }
    if (error instanceof Error && error.message.startsWith("DAgent CLI API request failed")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DAgent CLI API request to ${path} failed: ${message.slice(0, 500)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseBoundedTimeout(name: string, defaultValue: number, maximum: number): number {
  const value = process.env[name]?.trim();
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function getCliApiUrl(runtimeDirectory: string): string | undefined {
  const envValue = process.env.DAGENT_CLI_API_URL?.trim();
  if (envValue) return envValue;
  return readCliApiConfig(runtimeDirectory).url;
}

function getCliApiToken(runtimeDirectory: string): string | undefined {
  const envValue = process.env.DAGENT_CLI_API_TOKEN?.trim() || process.env.DAGENT_API_TOKEN?.trim();
  if (envValue) return envValue;
  return readCliApiConfig(runtimeDirectory).token;
}

async function runRemoteServicesCommand(args: string[], runtimeDirectory: string): Promise<void> {
  const [action, serviceArg, ...rest] = args;
  if (!action || action === "help" || args.some(isHelpArg)) {
    printServicesUsage(runtimeDirectory);
    return;
  }
  if (action === "list") {
    if (serviceArg) throw new Error("services list does not accept a service name");
    await printCliApiJson(runtimeDirectory, "GET", "/services");
    return;
  }
  if (action === "enable" || action === "disable") {
    if (!serviceArg || rest.length) throw new Error(`services ${action} requires exactly one native service name`);
    const serviceName = parseRuntimeServiceName(serviceArg);
    await printCliApiJson(runtimeDirectory, "POST", `/services/${serviceName}/${action}`);
    return;
  }
  if (action === "status") {
    if (rest.length) throw new Error(`Remote services status does not accept extra arguments: ${rest[0]}`);
    if (!serviceArg) return printCliApiJson(runtimeDirectory, "GET", "/services");
    const serviceName = parseServiceTargetName(serviceArg);
    const path = serviceName === "telegram" ? "/telegram/status"
      : serviceName === "calendar" ? "/calendar/status"
      : serviceName === "whatsapp" ? "/whatsapp/status"
      : `/services/${serviceName}`;
    await printCliApiJson(runtimeDirectory, "GET", path);
    return;
  }
  if (action === "init" && (!serviceArg || serviceArg === "compose")) {
    if (rest.length) throw new Error(`Unknown argument for services init: ${rest[0]}`);
    await printCliApiJson(runtimeDirectory, "POST", "/deployment/init");
    return;
  }
  if (action === "sync" && serviceArg === "calendar") {
    if (rest.length) throw new Error("Remote Calendar sync does not accept --credentials-file; credentials must already be stored by Calendar auth");
    await printCliApiJson(runtimeDirectory, "POST", "/calendar/sync");
    return;
  }
  throw new Error(`Unsupported control API operation: services ${args.join(" ")}`);
}

function isRemoteCalendarAuthCommand(command: string, rest: string[]): boolean {
  return command === "services" && rest[0] === "auth" && rest[1] === "calendar";
}

function isRemoteTelegramAuthCommand(command: string, rest: string[]): boolean {
  return command === "services" && rest[0] === "auth" && rest[1] === "telegram";
}

async function runRemoteTelegramAuthCommand(rest: string[], runtimeDirectory: string): Promise<void> {
  const { botToken, userId, help } = parseTelegramArgs(["auth", ...rest.slice(2)]);
  if (help) {
    printTelegramUsage(runtimeDirectory);
    return;
  }
  if (!botToken) throw new Error("telegram auth requires --bot-token <token>");
  if (!userId) throw new Error("telegram auth requires --user-id <numeric-id>");
  await printCliApiJson(runtimeDirectory, "POST", "/telegram/auth", { botToken, userId });
}

function isRemoteWhatsappCommand(command: string, rest: string[]): boolean {
  if (command !== "services") return false;
  const [action, serviceName, ...extra] = rest;
  if (serviceName !== "whatsapp" || extra.some(isHelpArg)) return false;
  return action === "auth" || action === "sync" || action === "logout" || action === "init" || action === "status";
}

async function runRemoteWhatsappCommand(rest: string[], runtimeDirectory: string): Promise<void> {
  const [action, serviceName, ...extra] = rest;
  if (serviceName !== "whatsapp") throw new Error("Remote WhatsApp command requires service name whatsapp");
  if (extra.length > 0) throw new Error(`Unknown argument for services ${action} whatsapp: ${extra[0]}`);

  switch (action) {
    case "init":
      await printCliApiJson(runtimeDirectory, "POST", "/whatsapp/init");
      return;
    case "status":
      await printCliApiJson(runtimeDirectory, "GET", "/whatsapp/status");
      return;
    case "logout":
      await printCliApiJson(runtimeDirectory, "POST", "/whatsapp/logout");
      return;
    case "sync":
      await runRemoteWhatsappSessionCommand(runtimeDirectory, "sync", "/whatsapp/sync/start", "/whatsapp/sync/sessions");
      return;
    case "auth":
      await runRemoteWhatsappAuthCommand(runtimeDirectory);
      return;
    default:
      throw new Error(`Unsupported remote WhatsApp action: ${action}`);
  }
}

async function runRemoteWhatsappAuthCommand(runtimeDirectory: string): Promise<void> {
  const start = (await requestCliApiJson(runtimeDirectory, "POST", "/whatsapp/auth/start")) as { id?: string; status?: string; qrArt?: string };
  if (!start.id) throw new Error("DAgent CLI API did not return a WhatsApp auth session");
  console.log("Waiting for WAHA WhatsApp authorization to complete...");
  let lastQrArt = "";
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = (await requestCliApiJson(runtimeDirectory, "GET", `/whatsapp/auth/sessions/${encodeURIComponent(start.id)}`)) as {
      status?: string;
      error?: string;
      qrArt?: string;
      opencodeConfigPath?: string;
      restart?: { status?: string; message?: string };
    };
    if (status.qrArt && status.qrArt !== lastQrArt) {
      lastQrArt = status.qrArt;
      process.stderr.write(status.qrArt);
      if (!status.qrArt.endsWith("\n")) process.stderr.write("\n");
      console.log("Scan the WhatsApp QR code shown above. QR payload is not logged.");
    }
    if (status.status === "complete") {
      console.log("WhatsApp authorization completed in WAHA.");
      if (status.opencodeConfigPath) {
        if (status.restart?.status === "restarted") {
          console.log(`WhatsApp MCP installed in ${status.opencodeConfigPath}. Agent container restarted for the MCP config to take effect.`);
        } else {
          console.log(`WhatsApp MCP installed in ${status.opencodeConfigPath}. Restart opencode for the MCP config to take effect.`);
          if (status.restart?.message) console.log(`Agent restart ${status.restart.status ?? "status"}: ${status.restart.message}`);
        }
      }
      return;
    }
    if (status.status === "failed") throw new Error(`WhatsApp authorization failed: ${status.error ?? "unknown error"}`);
    await sleep(2_000);
  }
  throw new Error("Timed out waiting for WhatsApp authorization to complete");
}

async function runRemoteWhatsappSessionCommand(runtimeDirectory: string, label: string, startPath: string, sessionPath: string): Promise<void> {
  const start = (await requestCliApiJson(runtimeDirectory, "POST", startPath)) as { id?: string; status?: string; error?: string };
  if (!start.id) throw new Error(`DAgent CLI API did not return a WhatsApp ${label} session`);
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = (await requestCliApiJson(runtimeDirectory, "GET", `${sessionPath}/${encodeURIComponent(start.id)}`)) as { status?: string; error?: string };
    if (status.status === "complete") {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (status.status === "failed") throw new Error(`WhatsApp ${label} failed: ${status.error ?? "unknown error"}`);
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for WhatsApp ${label} to complete`);
}

async function runRemoteCalendarAuthCommand(rest: string[], runtimeDirectory: string): Promise<void> {
  const { credentialsPath, help } = parseGoogleCalendarArgs(rest.slice(1));
  if (help) {
    printGoogleCalendarUsage(runtimeDirectory);
    return;
  }
  const requestBody = credentialsPath ? { credentials: readLocalGoogleCalendarOAuthClient(credentialsPath, runtimeDirectory) } : undefined;
  const start = (await requestCliApiJson(runtimeDirectory, "POST", "/calendar/auth/start", requestBody)) as { sessionId?: string; authUrl?: string };
  if (!start.sessionId || !start.authUrl) {
    throw new Error("DAgent CLI API did not return a Calendar auth session");
  }

  console.log("Open this Google Calendar authorization URL in your browser:");
  console.log(start.authUrl);
  console.log("Waiting for Calendar authorization to complete...");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const status = (await requestCliApiJson(runtimeDirectory, "GET", `/calendar/auth/sessions/${encodeURIComponent(start.sessionId)}`)) as {
      status?: string;
      error?: string;
      opencodeConfigPath?: string;
      restart?: { status?: string; message?: string };
    };
    if (status.status === "complete") {
      console.log("Google Calendar OAuth token stored by CLI API runtime.");
      if (status.opencodeConfigPath) {
        if (status.restart?.status === "restarted") {
          console.log(`Calendar MCP installed in ${status.opencodeConfigPath}. Agent container restarted for the MCP config to take effect.`);
        } else {
          console.log(`Calendar MCP installed in ${status.opencodeConfigPath}. Restart opencode for the MCP config to take effect.`);
          if (status.restart?.message) {
            console.log(`Agent restart ${status.restart.status ?? "status"}: ${status.restart.message}`);
          }
        }
      }
      return;
    }
    if (status.status === "failed") {
      throw new Error(`Google Calendar authorization failed: ${status.error ?? "unknown error"}`);
    }
  }
  throw new Error("Timed out waiting for Google Calendar authorization to complete");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readLocalGoogleCalendarOAuthClient(credentialsPath: string, runtimeDirectory: string): { clientId: string; clientSecret: string } {
  const resolvedPath = resolveRuntimePath(runtimeDirectory, credentialsPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read local Google Calendar credentials file ${resolvedPath}: ${message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Google Calendar credentials file ${resolvedPath} must contain a JSON object`);
  }
  const client = readGoogleOAuthClient(parsed.installed) ?? readGoogleOAuthClient(parsed.web);
  if (!client) {
    throw new Error(`Google Calendar credentials file ${resolvedPath} must contain installed.client_id/client_secret or web.client_id/client_secret`);
  }
  return client;
}

function readGoogleOAuthClient(value: unknown): { clientId: string; clientSecret: string } | undefined {
  if (!isJsonObject(value)) return undefined;
  const clientId = typeof value.client_id === "string" ? value.client_id.trim() : "";
  const clientSecret = typeof value.client_secret === "string" ? value.client_secret.trim() : "";
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runCliApiCommand(args: string[], runtimeDirectory: string): void {
  const [action, ...rest] = args;
  if (!action || action === "help" || isHelpArg(action)) {
    printCliApiUsage(runtimeDirectory);
    process.exitCode = action ? 0 : 1;
    return;
  }
  if (action !== "config") {
    throw new Error(`Unknown cli-api command: ${action}`);
  }
  runCliApiConfigCommand(rest, runtimeDirectory);
}

function runCliApiConfigCommand(args: string[], runtimeDirectory: string): void {
  const config = readCliApiConfig(runtimeDirectory);
  let next = { ...config };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (isHelpArg(arg)) {
      printCliApiConfigUsage(runtimeDirectory);
      return;
    }
    if (arg === "--url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--url requires a cli-api URL");
      next.url = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      next.url = arg.slice("--url=".length).trim();
      if (!next.url) throw new Error("--url requires a cli-api URL");
      continue;
    }
    if (arg === "--token") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--token requires a token value");
      next.token = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--token=")) {
      next.token = arg.slice("--token=".length).trim();
      if (!next.token) throw new Error("--token requires a token value");
      continue;
    }
    if (arg === "--clear-token") {
      delete next.token;
      continue;
    }
    throw new Error(`Unknown argument for cli-api config: ${arg}`);
  }
  if (args.length > 0) writeCliApiConfig(runtimeDirectory, next);
  const effectiveUrl = getCliApiUrl(runtimeDirectory);
  const effectiveToken = getCliApiToken(runtimeDirectory);
  console.log(JSON.stringify({ configPath: getCliApiConfigPath(runtimeDirectory), url: effectiveUrl ?? null, tokenConfigured: Boolean(effectiveToken), urlSource: process.env.DAGENT_CLI_API_URL?.trim() ? "env" : next.url ? "config" : "unset", tokenSource: process.env.DAGENT_CLI_API_TOKEN?.trim() || process.env.DAGENT_API_TOKEN?.trim() ? "env" : next.token ? "config" : "unset" }, null, 2));
}

function getCliApiConfigPath(runtimeDirectory: string): string {
  return join(getRuntimeServiceDataDirectory(runtimeDirectory, DAGENT_SERVICE_NAME), "cli-api.json");
}

function readCliApiConfig(runtimeDirectory: string): CliApiConfig {
  const path = getCliApiConfigPath(runtimeDirectory);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CliApiConfig;
  return { url: typeof parsed.url === "string" && parsed.url.trim() ? parsed.url.trim() : undefined, token: typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : undefined };
}

function writeCliApiConfig(runtimeDirectory: string, config: CliApiConfig): void {
  ensureRuntimeDirectoryStructure(runtimeDirectory, [DAGENT_SERVICE_NAME]);
  writeFileSync(getCliApiConfigPath(runtimeDirectory), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function runServicesStatusCommand(serviceArg: string, rest: string[], runtimeDirectory: string): Promise<void> {
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "opencode":
      if (rest.length > 0) {
        throw new Error(`Unknown argument for services status opencode: ${rest[0]}`);
      }
      console.log(JSON.stringify(readRuntimeServiceStatus(runtimeDirectory, "opencode"), null, 2));
      return;
    case "telegram":
      runTelegramCommand(["status", ...rest], runtimeDirectory);
      return;
    case "calendar":
      await runGoogleCalendarCommand(["status", ...rest], runtimeDirectory);
      return;
    case "whatsapp":
      throw new Error("WhatsApp status requires DAGENT_CLI_API_URL");
    case "api":
      if (rest.length > 0) {
        throw new Error(`Unknown argument for services status api: ${rest[0]}`);
      }
      console.log(JSON.stringify(readRuntimeServiceStatus(runtimeDirectory, "api"), null, 2));
      return;
  }
}

async function runServicesAuthCommand(serviceArg: string | undefined, rest: string[], runtimeDirectory: string): Promise<void> {
  if (!serviceArg) {
    throw new Error(`services auth requires a service name: telegram, calendar, whatsapp`);
  }
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "telegram":
      runTelegramCommand(["auth", ...rest], runtimeDirectory);
      return;
    case "calendar":
      await runGoogleCalendarCommand(["auth", ...rest], runtimeDirectory);
      return;
    case "whatsapp":
      throw new Error("WhatsApp auth requires DAGENT_CLI_API_URL");
    case "opencode":
    case "api":
      throw new Error(`services auth ${serviceArg} is not supported`);
  }
}

async function runServicesLogoutCommand(serviceArg: string | undefined, rest: string[], runtimeDirectory: string): Promise<void> {
  if (!serviceArg) {
    throw new Error("services logout requires a service name: whatsapp");
  }
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "whatsapp":
      throw new Error("WhatsApp logout requires DAGENT_CLI_API_URL");
    case "opencode":
    case "telegram":
    case "calendar":
    case "api":
      throw new Error(`services logout ${serviceArg} is not supported`);
  }
}

async function runServicesSyncCommand(serviceArg: string | undefined, rest: string[], runtimeDirectory: string): Promise<void> {
  if (!serviceArg) {
    throw new Error("services sync requires a service name: calendar or whatsapp");
  }
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "calendar":
      await runGoogleCalendarCommand(["sync", ...rest], runtimeDirectory);
      return;
    case "whatsapp":
      throw new Error("WhatsApp sync requires DAGENT_CLI_API_URL");
    case "opencode":
    case "telegram":
    case "api":
      throw new Error(`services sync ${serviceArg} is not supported`);
  }
}

async function runServicesInitCommand(serviceArg: string | undefined, rest: string[], runtimeDirectory: string): Promise<void> {
  if (!serviceArg) {
    if (rest.length > 0) {
      throw new Error(`Unknown argument for services init: ${rest[0]}`);
    }
    runInitCommand([], runtimeDirectory);
    return;
  }
  if (serviceArg === "compose") {
    if (rest.length > 0) throw new Error(`Unknown argument for services init compose: ${rest[0]}`);
    runInitCommand([], runtimeDirectory, true);
    return;
  }
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "whatsapp":
      throw new Error("WhatsApp init requires DAGENT_CLI_API_URL");
    case "opencode":
    case "telegram":
    case "calendar":
    case "api":
      throw new Error(`services init ${serviceArg} is not supported; use services init to initialize shared runtime files`);
  }
}

async function runServicesMcpCommand(serviceArg: string | undefined, rest: string[], runtimeDirectory: string): Promise<void> {
  if (!serviceArg) {
    throw new Error("services mcp requires a service name: calendar or whatsapp");
  }
  const serviceName = parseServiceTargetName(serviceArg);
  switch (serviceName) {
    case "calendar":
      await runGoogleCalendarCommand(["mcp", ...rest], runtimeDirectory);
      return;
    case "whatsapp":
      await runWhatsappCommand(["mcp", ...rest], runtimeDirectory);
      return;
    case "opencode":
    case "telegram":
    case "api":
      throw new Error(`services mcp ${serviceArg} is not supported`);
  }
}

async function runStartCommand(args: string[], runtimeDirectory: string): Promise<void> {
  if (args.length > 0) {
    if (args.length === 1 && isHelpArg(args[0])) {
      printStartUsage(runtimeDirectory);
      return;
    }
    throw new Error(`Unknown argument for start: ${args[0]}`);
  }

  startDetachedApp(runtimeDirectory);
}

async function runStopCommand(args: string[], runtimeDirectory: string): Promise<void> {
  if (args.length > 0) {
    if (args.length === 1 && isHelpArg(args[0])) {
      printStopUsage(runtimeDirectory);
      return;
    }
    throw new Error(`Unknown argument for stop: ${args[0]}`);
  }

  await stopDetachedApp(runtimeDirectory);
}

async function runDetachedAppCommand(args: string[], runtimeDirectory: string): Promise<void> {
  if (args.length > 0) {
    throw new Error(`Unknown argument for ${DETACHED_APP_COMMAND}: ${args[0]}`);
  }

  writeCurrentProcessPidFile(runtimeDirectory);
  try {
    await runApp({ runtimeDirectory });
  } catch (error) {
    console.error("Startup failed:", error);
    process.exitCode = 1;
  } finally {
    removePidFileIfCurrentProcess(runtimeDirectory);
  }
}

async function runGoogleCalendarCommand(args: string[], runtimeDirectory: string): Promise<void> {
  const { command, credentialsPath, help } = parseGoogleCalendarArgs(args);
  if (!command || command === "help" || help) {
    printGoogleCalendarUsage(runtimeDirectory);
    process.exitCode = command || help ? 0 : 1;
    return;
  }
  if (!isGoogleCalendarCommand(command)) {
    printGoogleCalendarUsage(runtimeDirectory);
    process.exitCode = 1;
    return;
  }

  const config = loadGoogleCalendarConfig({ runtimeDirectory, credentialsPath: command === "mcp" ? undefined : credentialsPath, loadCredentials: command !== "mcp" });
  const repository = new GoogleCalendarRepository(config.dbPath);
  repository.initialize();
  const resolvedConfig = resolveStoredGoogleOAuthCredentials(config, repository);

  try {
    switch (command) {
      case "auth":
        await runGoogleCalendarAuth(resolvedConfig, repository);
        const opencodeConfig = installCalendarMcpInRuntimeOpencodeConfig(runtimeDirectory);
        console.log(`Google Calendar OAuth token stored in ${repository.dbPath}`);
        console.log(`Calendar MCP installed in ${opencodeConfig.configPath}. Restart opencode for the MCP config to take effect.`);
        break;
      case "sync": {
        const sync = new GoogleCalendarSync(resolvedConfig, repository);
        const result = await sync.runOnce();
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "status":
        console.log(JSON.stringify(repository.getStatus(resolvedConfig), null, 2));
        break;
      case "mcp":
        repository.close();
        await runGoogleCalendarMcpServer(resolvedConfig);
        break;
      default:
        printUsage(runtimeDirectory);
        process.exitCode = 1;
    }
  } finally {
    if (command !== "mcp") {
      repository.close();
    }
  }
}

async function runWhatsappCommand(args: string[], runtimeDirectory: string): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || isHelpArg(command)) {
    printWhatsappUsage(runtimeDirectory);
    process.exitCode = command ? 0 : 1;
    return;
  }
  if (!isWhatsappCommand(command)) {
    printWhatsappUsage(runtimeDirectory);
    process.exitCode = 1;
    return;
  }
  if (rest.length > 0) {
    if (rest.length === 1 && isHelpArg(rest[0])) {
      printWhatsappUsage(runtimeDirectory);
      return;
    }
    throw new Error(`Unknown argument for services mcp whatsapp: ${rest[0]}`);
  }

  const config = loadWhatsappConfig({ runtimeDirectory });

  await runWhatsappMcpServer(config);
}

function startDetachedApp(runtimeDirectory: string): void {
  ensureRuntimeDirectoryStructure(runtimeDirectory, [DAGENT_SERVICE_NAME]);
  const pidPath = getDagentPidPath(runtimeDirectory);
  const logPath = getDagentLogPath(runtimeDirectory);
  const existingPidFile = readDagentPidFile(pidPath);

  if (existingPidFile === "invalid") {
    unlinkIfExists(pidPath);
    console.log(`Removed invalid DAgent pid file: ${pidPath}`);
  } else if (existingPidFile) {
    if (isProcessRunning(existingPidFile.pid)) {
      console.log(`DAgent is already running with pid ${existingPidFile.pid}.`);
      console.log(`Log: ${existingPidFile.logPath}`);
      return;
    }

    unlinkIfExists(pidPath);
    console.log(`Removed stale DAgent pid file for pid ${existingPidFile.pid}.`);
  }

  writeFileSync(logPath, `\n[${new Date().toISOString()}] Starting DAgent detached app.\n`, { flag: "a" });

  const stdoutFd = openSync(logPath, "a");
  const stderrFd = openSync(logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [CLI_ENTRY_PATH, "--runtime-directory", runtimeDirectory, DETACHED_APP_COMMAND], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, DAGENT_RUNTIME_DIRECTORY: runtimeDirectory },
      stdio: ["ignore", stdoutFd, stderrFd]
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }

  if (!pid) {
    throw new Error("Failed to start DAgent detached app: child process pid was not available");
  }

  console.log("DAgent started in the background.");
  console.log(`pid: ${pid}`);
  console.log(`log: ${logPath}`);
  console.log(`stop: dagent --runtime-directory ${runtimeDirectory} stop`);
}

async function stopDetachedApp(runtimeDirectory: string): Promise<void> {
  const pidPath = getDagentPidPath(runtimeDirectory);
  const pidFile = readDagentPidFile(pidPath);

  if (!pidFile) {
    console.log(`DAgent is not running; no pid file found at ${pidPath}.`);
    return;
  }

  if (pidFile === "invalid") {
    unlinkIfExists(pidPath);
    console.log(`Removed invalid DAgent pid file: ${pidPath}`);
    return;
  }

  if (!isProcessRunning(pidFile.pid)) {
    unlinkIfExists(pidPath);
    console.log(`Removed stale DAgent pid file for pid ${pidFile.pid}.`);
    return;
  }

  try {
    process.kill(pidFile.pid, "SIGTERM");
  } catch (error) {
    if (getErrorCode(error) === "ESRCH") {
      unlinkIfExists(pidPath);
      console.log(`Removed stale DAgent pid file for pid ${pidFile.pid}.`);
      return;
    }
    throw error;
  }

  console.log(`Sent SIGTERM to DAgent pid ${pidFile.pid}.`);
  const stopped = await waitForProcessExit(pidFile.pid, STOP_TIMEOUT_MS);
  if (stopped) {
    unlinkIfExists(pidPath);
    console.log(`Stopped DAgent pid ${pidFile.pid}.`);
    return;
  }

  console.error(`DAgent pid ${pidFile.pid} did not stop within ${STOP_TIMEOUT_MS / 1000} seconds.`);
  console.error(`Log: ${pidFile.logPath}`);
  process.exitCode = 1;
}

function writeCurrentProcessPidFile(runtimeDirectory: string): void {
  ensureRuntimeDirectoryStructure(runtimeDirectory, [DAGENT_SERVICE_NAME]);
  writeFileSync(
    getDagentPidPath(runtimeDirectory),
    `${JSON.stringify(
      {
        pid: process.pid,
        runtimeDirectory,
        logPath: getDagentLogPath(runtimeDirectory),
        startedAt: new Date().toISOString()
      } satisfies WorkerPidFile,
      null,
      2
    )}\n`
  );
}

function removePidFileIfCurrentProcess(runtimeDirectory: string): void {
  const pidPath = getDagentPidPath(runtimeDirectory);
  const pidFile = readDagentPidFile(pidPath);
  if (pidFile && pidFile !== "invalid" && pidFile.pid === process.pid) {
    unlinkIfExists(pidPath);
  }
}

function readDagentPidFile(pidPath: string) {
  return readWorkerPidFile(pidPath);
}

function readWorkerPidFile(pidPath: string): WorkerPidFile | "invalid" | undefined {
  if (!existsSync(pidPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(pidPath, "utf8")) as Partial<WorkerPidFile>;
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && typeof value.runtimeDirectory === "string" && typeof value.logPath === "string" && typeof value.startedAt === "string") {
      return value as WorkerPidFile;
    }
  } catch {}
  return "invalid";
}

function getDagentPidPath(runtimeDirectory: string): string {
  return resolveRuntimeServiceDataPath(runtimeDirectory, DAGENT_SERVICE_NAME, "dagent.pid");
}

function getDagentLogPath(runtimeDirectory: string): string {
  return resolveRuntimeServiceDataPath(runtimeDirectory, DAGENT_SERVICE_NAME, "dagent.log");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(STOP_POLL_INTERVAL_MS);
  }
  return !isProcessRunning(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function runCompletionCommand(args: string[]): void {
  const [shell, ...rest] = args;
  if (!shell || shell === "help" || isHelpArg(shell)) {
    printCompletionUsage();
    process.exitCode = shell ? 0 : 1;
    return;
  }
  if (shell !== "zsh") {
    throw new Error(`Unsupported completion shell: ${shell}`);
  }
  if (rest.length > 0) {
    throw new Error(`Unknown argument for completion zsh: ${rest[0]}`);
  }

  console.log(ZSH_COMPLETION_SCRIPT);
}

function isGoogleCalendarCommand(command: string): command is GoogleCalendarCommand {
  return command === "auth" || command === "sync" || command === "status" || command === "mcp";
}

function isWhatsappCommand(command: string): command is WhatsappCommand {
  return command === "mcp";
}

function isTelegramCommand(command: string): command is TelegramCommand {
  return command === "auth" || command === "status";
}

function isServicesAction(command: string): command is ServicesAction {
  return command === "list" || command === "status" || command === "enable" || command === "disable" || command === "auth" || command === "logout" || command === "sync" || command === "init" || command === "mcp";
}

function parseServiceTargetName(value: string): ServiceTargetName {
  if (value.trim().toLowerCase() === "whatsapp") return "whatsapp";
  return parseRuntimeServiceName(value);
}

function parseRuntimeServiceName(value: string): RuntimeServiceName {
  const serviceName = normalizeRuntimeServiceName(value);
  if (!serviceName) {
    throw new Error(`Unknown service: ${value}. Supported services: ${formatRuntimeServiceNames()}`);
  }
  return serviceName;
}

function formatRuntimeServiceNames(): string {
  return RUNTIME_SERVICE_DEFINITIONS.map((service) => service.name).join(", ");
}

function parseCliArgs(args: string[]): ParsedCliArgs {
  const remaining: string[] = [];
  let runtimeDirectory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-r" || arg === "--runtime-directory") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a runtime directory path`);
      }
      runtimeDirectory = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--runtime-directory=")) {
      const value = arg.slice("--runtime-directory=".length).trim();
      if (!value) {
        throw new Error("--runtime-directory requires a runtime directory path");
      }
      runtimeDirectory = value;
      continue;
    }
    remaining.push(arg);
  }

  return {
    args: remaining,
    runtimeDirectory
  };
}

function parseGoogleCalendarArgs(args: string[]): GoogleCalendarArgs {
  const [command, ...rest] = args;
  let credentialsPath: string | undefined;
  let help = command ? isHelpArg(command) : false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (isHelpArg(arg)) {
      help = true;
      continue;
    }
    if (arg === "-f" || arg === "--credentials-file") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a path to credentials.json`);
      }
      credentialsPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--credentials-file=")) {
      const value = arg.slice("--credentials-file=".length).trim();
      if (!value) {
        throw new Error("--credentials-file requires a path to credentials.json");
      }
      credentialsPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, credentialsPath, help };
}

function parseTelegramArgs(args: string[]): TelegramArgs {
  const [command, ...rest] = args;
  let botToken: string | undefined;
  let userId: string | undefined;
  let help = command ? isHelpArg(command) : false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (isHelpArg(arg)) {
      help = true;
      continue;
    }
    if (arg === "--bot-token") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--bot-token requires a Telegram bot token");
      }
      botToken = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot-token=")) {
      const value = arg.slice("--bot-token=".length).trim();
      if (!value) {
        throw new Error("--bot-token requires a Telegram bot token");
      }
      botToken = value;
      continue;
    }
    if (arg === "--user-id") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--user-id requires a positive numeric Telegram user id");
      }
      userId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      const value = arg.slice("--user-id=".length).trim();
      if (!value) {
        throw new Error("--user-id requires a positive numeric Telegram user id");
      }
      userId = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, botToken, userId, help };
}

function isHelpArg(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function printUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] start
  dagent [--runtime-directory <path>] stop
  dagent [--runtime-directory <path>] services list
  dagent [--runtime-directory <path>] services status [opencode|telegram|calendar|whatsapp|api]
  dagent [--runtime-directory <path>] services enable <opencode|telegram|calendar|api>
  dagent [--runtime-directory <path>] services disable <opencode|telegram|calendar|api>
  dagent [--runtime-directory <path>] services auth telegram --bot-token <token> --user-id <numeric-id>
  dagent [--runtime-directory <path>] services auth calendar [-f <credentials.json>]
  dagent [--runtime-directory <path>] services auth whatsapp
  dagent [--runtime-directory <path>] services logout whatsapp
  dagent [--runtime-directory <path>] services sync <calendar|whatsapp> [-f <credentials.json>]
  dagent [--runtime-directory <path>] services init [compose|whatsapp]
  dagent [--runtime-directory <path>] services mcp <calendar|whatsapp>
  dagent [--runtime-directory <path>] cli-api config [--url <url>] [--token <token>] [--clear-token]
  dagent config runtime-directory [--path <absolute-path> | --clear]
  dagent completion zsh
  dagent help

Commands:
  start            Start all enabled services in the background supervisor
  stop             Stop the background supervisor and its services
  services         Manage service settings and service-specific operations
  cli-api          Configure the native CLI connection to the HTTP control API
  config           Configure runtime-independent user defaults
  completion zsh   Print zsh completion script to stdout
  help             Show this help

Options:
  -r, --runtime-directory <path>  Select the live/runtime folder; overrides env, config, and cwd

runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}
Relative .env, .settings, Telegram credentials, Google Calendar DB, WhatsApp DB, and credentials paths resolve from this directory.
Default service data lives under ${getRuntimeDataDirectory(runtimeDirectory)}/[service].`);
}

function printConfigUsage(): void {
  console.log(`Usage: dagent config runtime-directory [--path <absolute-path> | --clear]

Commands:
  runtime-directory  Show, set, or clear the persistent default runtime directory`);
}

function printConfigRuntimeDirectoryUsage(): void {
  console.log(`Usage: dagent config runtime-directory [--path <absolute-path> | --clear]

Shows the configured path, effective path, and selection source. The config command is local and does not create or initialize the selected runtime directory.
configPath: ${getDagentUserConfigPath()}`);
}

function printServicesUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] services list
  dagent [--runtime-directory <path>] services status [opencode|telegram|calendar|whatsapp|api]
  dagent [--runtime-directory <path>] services enable <opencode|telegram|calendar|api>
  dagent [--runtime-directory <path>] services disable <opencode|telegram|calendar|api>
  dagent [--runtime-directory <path>] services auth telegram --bot-token <token> --user-id <numeric-id>
  dagent [--runtime-directory <path>] services auth calendar [-f <credentials.json>]
  dagent [--runtime-directory <path>] services auth whatsapp
  dagent [--runtime-directory <path>] services logout whatsapp
  dagent [--runtime-directory <path>] services sync <calendar|whatsapp> [-f <credentials.json>]
  dagent [--runtime-directory <path>] services init [compose|whatsapp]
  dagent [--runtime-directory <path>] services mcp <calendar|whatsapp>

Commands:
  list     Print all runtime service enablement settings as JSON
  status   Print service-specific status, or enablement settings when service is omitted
  enable   Persist the service enabled setting in the selected runtime .settings
  disable  Persist the service disabled setting in the selected runtime .settings
  auth     Run service-specific authorization/setup credentials
  logout   Clear stored service session for re-authentication
  sync     Run one foreground sync for calendar or WhatsApp contacts
  init     Initialize native shared runtime files, Compose bind sources, or WhatsApp control state
  mcp      Start a service MCP server on stdio

Services:
  opencode  Managed opencode serve process (${RUNTIME_SERVICE_DEFINITIONS[0].envName})
  telegram  Telegram long polling connection (${RUNTIME_SERVICE_DEFINITIONS[1].envName})
  calendar  Google Calendar background cache (${RUNTIME_SERVICE_DEFINITIONS[2].envName})
  whatsapp  WAHA-backed operations through the configured control API
  api       DAgent HTTP control API (${RUNTIME_SERVICE_DEFINITIONS[3].envName})

Options:
  -r, --runtime-directory <path>  Select the live/runtime folder; defaults to currentDirectory
  -h, --help                     Show this help

runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}`);
}

function printInitUsage(runtimeDirectory: string): void {
  console.log(`Usage: dagent [--runtime-directory <path>] services init [compose]

Initializes runtime directories, Calendar and WhatsApp DB schemas, and opencode MCP config without starting Telegram, opencode, OAuth, WAHA, or live sync. The compose target creates required narrow bind sources and installs both remote MCP entries.
runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}`);
}

function printTelegramUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] services auth telegram --bot-token <token> --user-id <numeric-id>
  dagent [--runtime-directory <path>] services status telegram

Commands:
  auth    Store Telegram bot credentials locally for later startup
  status  Print non-secret Telegram credential status JSON

Options:
  -r, --runtime-directory <path>  Select the live/runtime folder; defaults to currentDirectory
  --bot-token <token>            Telegram bot token from BotFather
  --user-id <numeric-id>         Owner's numeric Telegram message.from.id
  -h, --help                     Show this help

runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}
Credentials are stored at ${getTelegramCredentialsPath(runtimeDirectory)}.`);
}

function printStartUsage(runtimeDirectory: string): void {
  console.log(`Usage: dagent [--runtime-directory <path>] start

Starts all enabled services detached in the background supervisor.
pidFile: ${getDagentPidPath(runtimeDirectory)}
logFile: ${getDagentLogPath(runtimeDirectory)}`);
}

function printStopUsage(runtimeDirectory: string): void {
  console.log(`Usage: dagent [--runtime-directory <path>] stop

Stops the detached supervisor using the runtime pid file.
pidFile: ${getDagentPidPath(runtimeDirectory)}`);
}

function printGoogleCalendarUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] services auth calendar [-f <credentials.json>]
  dagent [--runtime-directory <path>] services sync calendar [-f <credentials.json>]
  dagent [--runtime-directory <path>] services status calendar [-f <credentials.json>]
  dagent [--runtime-directory <path>] services mcp calendar

Commands:
  auth    Authorize Google Calendar and store an OAuth token
  sync    Run one foreground cache sync
  status  Print cache, credential, token, and sync status JSON
  mcp     Start the stdio MCP server for Calendar tools

Options:
  -r, --runtime-directory <path>             Select the live/runtime folder; defaults to currentDirectory
  -f, --credentials-file <credentials.json>  Load OAuth client credentials from file
  -h, --help                                Show this help

runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}
Relative DB and credentials paths resolve from this directory.`);
}

function printWhatsappUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] services init whatsapp
  dagent [--runtime-directory <path>] services auth whatsapp
  dagent [--runtime-directory <path>] services logout whatsapp
  dagent [--runtime-directory <path>] services sync whatsapp
  dagent [--runtime-directory <path>] services status whatsapp
  dagent [--runtime-directory <path>] services mcp whatsapp

Commands:
  init           Reconcile the WAHA default session and install opencode MCP config
  auth           Poll WAHA authorization and render safe terminal QR art
  logout         Log out the WAHA default session
  sync           Refresh exact cached recipients from WAHA
  status         Print non-secret WAHA, webhook, contact, and schedule status JSON
  mcp            Start the database-only stdio MCP server for WhatsApp tools

Options:
  -r, --runtime-directory <path>  Select the live/runtime folder; defaults to currentDirectory
  -h, --help                     Show this help

runtimeDirectory: ${runtimeDirectory}
currentDirectory: ${process.cwd()}
Default WhatsApp data lives under ${getRuntimeServiceDataDirectory(runtimeDirectory, WHATSAPP_SERVICE_NAME)}.`);
}

function printCompletionUsage(): void {
  console.log("Usage: dagent completion zsh");
}

function printCliApiUsage(runtimeDirectory: string): void {
  console.log(`Usage:
  dagent [--runtime-directory <path>] cli-api config [--url <url>] [--token <token>] [--clear-token]

Commands:
  config  Show or update the runtime-scoped native CLI API connection config

runtimeDirectory: ${runtimeDirectory}`);
}

function printCliApiConfigUsage(runtimeDirectory: string): void {
  console.log(`Usage: dagent [--runtime-directory <path>] cli-api config [--url <url>] [--token <token>] [--clear-token]

Shows the effective cli-api URL and whether a token is configured. Environment variables override this file: DAGENT_CLI_API_URL, DAGENT_CLI_API_TOKEN, then DAGENT_API_TOKEN.
configPath: ${getCliApiConfigPath(runtimeDirectory)}`);
}

const ZSH_COMPLETION_SCRIPT = `#compdef DAgent dagent

_dagent() {
  local -a top_commands services_actions service_names auth_services sync_services init_services mcp_services completion_commands cli_api_commands config_commands
  top_commands=(
    'start:Start all enabled services in the background supervisor'
    'stop:Stop the background supervisor and its services'
    'services:Manage service settings and service-specific operations'
    'cli-api:Configure native CLI API connection settings'
    'config:Configure runtime-independent user defaults'
    'completion:Generate shell completion scripts'
    'help:Show help'
  )
  services_actions=(
    'list:Print all runtime service enablement settings'
    'status:Print service-specific status'
    'enable:Enable a runtime service'
    'disable:Disable a runtime service'
    'auth:Run service-specific authorization'
    'logout:Clear stored service session for re-authentication'
    'sync:Run a foreground service sync'
    'init:Initialize service runtime files'
    'mcp:Start a service MCP server on stdio'
  )
  service_names=(
    'opencode:Managed opencode serve process'
    'telegram:Telegram long polling connection'
    'calendar:Google Calendar background cache'
    'api:DAgent HTTP control API'
  )
  auth_services=('telegram:Store Telegram bot credentials locally' 'calendar:Authorize Google Calendar' 'whatsapp:Authorize the WAHA default session')
  sync_services=('calendar:Run one foreground Calendar sync' 'whatsapp:Refresh cached WhatsApp contacts')
  init_services=('compose:Initialize canonical Compose bind sources and remote MCP config' 'whatsapp:Initialize WhatsApp control state')
  logout_services=('whatsapp:Clear stored WhatsApp session for re-authentication')
  mcp_services=('calendar:Start Calendar MCP server' 'whatsapp:Start WhatsApp MCP server')
  completion_commands=('zsh:Print zsh completion script')
  cli_api_commands=('config:Show or update cli-api connection settings')
  config_commands=('runtime-directory:Show or update the persistent default runtime directory')

  if [[ "\${words[CURRENT-1]}" == "-r" || "\${words[CURRENT-1]}" == "--runtime-directory" ]]; then
    _files -/
    return
  fi

  if (( CURRENT == 2 )); then
    _describe 'command' top_commands
    return
  fi

  case "$words[2]" in
    services)
      if (( CURRENT == 3 )); then
        _describe 'services action' services_actions
        return
      fi
      case "$words[3]" in
        status)
          if (( CURRENT == 4 )); then
            _describe 'service' service_names
            return
          fi
          ;;
        enable|disable)
          if (( CURRENT == 4 )); then
            _describe 'service' service_names
            return
          fi
          ;;
        auth)
          if (( CURRENT == 4 )); then
            _describe 'service' auth_services
            return
          fi
          ;;
        logout)
          if (( CURRENT == 4 )); then
            _describe 'service' logout_services
            return
          fi
          ;;
        sync)
          if (( CURRENT == 4 )); then
            _describe 'service' sync_services
            return
          fi
          ;;
        init)
          if (( CURRENT == 4 )); then
            _describe 'service' init_services
            return
          fi
          ;;
        mcp)
          if (( CURRENT == 4 )); then
            _describe 'service' mcp_services
            return
          fi
          ;;
      esac
      case "$words[3]:$words[4]" in
        auth:calendar|sync:calendar|status:calendar)
          if [[ "\${words[CURRENT-1]}" == "-f" || "\${words[CURRENT-1]}" == "--credentials-file" ]]; then
            _files
            return
          fi
          _arguments \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '-r[Select runtime directory]:runtime directory:_files -/' \\
            '--runtime-directory[Select runtime directory]:runtime directory:_files -/' \\
            '-f[Path to credentials.json]:credentials file:_files' \\
            '--credentials-file[Path to credentials.json]:credentials file:_files'
          ;;
        auth:telegram)
          _arguments \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '-r[Select runtime directory]:runtime directory:_files -/' \\
            '--runtime-directory[Select runtime directory]:runtime directory:_files -/' \\
            '--bot-token[Telegram bot token]:bot token:' \\
            '--user-id[Numeric Telegram user id]:user id:'
          ;;
        *:whatsapp|status:telegram|status:opencode)
          _arguments \\
            '-h[Show help]' \\
            '--help[Show help]' \\
            '-r[Select runtime directory]:runtime directory:_files -/' \\
            '--runtime-directory[Select runtime directory]:runtime directory:_files -/'
          ;;
      esac
      ;;
    completion)
      if (( CURRENT == 3 )); then
        _describe 'shell' completion_commands
      fi
      ;;
    cli-api)
      if (( CURRENT == 3 )); then
        _describe 'cli-api command' cli_api_commands
        return
      fi
      if [[ "$words[3]" == "config" ]]; then
        _arguments \\
          '-h[Show help]' \\
          '--help[Show help]' \\
          '--url[CLI API URL]:url:' \\
          '--token[CLI API bearer token]:token:' \\
          '--clear-token[Remove the stored token]'
      fi
      ;;
    config)
      if (( CURRENT == 3 )); then
        _describe 'config command' config_commands
        return
      fi
      if [[ "$words[3]" == "runtime-directory" ]]; then
        _arguments \\
          '-h[Show help]' \\
          '--help[Show help]' \\
          '--path[Set absolute default runtime directory]:runtime directory:_files -/' \\
          '--clear[Clear the configured default runtime directory]'
      fi
      ;;
  esac
}

_dagent "$@"`;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
