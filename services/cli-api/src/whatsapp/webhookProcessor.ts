import type { WhatsappRepository, WahaWebhookEventType } from "../../../whatsapp/src/whatsapp/repository.js";
import { readMessageId, sanitizeWahaError } from "./wahaClient.js";

export class WahaWebhookProcessor {
  private active?: Promise<void>;
  private running = false;
  private stopping = false;
  private wakeRequested = false;

  constructor(private readonly repository: WhatsappRepository, private readonly maxAttempts = 5) {}

  start(): void {
    this.running = true;
    this.stopping = false;
    this.repository.recoverInterruptedWebhookEvents(this.maxAttempts);
    this.wake();
  }

  wake(): void {
    if (!this.running || this.stopping) return;
    if (this.active) {
      this.wakeRequested = true;
      return;
    }
    this.active = this.drain().finally(() => {
      this.active = undefined;
      if (this.wakeRequested && !this.stopping) {
        this.wakeRequested = false;
        this.wake();
      }
    });
  }

  getHealth(): { running: boolean; processing: boolean; stopping: boolean } {
    return { running: this.running, processing: Boolean(this.active), stopping: this.stopping };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
    this.running = false;
    this.stopping = false;
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const event = this.repository.claimNextWebhookEvent(this.maxAttempts);
      if (!event) return;
      try {
        const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(event.payload)) as Record<string, unknown>;
        const payload = asRecord(envelope.payload) ?? {};
        this.process(event.eventType, event.session, payload, envelope);
        this.repository.markWebhookProcessed(event.eventId);
      } catch (error) {
        this.repository.markWebhookRetry(event.eventId, sanitizeWahaError(error), this.maxAttempts);
      }
    }
  }

  private process(eventType: WahaWebhookEventType, session: string, payload: Record<string, unknown>, envelope: Record<string, unknown>): void {
    const now = Date.now();
    if (eventType === "session.status") {
      const status = readString(payload.status)?.toUpperCase();
      if (!status) throw new Error("session.status payload is missing status");
      const engine = readString(envelope.engine) ?? readString(payload.engine) ?? readString(asRecord(payload.config)?.engine) ?? readString(asRecord(envelope.environment)?.engine);
      this.repository.upsertWahaSession({ session, status, engine: engine?.toUpperCase(), updatedAtMs: toTimestampMs(envelope.timestamp) ?? now });
      return;
    }

    const lifecycleId = eventType === "message.edited" ? readString(payload.editedMessageId) : eventType === "message.revoked" ? readString(payload.revokedMessageId) : undefined;
    const rawMessageId = lifecycleId ?? readMessageId(payload.id) ?? readMessageId(payload.messageId) ?? readMessageId(asRecord(payload.message)?.id);
    const messageId = rawMessageId ? this.repository.resolveWahaMessageId(rawMessageId) : undefined;
    if (!messageId) throw new Error(`${eventType} payload is missing message id`);
    const timestampMs = toTimestampMs(payload.timestamp) ?? now;
    if (eventType === "message.ack") {
      const code = readNumber(payload.ack);
      const name = readString(payload.ackName) ?? readString(payload.ack_name);
      this.repository.acknowledgeWahaMessage(messageId, code, name, timestampMs);
      return;
    }
    if (eventType === "message.revoked") {
      this.repository.upsertWahaMessage({ messageId, hasMedia: false, revokedAtMs: timestampMs });
      return;
    }
    if (eventType === "message.edited") {
      this.repository.upsertWahaMessage({ messageId, body: readString(payload.body) ?? "", bodyUpdatedAtMs: timestampMs, hasMedia: Boolean(payload.hasMedia), editedAtMs: timestampMs });
      return;
    }

    const fromMe = payload.fromMe === true;
    this.repository.upsertWahaMessage({
      messageId,
      direction: fromMe ? "outgoing" : "incoming",
      chatId: readString(fromMe ? payload.to : payload.from) ?? readString(payload.chatId),
      senderId: readString(payload.participant) ?? readString(payload.from),
      timestampMs,
      body: readString(payload.body) ?? "",
      bodyUpdatedAtMs: timestampMs,
      hasMedia: Boolean(payload.hasMedia)
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toTimestampMs(value: unknown): number | undefined {
  const number = readNumber(value);
  if (number === undefined) return undefined;
  return number < 1_000_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}
