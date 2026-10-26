import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { WhatsappConfig } from "./config.js";

type SqliteDatabase = Database.Database;

export const WHATSAPP_MESSAGE_STATUSES = ["pending", "sending", "sent", "failed", "cancelled"] as const;
export type WhatsappMessageStatus = (typeof WHATSAPP_MESSAGE_STATUSES)[number];

export type WhatsappContactRecord = {
  chatId: string;
  displayName: string;
  name?: string;
  pushName?: string;
  shortName?: string;
  number?: string;
  isUser: boolean;
  isGroup: boolean;
  updatedAtMs: number;
};

export type ScheduledWhatsappMessage = {
  id: number;
  recipientName: string;
  recipientChatId: string;
  message: string;
  scheduledAtMs: number;
  recurrenceIntervalMs?: number;
  recurrenceEndAtMs?: number;
  status: WhatsappMessageStatus;
  attempts: number;
  createdAtMs: number;
  updatedAtMs: number;
  sentAtMs?: number;
  lastError?: string;
  wahaMessageId?: string;
  acknowledgementCode?: number;
  acknowledgementName?: string;
  acknowledgedAtMs?: number;
};

export type ScheduledWhatsappMessageSummary = Omit<ScheduledWhatsappMessage, "message" | "recipientChatId"> & {
  messagePreview: string;
  messageLength: number;
};

export type RecipientCandidate = Pick<WhatsappContactRecord, "displayName" | "isUser" | "isGroup" | "updatedAtMs">;

export type RecipientResolution =
  | { ok: true; contact: WhatsappContactRecord; requestedName: string; canonicalName: string }
  | { ok: false; reason: "empty" | "missing" | "ambiguous"; requestedName: string; candidates: RecipientCandidate[] };

export type WhatsappStatus = {
  runtimeDirectory: string;
  currentDirectory: string;
  dbPath: string;
  workerIntervalSeconds: number;
  contactCount: number;
  lastContactRefreshMs?: number;
  messageCounts: Record<WhatsappMessageStatus, number>;
};

export const WAHA_WEBHOOK_EVENTS = ["message", "message.ack", "message.edited", "message.revoked", "session.status"] as const;
export type WahaWebhookEventType = (typeof WAHA_WEBHOOK_EVENTS)[number];
export type WahaWebhookInboxRecord = {
  eventId: string;
  eventType: WahaWebhookEventType;
  session: string;
  payload: Buffer;
  attempts: number;
};

export type WahaSessionRecord = {
  session: string;
  status: string;
  engine?: string;
  updatedAtMs: number;
};

export type WahaMessageRecord = {
  messageId: string;
  scheduledMessageId?: number;
  direction?: string;
  chatId?: string;
  senderId?: string;
  timestampMs?: number;
  body?: string;
  bodyUpdatedAtMs?: number;
  hasMedia: boolean;
  acknowledgementCode?: number;
  acknowledgementName?: string;
  acknowledgedAtMs?: number;
  editedAtMs?: number;
  revokedAtMs?: number;
};

export class WhatsappRepository {
  readonly dbPath: string;
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_contacts (
        chat_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        name TEXT,
        push_name TEXT,
        short_name TEXT,
        number TEXT,
        is_user INTEGER NOT NULL DEFAULT 0,
        is_group INTEGER NOT NULL DEFAULT 0,
        is_sendable INTEGER NOT NULL DEFAULT 1,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS whatsapp_contacts_display_name_idx
        ON whatsapp_contacts(display_name);

      CREATE TABLE IF NOT EXISTS scheduled_whatsapp_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_name TEXT NOT NULL,
        recipient_chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        scheduled_at_ms INTEGER NOT NULL,
        recurrence_interval_ms INTEGER,
        recurrence_end_at_ms INTEGER,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        last_error TEXT,
        waha_message_id TEXT,
        acknowledgement_code INTEGER,
        acknowledgement_name TEXT,
        acknowledged_at_ms INTEGER,
        FOREIGN KEY(recipient_chat_id) REFERENCES whatsapp_contacts(chat_id)
      );

      CREATE INDEX IF NOT EXISTS scheduled_whatsapp_messages_due_idx
        ON scheduled_whatsapp_messages(status, scheduled_at_ms);

      CREATE TABLE IF NOT EXISTS waha_sessions (
        session TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        engine TEXT,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS waha_messages (
        message_id TEXT PRIMARY KEY,
        scheduled_message_id INTEGER,
        direction TEXT,
        chat_id TEXT,
        sender_id TEXT,
        timestamp_ms INTEGER,
        body TEXT,
        body_updated_at_ms INTEGER,
        has_media INTEGER NOT NULL DEFAULT 0,
        acknowledgement_code INTEGER,
        acknowledgement_name TEXT,
        acknowledged_at_ms INTEGER,
        edited_at_ms INTEGER,
        revoked_at_ms INTEGER,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS waha_webhook_inbox (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        session TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        processing_started_at_ms INTEGER,
        processed_at_ms INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        payload BLOB
      );

      CREATE INDEX IF NOT EXISTS waha_webhook_inbox_status_idx
        ON waha_webhook_inbox(status, received_at_ms);
    `);
    ensureColumn(this.db, "whatsapp_contacts", "is_sendable", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "recurrence_interval_ms", "INTEGER");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "recurrence_end_at_ms", "INTEGER");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "waha_message_id", "TEXT");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "acknowledgement_code", "INTEGER");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "acknowledgement_name", "TEXT");
    ensureColumn(this.db, "scheduled_whatsapp_messages", "acknowledged_at_ms", "INTEGER");
    ensureColumn(this.db, "waha_messages", "body_updated_at_ms", "INTEGER");
    ensureColumn(this.db, "waha_messages", "scheduled_message_id", "INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS scheduled_whatsapp_messages_waha_id_idx ON scheduled_whatsapp_messages(waha_message_id)");
  }

  close(): void {
    this.db.close();
  }

  resetInterruptedSendingMessages(): number {
    const result = this.db
      .prepare("UPDATE scheduled_whatsapp_messages SET status = 'pending', updated_at_ms = ? WHERE status = 'sending'")
      .run(Date.now());
    return result.changes;
  }

  upsertContacts(contacts: WhatsappContactRecord[]): number {
    const upsert = this.db.prepare(`
      INSERT INTO whatsapp_contacts (
        chat_id, display_name, name, push_name, short_name, number, is_user, is_group, is_sendable, updated_at_ms
      ) VALUES (
        @chatId, @displayName, @name, @pushName, @shortName, @number, @isUser, @isGroup, 1, @updatedAtMs
      ) ON CONFLICT(chat_id) DO UPDATE SET
        display_name = excluded.display_name,
        name = excluded.name,
        push_name = excluded.push_name,
        short_name = excluded.short_name,
        number = excluded.number,
        is_user = excluded.is_user,
        is_group = excluded.is_group,
        is_sendable = 1,
        updated_at_ms = excluded.updated_at_ms
    `);
    const transaction = this.db.transaction((records: WhatsappContactRecord[]) => {
      this.db.prepare("UPDATE whatsapp_contacts SET is_sendable = 0").run();
      for (const contact of records) {
        upsert.run({
          chatId: contact.chatId,
          displayName: contact.displayName,
          name: contact.name ?? null,
          pushName: contact.pushName ?? null,
          shortName: contact.shortName ?? null,
          number: contact.number ?? null,
          isUser: contact.isUser ? 1 : 0,
          isGroup: contact.isGroup ? 1 : 0,
          updatedAtMs: contact.updatedAtMs
        });
      }
      this.db
        .prepare(
          `DELETE FROM whatsapp_contacts
           WHERE is_sendable = 0
             AND chat_id NOT IN (SELECT DISTINCT recipient_chat_id FROM scheduled_whatsapp_messages)`
        )
        .run();
    });
    transaction(contacts);
    return contacts.length;
  }

  resolveExactRecipientName(recipientName: string): RecipientResolution {
    const requestedName = recipientName.trim();
    if (!requestedName) {
      return { ok: false, reason: "empty", requestedName, candidates: [] };
    }

    const exactRows = this.db.prepare("SELECT * FROM whatsapp_contacts WHERE is_sendable = 1 AND display_name = ? ORDER BY display_name, chat_id").all(requestedName) as WhatsappContactRow[];
    if (exactRows.length === 1) {
      const contact = toContactRecord(exactRows[0]);
      return { ok: true, contact, requestedName, canonicalName: contact.displayName };
    }
    if (exactRows.length > 1) {
      return { ok: false, reason: "ambiguous", requestedName, candidates: exactRows.map(toCandidate) };
    }

    const insensitiveRows = this.db.prepare("SELECT * FROM whatsapp_contacts WHERE is_sendable = 1 AND lower(display_name) = lower(?) ORDER BY display_name, chat_id").all(requestedName) as WhatsappContactRow[];
    if (insensitiveRows.length === 1) {
      const contact = toContactRecord(insensitiveRows[0]);
      return { ok: true, contact, requestedName, canonicalName: contact.displayName };
    }
    if (insensitiveRows.length > 1) {
      return { ok: false, reason: "ambiguous", requestedName, candidates: insensitiveRows.map(toCandidate) };
    }

    return { ok: false, reason: "missing", requestedName, candidates: this.findRecipients(requestedName, { limit: 10, includeGroups: true }) };
  }

  findRecipients(query: string, options: { limit: number; includeGroups: boolean }): RecipientCandidate[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    const like = `%${escapeLike(trimmed)}%`;
    const prefix = `${escapeLike(trimmed)}%`;
    const groupClause = options.includeGroups ? "" : "AND is_group = 0";
    const rows = this.db
      .prepare(
        `SELECT * FROM whatsapp_contacts
         WHERE display_name LIKE ? ESCAPE '\\' ${groupClause}
           AND is_sendable = 1
         ORDER BY CASE WHEN display_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
           display_name COLLATE NOCASE,
           chat_id
         LIMIT ?`
      )
      .all(like, prefix, options.limit) as WhatsappContactRow[];
    return rows.map(toCandidate);
  }

  scheduleMessage(input: {
    recipientName: string;
    recipientChatId: string;
    message: string;
    scheduledAtMs: number;
    recurrenceIntervalMs?: number;
    recurrenceEndAtMs?: number;
  }): ScheduledWhatsappMessage {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO scheduled_whatsapp_messages (
          recipient_name, recipient_chat_id, message, scheduled_at_ms, recurrence_interval_ms, recurrence_end_at_ms, status, attempts, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      )
      .run(input.recipientName, input.recipientChatId, input.message, input.scheduledAtMs, input.recurrenceIntervalMs ?? null, input.recurrenceEndAtMs ?? null, now, now);
    return this.getScheduledMessage(Number(result.lastInsertRowid)) as ScheduledWhatsappMessage;
  }

  getScheduledMessage(id: number): ScheduledWhatsappMessage | undefined {
    const row = this.db.prepare("SELECT * FROM scheduled_whatsapp_messages WHERE id = ?").get(id) as ScheduledMessageRow | undefined;
    return row ? toScheduledMessage(row) : undefined;
  }

  listDueMessages(nowMs: number, limit: number): ScheduledWhatsappMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_whatsapp_messages
         WHERE status = 'pending' AND scheduled_at_ms <= ?
         ORDER BY scheduled_at_ms ASC, id ASC
         LIMIT ?`
      )
      .all(nowMs, limit) as ScheduledMessageRow[];
    return rows.map(toScheduledMessage);
  }

  listScheduledMessages(options: { status?: WhatsappMessageStatus; limit: number }): ScheduledWhatsappMessageSummary[] {
    const rows = options.status
      ? (this.db
          .prepare("SELECT * FROM scheduled_whatsapp_messages WHERE status = ? ORDER BY scheduled_at_ms DESC, id DESC LIMIT ?")
          .all(options.status, options.limit) as ScheduledMessageRow[])
      : (this.db.prepare("SELECT * FROM scheduled_whatsapp_messages ORDER BY scheduled_at_ms DESC, id DESC LIMIT ?").all(options.limit) as ScheduledMessageRow[]);
    return rows.map((row) => toScheduledMessageSummary(toScheduledMessage(row)));
  }

  markSending(id: number): boolean {
    const result = this.db
      .prepare("UPDATE scheduled_whatsapp_messages SET status = 'sending', updated_at_ms = ? WHERE id = ? AND status = 'pending'")
      .run(Date.now(), id);
    return result.changes === 1;
  }

  markSent(id: number, wahaMessageId?: string): void {
    const now = Date.now();
    const row = this.db.prepare("SELECT * FROM scheduled_whatsapp_messages WHERE id = ?").get(id) as ScheduledMessageRow | undefined;
    const nextScheduledAtMs = row ? getNextRecurringOccurrenceMs(row) : undefined;
    if (nextScheduledAtMs !== undefined) {
      this.db
        .prepare("UPDATE scheduled_whatsapp_messages SET status = 'pending', scheduled_at_ms = ?, sent_at_ms = ?, updated_at_ms = ?, last_error = NULL, waha_message_id = ?, acknowledgement_code = NULL, acknowledgement_name = NULL, acknowledged_at_ms = NULL WHERE id = ?")
        .run(nextScheduledAtMs, now, now, wahaMessageId ?? null, id);
    } else {
      this.db.prepare("UPDATE scheduled_whatsapp_messages SET status = 'sent', sent_at_ms = ?, updated_at_ms = ?, last_error = NULL, waha_message_id = ?, acknowledgement_code = NULL, acknowledgement_name = NULL, acknowledged_at_ms = NULL WHERE id = ?").run(now, now, wahaMessageId ?? null, id);
    }
    if (row && wahaMessageId) {
      this.upsertWahaMessage({
        messageId: wahaMessageId,
        scheduledMessageId: id,
        direction: "outgoing",
        chatId: row.recipient_chat_id,
        timestampMs: now,
        body: row.message,
        bodyUpdatedAtMs: now,
        hasMedia: false
      });
    }
  }

  markFailed(id: number, error: string): void {
    const now = Date.now();
    const row = this.db.prepare("SELECT * FROM scheduled_whatsapp_messages WHERE id = ?").get(id) as ScheduledMessageRow | undefined;
    const nextScheduledAtMs = row ? getNextRecurringOccurrenceMs(row) : undefined;
    if (nextScheduledAtMs !== undefined) {
      this.db
        .prepare("UPDATE scheduled_whatsapp_messages SET status = 'pending', scheduled_at_ms = ?, attempts = attempts + 1, updated_at_ms = ?, last_error = ? WHERE id = ?")
        .run(nextScheduledAtMs, now, error, id);
      return;
    }
    this.db.prepare("UPDATE scheduled_whatsapp_messages SET status = 'failed', attempts = attempts + 1, updated_at_ms = ?, last_error = ? WHERE id = ?").run(now, error, id);
  }

  markCancelled(id: number): ScheduledWhatsappMessageSummary | undefined {
    const now = Date.now();
    const result = this.db
      .prepare("UPDATE scheduled_whatsapp_messages SET status = 'cancelled', updated_at_ms = ? WHERE id = ? AND status IN ('pending', 'failed')")
      .run(now, id);
    if (result.changes !== 1) {
      return undefined;
    }
    const message = this.getScheduledMessage(id);
    return message ? toScheduledMessageSummary(message) : undefined;
  }

  getContactCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM whatsapp_contacts WHERE is_sendable = 1").get() as { count: number }).count;
  }

  upsertWahaSession(record: WahaSessionRecord): void {
    this.db
      .prepare(`INSERT INTO waha_sessions (session, status, engine, updated_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(session) DO UPDATE SET status = excluded.status, engine = COALESCE(excluded.engine, waha_sessions.engine), updated_at_ms = excluded.updated_at_ms
        WHERE excluded.updated_at_ms >= waha_sessions.updated_at_ms`)
      .run(record.session, record.status, record.engine ?? null, record.updatedAtMs);
  }

  getWahaSession(session = "default"): WahaSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM waha_sessions WHERE session = ?").get(session) as WahaSessionRow | undefined;
    return row ? { session: row.session, status: row.status, engine: row.engine ?? undefined, updatedAtMs: row.updated_at_ms } : undefined;
  }

  insertWebhookEvent(input: { eventId: string; eventType: WahaWebhookEventType; session: string; payload: Buffer; receivedAtMs?: number }): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO waha_webhook_inbox (event_id, event_type, session, received_at_ms, status, payload) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(input.eventId, input.eventType, input.session, input.receivedAtMs ?? Date.now(), input.payload);
    return result.changes === 1;
  }

  recoverInterruptedWebhookEvents(maxAttempts: number): number {
    const result = this.db
      .prepare("UPDATE waha_webhook_inbox SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, processing_started_at_ms = NULL WHERE status = 'processing'")
      .run(maxAttempts);
    return result.changes;
  }

  claimNextWebhookEvent(maxAttempts: number): WahaWebhookInboxRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT event_id, event_type, session, payload, attempts FROM waha_webhook_inbox WHERE status = 'pending' AND attempts < ? ORDER BY received_at_ms, rowid LIMIT 1")
        .get(maxAttempts) as WahaWebhookInboxRow | undefined;
      if (!row?.payload || !isWahaWebhookEventType(row.event_type)) return undefined;
      const result = this.db
        .prepare("UPDATE waha_webhook_inbox SET status = 'processing', processing_started_at_ms = ?, attempts = attempts + 1 WHERE event_id = ? AND status = 'pending'")
        .run(Date.now(), row.event_id);
      if (result.changes !== 1) return undefined;
      return { eventId: row.event_id, eventType: row.event_type, session: row.session, payload: row.payload, attempts: row.attempts + 1 };
    })();
  }

  markWebhookProcessed(eventId: string): void {
    this.db.prepare("UPDATE waha_webhook_inbox SET status = 'processed', processed_at_ms = ?, processing_started_at_ms = NULL, last_error = NULL, payload = NULL WHERE event_id = ? AND status = 'processing'").run(Date.now(), eventId);
  }

  markWebhookRetry(eventId: string, error: string, maxAttempts: number): void {
    this.db
      .prepare("UPDATE waha_webhook_inbox SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END, processing_started_at_ms = NULL, last_error = ? WHERE event_id = ? AND status = 'processing'")
      .run(maxAttempts, error, eventId);
  }

  getWebhookEvent(eventId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM waha_webhook_inbox WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
  }

  getWebhookCounts(): Record<string, number> {
    const counts: Record<string, number> = { pending: 0, processing: 0, processed: 0, failed: 0 };
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM waha_webhook_inbox GROUP BY status").all() as Array<{ status: string; count: number }>;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  upsertWahaMessage(record: WahaMessageRecord): void {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO waha_messages (
          message_id, scheduled_message_id, direction, chat_id, sender_id, timestamp_ms, body, body_updated_at_ms, has_media, acknowledgement_code, acknowledgement_name,
          acknowledged_at_ms, edited_at_ms, revoked_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          scheduled_message_id = COALESCE(excluded.scheduled_message_id, waha_messages.scheduled_message_id),
          direction = COALESCE(excluded.direction, waha_messages.direction), chat_id = COALESCE(excluded.chat_id, waha_messages.chat_id),
          sender_id = COALESCE(excluded.sender_id, waha_messages.sender_id), timestamp_ms = COALESCE(excluded.timestamp_ms, waha_messages.timestamp_ms),
          body = CASE
            WHEN excluded.body IS NOT NULL AND (waha_messages.body_updated_at_ms IS NULL OR excluded.body_updated_at_ms >= waha_messages.body_updated_at_ms) THEN excluded.body
            ELSE waha_messages.body
          END,
          body_updated_at_ms = CASE
            WHEN excluded.body IS NOT NULL AND (waha_messages.body_updated_at_ms IS NULL OR excluded.body_updated_at_ms >= waha_messages.body_updated_at_ms) THEN excluded.body_updated_at_ms
            ELSE waha_messages.body_updated_at_ms
          END,
          has_media = MAX(excluded.has_media, waha_messages.has_media),
          acknowledgement_code = CASE
            WHEN excluded.acknowledged_at_ms IS NOT NULL AND (waha_messages.acknowledged_at_ms IS NULL OR excluded.acknowledged_at_ms >= waha_messages.acknowledged_at_ms) THEN excluded.acknowledgement_code
            ELSE waha_messages.acknowledgement_code
          END,
          acknowledgement_name = CASE
            WHEN excluded.acknowledged_at_ms IS NOT NULL AND (waha_messages.acknowledged_at_ms IS NULL OR excluded.acknowledged_at_ms >= waha_messages.acknowledged_at_ms) THEN COALESCE(excluded.acknowledgement_name, waha_messages.acknowledgement_name)
            ELSE waha_messages.acknowledgement_name
          END,
          acknowledged_at_ms = CASE
            WHEN excluded.acknowledged_at_ms IS NOT NULL AND (waha_messages.acknowledged_at_ms IS NULL OR excluded.acknowledged_at_ms >= waha_messages.acknowledged_at_ms) THEN excluded.acknowledged_at_ms
            ELSE waha_messages.acknowledged_at_ms
          END,
          edited_at_ms = CASE
            WHEN excluded.edited_at_ms IS NOT NULL AND (waha_messages.edited_at_ms IS NULL OR excluded.edited_at_ms >= waha_messages.edited_at_ms) THEN excluded.edited_at_ms
            ELSE waha_messages.edited_at_ms
          END,
          revoked_at_ms = CASE
            WHEN excluded.revoked_at_ms IS NOT NULL AND (waha_messages.revoked_at_ms IS NULL OR excluded.revoked_at_ms >= waha_messages.revoked_at_ms) THEN excluded.revoked_at_ms
            ELSE waha_messages.revoked_at_ms
          END, updated_at_ms = excluded.updated_at_ms`)
      .run(
        record.messageId,
        record.scheduledMessageId ?? null,
        record.direction ?? null,
        record.chatId ?? null,
        record.senderId ?? null,
        record.timestampMs ?? null,
        record.body ?? null,
        record.body === undefined ? null : (record.bodyUpdatedAtMs ?? record.timestampMs ?? now),
        record.hasMedia ? 1 : 0,
        record.acknowledgementCode ?? null,
        record.acknowledgementName ?? null,
        record.acknowledgedAtMs ?? null,
        record.editedAtMs ?? null,
        record.revokedAtMs ?? null,
        now
      );
  }

  acknowledgeWahaMessage(messageId: string, code: number | undefined, name: string | undefined, acknowledgedAtMs: number): void {
    this.upsertWahaMessage({ messageId, hasMedia: false, acknowledgementCode: code, acknowledgementName: name, acknowledgedAtMs });
    this.db
      .prepare("UPDATE scheduled_whatsapp_messages SET acknowledgement_code = ?, acknowledgement_name = COALESCE(?, acknowledgement_name), acknowledged_at_ms = ?, updated_at_ms = ? WHERE waha_message_id = ? AND (acknowledged_at_ms IS NULL OR ? >= acknowledged_at_ms)")
      .run(code ?? null, name ?? null, acknowledgedAtMs, Date.now(), messageId, acknowledgedAtMs);
  }

  getWahaMessage(messageId: string): WahaMessageRecord | undefined {
    const row = this.db.prepare("SELECT * FROM waha_messages WHERE message_id = ?").get(messageId) as WahaMessageRow | undefined;
    return row ? toWahaMessage(row) : undefined;
  }

  resolveWahaMessageId(messageId: string): string {
    const exact = this.db.prepare("SELECT message_id FROM waha_messages WHERE message_id = ?").get(messageId) as { message_id: string } | undefined;
    if (exact) return exact.message_id;
    const rows = this.db.prepare("SELECT message_id FROM waha_messages WHERE message_id LIKE ? ESCAPE '\\' ORDER BY message_id LIMIT 2").all(`%\\_${escapeLike(messageId)}`) as Array<{ message_id: string }>;
    return rows.length === 1 ? rows[0].message_id : messageId;
  }

  getStatus(config: WhatsappConfig): WhatsappStatus {
    const contactCount = this.getContactCount();
    const lastContactRefresh = this.db.prepare("SELECT MAX(updated_at_ms) AS value FROM whatsapp_contacts WHERE is_sendable = 1").get() as { value: number | null };
    return {
      runtimeDirectory: config.runtimeDirectory,
      currentDirectory: process.cwd(),
      dbPath: this.dbPath,
      workerIntervalSeconds: config.workerIntervalSeconds,
      contactCount,
      lastContactRefreshMs: lastContactRefresh.value ?? undefined,
      messageCounts: this.getMessageCounts()
    };
  }

  private getMessageCounts(): Record<WhatsappMessageStatus, number> {
    const counts = Object.fromEntries(WHATSAPP_MESSAGE_STATUSES.map((status) => [status, 0])) as Record<WhatsappMessageStatus, number>;
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM scheduled_whatsapp_messages GROUP BY status").all() as Array<{ status: string; count: number }>;
    for (const row of rows) {
      if (isWhatsappMessageStatus(row.status)) {
        counts[row.status] = row.count;
      }
    }
    return counts;
  }
}

export function isWhatsappMessageStatus(value: string): value is WhatsappMessageStatus {
  return WHATSAPP_MESSAGE_STATUSES.includes(value as WhatsappMessageStatus);
}

export function toScheduledMessageSummary(message: ScheduledWhatsappMessage): ScheduledWhatsappMessageSummary {
  return {
    id: message.id,
    recipientName: message.recipientName,
    scheduledAtMs: message.scheduledAtMs,
    recurrenceIntervalMs: message.recurrenceIntervalMs,
    recurrenceEndAtMs: message.recurrenceEndAtMs,
    status: message.status,
    attempts: message.attempts,
    createdAtMs: message.createdAtMs,
    updatedAtMs: message.updatedAtMs,
    sentAtMs: message.sentAtMs,
    lastError: message.lastError,
    wahaMessageId: message.wahaMessageId,
    acknowledgementCode: message.acknowledgementCode,
    acknowledgementName: message.acknowledgementName,
    acknowledgedAtMs: message.acknowledgedAtMs,
    messagePreview: previewMessage(message.message),
    messageLength: message.message.length
  };
}

function previewMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function ensureColumn(db: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function getNextRecurringOccurrenceMs(row: ScheduledMessageRow): number | undefined {
  if (row.recurrence_interval_ms === null || row.recurrence_end_at_ms === null || row.recurrence_interval_ms <= 0) {
    return undefined;
  }
  const nextScheduledAtMs = row.scheduled_at_ms + row.recurrence_interval_ms;
  return nextScheduledAtMs <= row.recurrence_end_at_ms ? nextScheduledAtMs : undefined;
}

function toContactRecord(row: WhatsappContactRow): WhatsappContactRecord {
  return {
    chatId: row.chat_id,
    displayName: row.display_name,
    name: row.name ?? undefined,
    pushName: row.push_name ?? undefined,
    shortName: row.short_name ?? undefined,
    number: row.number ?? undefined,
    isUser: Boolean(row.is_user),
    isGroup: Boolean(row.is_group),
    updatedAtMs: row.updated_at_ms
  };
}

function toCandidate(row: WhatsappContactRow): RecipientCandidate {
  const contact = toContactRecord(row);
  return { displayName: contact.displayName, isUser: contact.isUser, isGroup: contact.isGroup, updatedAtMs: contact.updatedAtMs };
}

function toScheduledMessage(row: ScheduledMessageRow): ScheduledWhatsappMessage {
  return {
    id: row.id,
    recipientName: row.recipient_name,
    recipientChatId: row.recipient_chat_id,
    message: row.message,
    scheduledAtMs: row.scheduled_at_ms,
    recurrenceIntervalMs: row.recurrence_interval_ms ?? undefined,
    recurrenceEndAtMs: row.recurrence_end_at_ms ?? undefined,
    status: isWhatsappMessageStatus(row.status) ? row.status : "failed",
    attempts: row.attempts,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    sentAtMs: row.sent_at_ms ?? undefined,
    lastError: row.last_error ?? undefined,
    wahaMessageId: row.waha_message_id ?? undefined,
    acknowledgementCode: row.acknowledgement_code ?? undefined,
    acknowledgementName: row.acknowledgement_name ?? undefined,
    acknowledgedAtMs: row.acknowledged_at_ms ?? undefined
  };
}

export function isWahaWebhookEventType(value: string): value is WahaWebhookEventType {
  return WAHA_WEBHOOK_EVENTS.includes(value as WahaWebhookEventType);
}

function toWahaMessage(row: WahaMessageRow): WahaMessageRecord {
  return {
    messageId: row.message_id,
    scheduledMessageId: row.scheduled_message_id ?? undefined,
    direction: row.direction ?? undefined,
    chatId: row.chat_id ?? undefined,
    senderId: row.sender_id ?? undefined,
    timestampMs: row.timestamp_ms ?? undefined,
    body: row.body ?? undefined,
    bodyUpdatedAtMs: row.body_updated_at_ms ?? undefined,
    hasMedia: Boolean(row.has_media),
    acknowledgementCode: row.acknowledgement_code ?? undefined,
    acknowledgementName: row.acknowledgement_name ?? undefined,
    acknowledgedAtMs: row.acknowledged_at_ms ?? undefined,
    editedAtMs: row.edited_at_ms ?? undefined,
    revokedAtMs: row.revoked_at_ms ?? undefined
  };
}

type WhatsappContactRow = {
  chat_id: string;
  display_name: string;
  name: string | null;
  push_name: string | null;
  short_name: string | null;
  number: string | null;
  is_user: number;
  is_group: number;
  updated_at_ms: number;
};

type ScheduledMessageRow = {
  id: number;
  recipient_name: string;
  recipient_chat_id: string;
  message: string;
  scheduled_at_ms: number;
  recurrence_interval_ms: number | null;
  recurrence_end_at_ms: number | null;
  status: string;
  attempts: number;
  created_at_ms: number;
  updated_at_ms: number;
  sent_at_ms: number | null;
  last_error: string | null;
  waha_message_id: string | null;
  acknowledgement_code: number | null;
  acknowledgement_name: string | null;
  acknowledged_at_ms: number | null;
};

type WahaWebhookInboxRow = {
  event_id: string;
  event_type: string;
  session: string;
  payload: Buffer | null;
  attempts: number;
};

type WahaSessionRow = { session: string; status: string; engine: string | null; updated_at_ms: number };

type WahaMessageRow = {
  message_id: string;
  scheduled_message_id: number | null;
  direction: string | null;
  chat_id: string | null;
  sender_id: string | null;
  timestamp_ms: number | null;
  body: string | null;
  body_updated_at_ms: number | null;
  has_media: number;
  acknowledgement_code: number | null;
  acknowledgement_name: string | null;
  acknowledged_at_ms: number | null;
  edited_at_ms: number | null;
  revoked_at_ms: number | null;
};
