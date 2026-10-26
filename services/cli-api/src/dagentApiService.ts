import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readRuntimeServiceStatus, readRuntimeServiceStatuses, persistRuntimeServiceEnabled, type RuntimeServiceName } from "../../../shared/utils/serviceSettings.js";
import { loadGoogleCalendarConfig } from "../../calendar/src/google/config.js";
import { resolveStoredGoogleOAuthCredentials } from "../../calendar/src/google/credentials.js";
import { createGoogleCalendarAuthUrl, exchangeGoogleCalendarAuthCode } from "../../calendar/src/google/oauth.js";
import { GoogleCalendarRepository } from "../../calendar/src/google/repository.js";
import { GoogleCalendarSync } from "../../calendar/src/google/sync.js";
import { safeCalendarErrorMessage } from "../../calendar/src/google/calendarError.js";
import {
  installComposeMcpInRuntimeOpencodeConfig,
  installCalendarMcpInRuntimeOpencodeConfig,
  installWhatsappMcpInRuntimeOpencodeConfig,
  readCalendarMcpInstallOptionsFromEnv,
  readWhatsappMcpInstallOptionsFromEnv
} from "../../agent/src/opencode/runtimeConfig.js";
import type { AppService } from "../../../shared/service/appService.js";
import { getTelegramCredentialStatus, getTelegramCredentialsPath, persistTelegramCredentials } from "../../../shared/utils/telegramCredentials.js";
import type { WhatsappControlService } from "./whatsapp/whatsappControlService.js";
import { parseWahaWebhook, readRawBody, verifyWahaWebhookHmac, WebhookBodyTooLargeError } from "./whatsapp/webhook.js";

export type DagentApiServiceOptions = {
  runtimeDirectory: string;
  hostname: string;
  port: number;
  token?: string;
  agentRuntimeDirectory?: string;
  agentOpencodeConfigPath?: string;
  agentRestartCommand?: string;
  telegramRuntimeDirectory?: string;
  whatsapp?: WhatsappControlService;
  whatsappWebhookSecret?: string;
  loadCalendarCredentialsFile?: boolean;
};

export class DagentApiService implements AppService {
  readonly name = "dagent-api";
  private server?: Server;
  private readonly calendarAuthSessions = new Map<string, CalendarAuthSession>();
  private readonly whatsappAuthCompletions = new Map<string, Promise<WhatsappAuthCompletion>>();

  constructor(private readonly options: DagentApiServiceOptions) {}

  async start(): Promise<void> {
    await this.options.whatsapp?.start();
    this.server = createServer((request, response) => void this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.options.port, this.options.hostname, () => {
          this.server?.off("error", reject);
          console.log(`DAgent API listening on http://${this.options.hostname}:${this.options.port}`);
          resolve();
        });
      });
    } catch (error) {
      await this.options.whatsapp?.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server?.close((error) => (error ? reject(error) : resolve())));
      this.server = undefined;
    }
    await this.options.whatsapp?.stop();
  }

  getListeningPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/calendar/auth/callback") {
        await this.handleCalendarAuthCallback(url, response);
        return;
      }

      if (request.method === "POST" && url.pathname === "/internal/whatsapp/webhook") {
        await this.handleWhatsappWebhook(request, response);
        return;
      }

      if (!this.isAuthorized(request)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/cli") {
        writeJson(response, 400, { error: "The broad CLI proxy is disabled. Use dedicated service, auth, lifecycle, or deployment endpoints." });
        return;
      }
      if (request.method === "POST" && (url.pathname === "/start" || url.pathname === "/stop" || /^\/internal\/(?:start|stop|detached|run-detached-app)$/.test(url.pathname))) {
        writeJson(response, 400, { error: "Remote native supervisor and detached lifecycle operations are not supported. Manage the Compose deployment directly." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/telegram/auth") {
        const runtimeDirectory = this.options.telegramRuntimeDirectory ?? this.options.runtimeDirectory;
        const credentials = persistTelegramCredentials(runtimeDirectory, parseTelegramAuthBody(await readJsonBody(request)));
        writeJson(response, 200, {
          credentialsPath: getTelegramCredentialsPath(runtimeDirectory),
          botTokenPresent: true,
          allowedUserId: credentials.allowedUserId,
          updatedAt: credentials.updatedAt
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/telegram/status") {
        writeJson(response, 200, getTelegramCredentialStatus(this.options.telegramRuntimeDirectory ?? this.options.runtimeDirectory));
        return;
      }
      if (request.method === "POST" && url.pathname === "/deployment/init") {
        const opencodeConfig = installComposeMcpForCliApi(this.options);
        const restart = await restartAgentAfterCalendarMcpInstall({
          installedConfigPath: opencodeConfig.configPath,
          agentRuntimeDirectory: this.options.agentRuntimeDirectory,
          agentOpencodeConfigPath: this.options.agentOpencodeConfigPath,
          agentRestartCommand: this.options.agentRestartCommand
        });
        writeJson(response, 200, { opencodeConfig, restart });
        return;
      }
      if (request.method === "POST" && url.pathname === "/whatsapp/init") {
        const result = await this.getWhatsapp().initialize();
        const opencodeConfig = installWhatsappMcpForCliApi(this.options);
        const restart = await restartAgentAfterCalendarMcpInstall({
          installedConfigPath: opencodeConfig.configPath,
          agentRuntimeDirectory: this.options.agentRuntimeDirectory,
          agentOpencodeConfigPath: this.options.agentOpencodeConfigPath,
          agentRestartCommand: this.options.agentRestartCommand
        });
        writeJson(response, 200, { result, opencodeConfig, restart });
        return;
      }
      if (request.method === "GET" && url.pathname === "/whatsapp/status") {
        writeJson(response, 200, await this.getWhatsapp().getStatus());
        return;
      }
      if (request.method === "POST" && url.pathname === "/whatsapp/logout") {
        writeJson(response, 200, await this.getWhatsapp().logout());
        return;
      }
      if (request.method === "POST" && url.pathname === "/whatsapp/auth/start") {
        const session = await this.getWhatsapp().startAuth();
        writeJson(response, 200, session);
        return;
      }
      const whatsappAuthMatch = url.pathname.match(/^\/whatsapp\/auth\/sessions\/([^/]+)$/);
      if (request.method === "GET" && whatsappAuthMatch) {
        writeJson(response, 200, await this.getWhatsappAuthSession(whatsappAuthMatch[1]));
        return;
      }
      if (request.method === "POST" && url.pathname === "/whatsapp/sync/start") {
        writeJson(response, 200, this.getWhatsapp().startSync());
        return;
      }
      const whatsappSyncMatch = url.pathname.match(/^\/whatsapp\/sync\/sessions\/([^/]+)$/);
      if (request.method === "GET" && whatsappSyncMatch) {
        writeJson(response, 200, this.getWhatsapp().getSync(whatsappSyncMatch[1]));
        return;
      }
      if (request.method === "POST" && url.pathname === "/calendar/auth/start") {
        const body = await readJsonBody(request);
        const session = this.createCalendarAuthSession(request, parseCalendarAuthStartBody(body));
        writeJson(response, 200, { sessionId: session.id, authUrl: session.authUrl, callbackUrl: session.redirectUri, status: session.status });
        return;
      }
      if (request.method === "GET" && url.pathname === "/calendar/status") {
        const { repository, config } = this.openCalendarRepository();
        try {
          writeJson(response, 200, repository.getStatus(resolveStoredGoogleOAuthCredentials(config, repository)));
        } finally {
          repository.close();
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/calendar/sync") {
        const { repository, config } = this.openCalendarRepository();
        try {
          writeJson(response, 200, await new GoogleCalendarSync(resolveStoredGoogleOAuthCredentials(config, repository), repository).runOnce());
        } finally {
          repository.close();
        }
        return;
      }
      const authStatusMatch = url.pathname.match(/^\/calendar\/auth\/sessions\/([^/]+)$/);
      if (request.method === "GET" && authStatusMatch) {
        const session = this.getCalendarAuthSession(authStatusMatch[1]);
        writeJson(response, 200, this.serializeCalendarAuthSession(session));
        return;
      }
      if (request.method === "GET" && url.pathname === "/services") {
        writeJson(response, 200, readRuntimeServiceStatuses(this.options.runtimeDirectory));
        return;
      }

      const match = url.pathname.match(/^\/services\/([^/]+)\/(enable|disable)$/);
      if (request.method === "POST" && match) {
        const serviceName = parseApiServiceName(match[1]);
        const enabled = match[2] === "enable";
        writeJson(response, 200, persistRuntimeServiceEnabled(this.options.runtimeDirectory, serviceName, enabled));
        return;
      }

      const statusMatch = url.pathname.match(/^\/services\/([^/]+)$/);
      if (request.method === "GET" && statusMatch) {
        writeJson(response, 200, readRuntimeServiceStatus(this.options.runtimeDirectory, parseApiServiceName(statusMatch[1])));
        return;
      }

      writeJson(response, 404, { error: "Not found" });
    } catch (error) {
      writeJson(response, 400, { error: safeCalendarErrorMessage(error) });
    }
  }

  private createCalendarAuthSession(request: IncomingMessage, body: CalendarAuthStartBody): CalendarAuthSession {
    const id = randomUUID();
    const origin = getRequestOrigin(request);
    const redirectUri = `${origin}/calendar/auth/callback`;
    const baseConfig = loadGoogleCalendarConfig({ runtimeDirectory: this.options.runtimeDirectory, loadCredentials: this.options.loadCalendarCredentialsFile ?? true });
    const repository = new GoogleCalendarRepository(baseConfig.dbPath);
    repository.initialize();
    try {
      const config = body.credentials ? { ...baseConfig, ...body.credentials } : resolveStoredGoogleOAuthCredentials(baseConfig, repository);
      const authUrl = createGoogleCalendarAuthUrl(config, redirectUri, id);
      const session: CalendarAuthSession = { id, redirectUri, authUrl, status: "pending", createdAt: new Date().toISOString(), credentials: body.credentials };
      this.calendarAuthSessions.set(id, session);
      return session;
    } finally {
      repository.close();
    }
  }

  private openCalendarRepository(): { repository: GoogleCalendarRepository; config: ReturnType<typeof loadGoogleCalendarConfig> } {
    const config = loadGoogleCalendarConfig({ runtimeDirectory: this.options.runtimeDirectory, loadCredentials: this.options.loadCalendarCredentialsFile ?? true });
    const repository = new GoogleCalendarRepository(config.dbPath);
    repository.initialize();
    return { repository, config };
  }

  private async handleCalendarAuthCallback(url: URL, response: ServerResponse): Promise<void> {
    const id = url.searchParams.get("state") ?? "";
    const session = this.calendarAuthSessions.get(id);
    if (!session) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Unknown Calendar auth session.");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      session.status = "failed";
      session.error = error ?? "Missing authorization code";
      response.writeHead(400, { "content-type": "text/plain" }).end("Google Calendar authorization failed.");
      return;
    }

    session.status = "exchanging";
    const config = loadGoogleCalendarConfig({ runtimeDirectory: this.options.runtimeDirectory, loadCredentials: this.options.loadCalendarCredentialsFile ?? true });
    const repository = new GoogleCalendarRepository(config.dbPath);
    repository.initialize();
    try {
      const resolvedConfig = session.credentials ? { ...config, ...session.credentials } : resolveStoredGoogleOAuthCredentials(config, repository);
      await exchangeGoogleCalendarAuthCode(resolvedConfig, repository, code, session.redirectUri);
      const opencodeConfig = installCalendarMcpForCliApi(this.options);
      session.restart = await restartAgentAfterCalendarMcpInstall({
        installedConfigPath: opencodeConfig.configPath,
        agentRuntimeDirectory: this.options.agentRuntimeDirectory,
        agentOpencodeConfigPath: this.options.agentOpencodeConfigPath,
        agentRestartCommand: this.options.agentRestartCommand
      });
      session.status = "complete";
      session.completedAt = new Date().toISOString();
      session.opencodeConfigPath = opencodeConfig.configPath;
      response.writeHead(200, { "content-type": "text/plain" }).end("Google Calendar authorization complete. You can close this tab.");
    } catch (exchangeError) {
      session.status = "failed";
      session.error = safeCalendarErrorMessage(exchangeError);
      response.writeHead(400, { "content-type": "text/plain" }).end("Google Calendar authorization failed. Return to the CLI for details.");
    } finally {
      repository.close();
    }
  }

  private getCalendarAuthSession(id: string): CalendarAuthSession {
    const session = this.calendarAuthSessions.get(id);
    if (!session) throw new Error(`Unknown Calendar auth session: ${id}`);
    return session;
  }

  private serializeCalendarAuthSession(session: CalendarAuthSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      status: session.status,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      opencodeConfigPath: session.opencodeConfigPath,
      restart: session.restart,
      error: session.error
    };
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.options.token) return true;
    return request.headers.authorization === `Bearer ${this.options.token}`;
  }

  private async handleWhatsappWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const whatsapp = this.options.whatsapp;
    const secret = this.options.whatsappWebhookSecret;
    if (!whatsapp || !secret) {
      writeJson(response, 503, { error: "WhatsApp webhook is not configured" });
      return;
    }
    const signature = Array.isArray(request.headers["x-webhook-hmac"]) ? request.headers["x-webhook-hmac"][0] : request.headers["x-webhook-hmac"];
    if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) {
      writeJson(response, 401, { error: "Invalid webhook signature" });
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(request);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) {
        writeJson(response, 413, { error: error.message });
        return;
      }
      throw error;
    }
    if (!verifyWahaWebhookHmac(rawBody, signature, secret)) {
      writeJson(response, 401, { error: "Invalid webhook signature" });
      return;
    }
    let event;
    try {
      event = parseWahaWebhook(rawBody);
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : "Malformed webhook" });
      return;
    }
    const inserted = whatsapp.acceptWebhook({ id: event.id, event: event.event, session: event.session, rawBody });
    writeJson(response, 200, { ok: true, duplicate: !inserted });
    if (inserted) setImmediate(() => whatsapp.processAcceptedWebhooks());
  }

  private getWhatsapp(): WhatsappControlService {
    if (!this.options.whatsapp) throw new Error("WhatsApp control is not configured");
    return this.options.whatsapp;
  }

  private async getWhatsappAuthSession(id: string): Promise<Record<string, unknown>> {
    const session = await this.getWhatsapp().getAuth(id);
    if (session.status !== "complete") return session;
    let completion = this.whatsappAuthCompletions.get(id);
    if (!completion) {
      completion = this.completeWhatsappAuth();
      this.whatsappAuthCompletions.set(id, completion);
    }
    return { ...session, ...(await completion) };
  }

  private async completeWhatsappAuth(): Promise<WhatsappAuthCompletion> {
    const opencodeConfig = installWhatsappMcpForCliApi(this.options);
    const restart = await restartAgentAfterCalendarMcpInstall({
      installedConfigPath: opencodeConfig.configPath,
      agentRuntimeDirectory: this.options.agentRuntimeDirectory,
      agentOpencodeConfigPath: this.options.agentOpencodeConfigPath,
      agentRestartCommand: this.options.agentRestartCommand
    });
    return { opencodeConfigPath: opencodeConfig.configPath, restart };
  }
}

type WhatsappAuthCompletion = { opencodeConfigPath: string; restart: AgentRestartStatus };

type CalendarAuthSession = {
  id: string;
  redirectUri: string;
  authUrl: string;
  status: "pending" | "exchanging" | "complete" | "failed";
  createdAt: string;
  completedAt?: string;
  opencodeConfigPath?: string;
  restart?: AgentRestartStatus;
  error?: string;
  credentials?: GoogleCalendarUploadedCredentials;
};

export type AgentRestartStatus = {
  status: "skipped" | "restarted" | "failed";
  message: string;
};

export function installCalendarMcpForCliApi(options: Pick<DagentApiServiceOptions, "runtimeDirectory" | "agentRuntimeDirectory" | "agentOpencodeConfigPath">): ReturnType<typeof installCalendarMcpInRuntimeOpencodeConfig> {
  const opencodeRuntimeDirectory = options.agentRuntimeDirectory ?? options.runtimeDirectory;
  return installCalendarMcpInRuntimeOpencodeConfig(opencodeRuntimeDirectory, { ...readCalendarMcpInstallOptionsFromEnv(), configPath: options.agentOpencodeConfigPath });
}

export function installWhatsappMcpForCliApi(options: Pick<DagentApiServiceOptions, "runtimeDirectory" | "agentRuntimeDirectory" | "agentOpencodeConfigPath">): ReturnType<typeof installWhatsappMcpInRuntimeOpencodeConfig> {
  const opencodeRuntimeDirectory = options.agentRuntimeDirectory ?? options.runtimeDirectory;
  return installWhatsappMcpInRuntimeOpencodeConfig(opencodeRuntimeDirectory, { ...readWhatsappMcpInstallOptionsFromEnv(), configPath: options.agentOpencodeConfigPath });
}

export function installComposeMcpForCliApi(options: Pick<DagentApiServiceOptions, "runtimeDirectory" | "agentRuntimeDirectory" | "agentOpencodeConfigPath">): ReturnType<typeof installComposeMcpInRuntimeOpencodeConfig> {
  const opencodeRuntimeDirectory = options.agentRuntimeDirectory ?? options.runtimeDirectory;
  return installComposeMcpInRuntimeOpencodeConfig(opencodeRuntimeDirectory, options.agentOpencodeConfigPath);
}

export async function restartAgentAfterCalendarMcpInstall(options: {
  installedConfigPath: string;
  agentRuntimeDirectory?: string;
  agentOpencodeConfigPath?: string;
  agentRestartCommand?: string;
}): Promise<AgentRestartStatus> {
  const command = options.agentRestartCommand?.trim();
  if (!command) {
    return { status: "skipped", message: "Agent restart is not configured." };
  }

  const agentConfigPath = getConfiguredAgentOpencodeConfigPath(options);
  if (!agentConfigPath) {
    return { status: "skipped", message: "Agent opencode config path is not configured, so the installed opencode config cannot be verified as agent-visible." };
  }

  if (resolve(options.installedConfigPath) !== agentConfigPath) {
    return { status: "skipped", message: `Installed opencode config ${options.installedConfigPath} is not the configured agent opencode config ${agentConfigPath}.` };
  }

  try {
    await runRestartCommand(command);
    return { status: "restarted", message: "Agent restart command completed." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: `Agent restart command failed: ${message}` };
  }
}

function getConfiguredAgentOpencodeConfigPath(options: { agentRuntimeDirectory?: string; agentOpencodeConfigPath?: string }): string | undefined {
  const explicitPath = options.agentOpencodeConfigPath?.trim();
  if (explicitPath) return resolve(explicitPath);
  const agentRuntimeDirectory = options.agentRuntimeDirectory?.trim();
  return agentRuntimeDirectory ? resolve(agentRuntimeDirectory, "opencode.json") : undefined;
}

function runRestartCommand(command: string): Promise<void> {
  return new Promise((resolveRestart, reject) => {
    const child = spawn(command, { shell: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRestart();
        return;
      }
      reject(new Error(signal ? `terminated by ${signal}` : `exited with status ${code ?? "unknown"}`));
    });
  });
}

type GoogleCalendarUploadedCredentials = { clientId: string; clientSecret: string };
type CalendarAuthStartBody = { credentials?: GoogleCalendarUploadedCredentials };

function parseTelegramAuthBody(body: unknown): { botToken: string; allowedUserId: string | number } {
  if (!isObject(body)) throw new Error("/telegram/auth body must be a JSON object");
  return { botToken: typeof body.botToken === "string" ? body.botToken : "", allowedUserId: body.userId as string | number };
}

function parseCalendarAuthStartBody(body: unknown): CalendarAuthStartBody {
  if (body === undefined) return {};
  if (!isObject(body)) throw new Error("/calendar/auth/start body must be a JSON object");
  if (!("credentials" in body) || body.credentials === undefined) return {};
  if (!isObject(body.credentials)) throw new Error("/calendar/auth/start credentials must be an object");
  const clientId = typeof body.credentials.clientId === "string" ? body.credentials.clientId.trim() : "";
  const clientSecret = typeof body.credentials.clientSecret === "string" ? body.credentials.clientSecret.trim() : "";
  if (!clientId || !clientSecret) throw new Error("/calendar/auth/start credentials require clientId and clientSecret");
  return { credentials: { clientId, clientSecret } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getRequestOrigin(request: IncomingMessage): string {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const proto = forwardedProto ?? "http";
  const host = normalizeOAuthRedirectHost(forwardedHost ?? request.headers.host ?? `127.0.0.1`);
  return `${proto}://${host}`;
}

export function normalizeOAuthRedirectHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host.startsWith("0.0.0.0:")) return `127.0.0.1${host.slice("0.0.0.0".length)}`;
  return host;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error("Request body too large"));
    });
    request.on("error", reject);
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseApiServiceName(value: string): RuntimeServiceName {
  if (["opencode", "telegram", "calendar", "api"].includes(value)) {
    return value as RuntimeServiceName;
  }
  throw new Error(`Unknown service: ${value}`);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}
