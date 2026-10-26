import { randomUUID } from "node:crypto";

import qrcodeTerminal from "qrcode-terminal";

import type { WhatsappConfig } from "../../../whatsapp/src/whatsapp/config.js";
import { WhatsappRepository, type WhatsappContactRecord, type WahaWebhookEventType } from "../../../whatsapp/src/whatsapp/repository.js";
import { WAHA_DEFAULT_SESSION, WAHA_REQUIRED_ENGINE, WahaClient, type WahaSession, readMessageId, sanitizeWahaError } from "./wahaClient.js";
import { WahaWebhookProcessor } from "./webhookProcessor.js";

type Operation = { id: string; status: "pending" | "complete" | "failed"; error?: string; result?: unknown };
type AuthOperation = Operation & { qrArt?: string };

const ACTIVE_SESSION_STATUSES = new Set(["STARTING", "SCAN_QR_CODE", "WORKING"]);
const DUE_BATCH_LIMIT = 25;

export class WhatsappControlService {
  private readonly processor: WahaWebhookProcessor;
  private readonly authOperations = new Map<string, AuthOperation>();
  private readonly syncOperations = new Map<string, Operation>();
  private sendInterval?: NodeJS.Timeout;
  private activeSend?: Promise<void>;
  private stopping = false;

  constructor(
    readonly config: WhatsappConfig,
    readonly client: WahaClient,
    readonly repository = new WhatsappRepository(config.dbPath)
  ) {
    this.processor = new WahaWebhookProcessor(repository);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.repository.initialize();
    this.repository.resetInterruptedSendingMessages();
    await this.reconcileWithRetry();
    this.processor.start();
    this.sendInterval = setInterval(() => this.queueDueMessages(), this.config.workerIntervalSeconds * 1000);
    this.queueDueMessages();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sendInterval) clearInterval(this.sendInterval);
    this.sendInterval = undefined;
    await this.activeSend;
    await this.processor.stop();
    this.repository.close();
  }

  async initialize(): Promise<Record<string, unknown>> {
    const session = await this.reconcileDefaultSession();
    return { ok: true, session: serializeSession(session), dbPath: this.repository.dbPath };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const sessions = await this.client.listSessions();
    const unexpectedActiveSessions = sessions.filter((session) => session.name !== WAHA_DEFAULT_SESSION && ACTIVE_SESSION_STATUSES.has(session.status)).map((session) => session.name);
    const current = sessions.find((session) => session.name === WAHA_DEFAULT_SESSION);
    if (current) this.persistSession(current);
    return {
      ...this.repository.getStatus(this.config),
      session: current ? serializeSession(current) : null,
      healthy: Boolean(current?.status === "WORKING" && current.engine === WAHA_REQUIRED_ENGINE && unexpectedActiveSessions.length === 0),
      unexpectedActiveSessions,
      webhookProcessor: this.processor.getHealth(),
      webhookInbox: this.repository.getWebhookCounts()
    };
  }

  async logout(): Promise<Record<string, unknown>> {
    await this.client.logoutDefaultSession();
    this.repository.upsertWahaSession({ session: WAHA_DEFAULT_SESSION, status: "STOPPED", engine: WAHA_REQUIRED_ENGINE, updatedAtMs: Date.now() });
    return { ok: true, session: WAHA_DEFAULT_SESSION, status: "STOPPED" };
  }

  async startAuth(): Promise<AuthOperation> {
    const operation: AuthOperation = { id: randomUUID(), status: "pending" };
    this.authOperations.set(operation.id, operation);
    try {
      const session = await this.reconcileDefaultSession();
      if (session.status === "WORKING") operation.status = "complete";
      else if (session.status === "FAILED") {
        operation.status = "failed";
        operation.error = "WAHA default session failed";
      }
    } catch (error) {
      operation.status = "failed";
      operation.error = sanitizeWahaError(error);
    }
    return { ...operation };
  }

  async getAuth(id: string): Promise<AuthOperation> {
    const operation = this.authOperations.get(id);
    if (!operation) throw new Error(`Unknown WhatsApp auth session: ${id}`);
    if (operation.status !== "pending") return { ...operation };
    try {
      const session = await this.client.getSession();
      if (!session) throw new Error("WAHA default session does not exist");
      this.assertGows(session);
      this.persistSession(session);
      if (session.status === "WORKING") {
        operation.status = "complete";
        delete operation.qrArt;
      } else if (session.status === "FAILED") {
        operation.status = "failed";
        operation.error = "WAHA default session failed";
      } else if (session.status === "SCAN_QR_CODE") {
        operation.qrArt = renderWhatsappQr(await this.client.getQrPayload());
      }
    } catch (error) {
      operation.status = "failed";
      operation.error = sanitizeWahaError(error);
    }
    return { ...operation };
  }

  startSync(): Operation {
    const operation: Operation = { id: randomUUID(), status: "pending" };
    this.syncOperations.set(operation.id, operation);
    void this.syncContacts().then(
      (result) => {
        operation.status = "complete";
        operation.result = result;
      },
      (error) => {
        operation.status = "failed";
        operation.error = sanitizeWahaError(error);
      }
    );
    return { ...operation };
  }

  getSync(id: string): Operation {
    const operation = this.syncOperations.get(id);
    if (!operation) throw new Error(`Unknown WhatsApp sync session: ${id}`);
    return { ...operation };
  }

  async syncContacts(): Promise<Record<string, number>> {
    const session = await this.requireWorkingSession();
    this.persistSession(session);
    const [contacts, chats] = await Promise.all([this.client.getContacts(), this.client.getChats()]);
    const normalized = normalizeWahaContacts(contacts, chats);
    const upserted = this.repository.upsertContacts(normalized);
    return { upserted, cachedContactCount: this.repository.getContactCount() };
  }

  acceptWebhook(input: { id: string; event: WahaWebhookEventType; session: string; rawBody: Buffer }): boolean {
    return this.repository.insertWebhookEvent({ eventId: input.id, eventType: input.event, session: input.session, payload: input.rawBody });
  }

  processAcceptedWebhooks(): void {
    this.processor.wake();
  }

  async runDueMessages(nowMs = Date.now()): Promise<void> {
    if (this.stopping) return;
    const session = await this.client.getSession();
    if (!session) return;
    this.assertGows(session);
    this.persistSession(session);
    if (session.status !== "WORKING") return;
    for (const message of this.repository.listDueMessages(nowMs, DUE_BATCH_LIMIT)) {
      if (!this.repository.markSending(message.id)) continue;
      try {
        const wahaMessageId = await this.client.sendText(message.recipientChatId, message.message);
        this.repository.markSent(message.id, wahaMessageId);
        console.error(`WhatsApp message sent: id=${message.id} scheduledAtMs=${message.scheduledAtMs} processedAtMs=${Date.now()}`);
      } catch (error) {
        this.repository.markFailed(message.id, sanitizeWahaError(error));
        console.error(`WhatsApp message failed: id=${message.id} scheduledAtMs=${message.scheduledAtMs} processedAtMs=${Date.now()}`);
      }
    }
  }

  async reconcileDefaultSession(deadlineMs?: number): Promise<WahaSession> {
    const sessions = await this.client.listSessions(deadlineMs);
    let session = sessions.find((candidate) => candidate.name === WAHA_DEFAULT_SESSION) ?? (await this.client.getSession(WAHA_DEFAULT_SESSION, deadlineMs));
    if (!session) session = await this.client.createDefaultSession(deadlineMs);
    this.assertGows(session);
    if (session.status === "STOPPED") session = await this.client.startDefaultSession(deadlineMs);
    this.assertGows(session);
    this.persistSession(session);
    return session;
  }

  private queueDueMessages(): void {
    if (this.activeSend || this.stopping) return;
    this.activeSend = this.runDueMessages().finally(() => {
      this.activeSend = undefined;
    });
  }

  private async reconcileWithRetry(): Promise<void> {
    let lastError: unknown;
    const deadline = Date.now() + this.config.startupReconcileTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await withDeadline(this.reconcileDefaultSession(deadline), deadline);
        return;
      } catch (error) {
        lastError = error;
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(this.config.startupRetryIntervalMs, remaining)));
      }
    }
    throw new Error(`WAHA startup reconciliation failed within ${this.config.startupReconcileTimeoutMs}ms: ${sanitizeWahaError(lastError)}`);
  }

  private async requireWorkingSession(): Promise<WahaSession> {
    const session = await this.client.getSession();
    if (!session || session.status !== "WORKING") throw new Error("WAHA default session is not WORKING");
    this.assertGows(session);
    return session;
  }

  private assertGows(session: WahaSession): void {
    if (session.engine !== WAHA_REQUIRED_ENGINE) throw new Error(`WAHA default session must use ${WAHA_REQUIRED_ENGINE}`);
  }

  private persistSession(session: WahaSession): void {
    this.repository.upsertWahaSession({ session: session.name, status: session.status, engine: session.engine, updatedAtMs: Date.now() });
  }
}

async function withDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new Error("WAHA startup reconciliation deadline expired");
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("WAHA startup reconciliation deadline expired")), remaining);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function renderWhatsappQr(payload: string): string {
  let output = "";
  qrcodeTerminal.generate(payload, { small: true }, (value) => {
    output = value.endsWith("\n") ? value : `${value}\n`;
  });
  if (!output) throw new Error("qrcode-terminal did not render QR art");
  return output;
}

export function normalizeWahaContacts(contacts: readonly unknown[], chats: readonly unknown[]): WhatsappContactRecord[] {
  const now = Date.now();
  const byId = new Map<string, WhatsappContactRecord>();
  for (const value of chats) {
    const record = asRecord(value);
    if (!record) continue;
    const chatId = readMessageId(record.id) ?? readString(record.id) ?? readString(record.chatId);
    if (!chatId || (!chatId.endsWith("@c.us") && !chatId.endsWith("@g.us"))) continue;
    const displayName = readString(record.name) ?? readString(record.pushName) ?? readString(record.pushname) ?? readString(record.shortName) ?? readString(record.number);
    if (!displayName) continue;
    byId.set(chatId, {
      chatId,
      displayName,
      name: readString(record.name),
      pushName: readString(record.pushName) ?? readString(record.pushname),
      shortName: readString(record.shortName),
      number: readString(record.number),
      isUser: chatId.endsWith("@c.us"),
      isGroup: chatId.endsWith("@g.us"),
      updatedAtMs: now
    });
  }

  for (const value of contacts) {
    const record = asRecord(value);
    if (!record) continue;
    const chatId = readMessageId(record.id) ?? readString(record.id) ?? readString(record.chatId);
    if (!chatId) continue;
    const existing = byId.get(chatId);
    if (!existing) continue;
    const name = readString(record.name) ?? existing.name;
    const pushName = readString(record.pushName) ?? readString(record.pushname) ?? existing.pushName;
    const shortName = readString(record.shortName) ?? existing.shortName;
    const number = readString(record.number) ?? existing.number;
    byId.set(chatId, {
      ...existing,
      displayName: name ?? existing.displayName ?? pushName ?? shortName ?? number,
      name,
      pushName,
      shortName,
      number
    });
  }
  return [...byId.values()];
}

function serializeSession(session: WahaSession): Record<string, string | undefined> {
  return { name: session.name, status: session.status, engine: session.engine };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
