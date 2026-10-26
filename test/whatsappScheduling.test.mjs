import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { whatsappMcpServerTestHooks } from "../dist/services/whatsapp/src/mcp/whatsappMcpServer.js";
import { WhatsappRepository } from "../dist/services/whatsapp/src/whatsapp/repository.js";

const { parseWhatsappRecurrence } = whatsappMcpServerTestHooks;

test("WhatsApp recurrence validation accepts complete recurrence and rejects invalid combinations", () => {
  const sendAtMs = Date.parse("2026-01-01T00:00:00Z");

  assert.deepEqual(parseWhatsappRecurrence({ sendAtMs }), { ok: true });
  assert.deepEqual(parseWhatsappRecurrence({ sendAtMs, recurrenceEvery: 2 }), {
    ok: false,
    error: "recurrenceEvery, recurrenceUnit, and recurrenceEndAt must be provided together"
  });
  assert.deepEqual(parseWhatsappRecurrence({ sendAtMs, recurrenceEvery: 0, recurrenceUnit: "minutes", recurrenceEndAt: "2026-01-01T00:00:00Z" }), {
    ok: false,
    error: "recurrenceEvery must be a positive integer"
  });
  assert.deepEqual(parseWhatsappRecurrence({ sendAtMs, recurrenceEvery: 1, recurrenceUnit: "days", recurrenceEndAt: "2025-12-31T23:59:59Z" }), {
    ok: false,
    error: "recurrenceEndAt must be at or after sendAt"
  });
  assert.deepEqual(parseWhatsappRecurrence({ sendAtMs, recurrenceEvery: 2, recurrenceUnit: "hours", recurrenceEndAt: "2026-01-02T00:00:00Z" }), {
    ok: true,
    recurrence: { intervalMs: 2 * 60 * 60 * 1000, endAtMs: Date.parse("2026-01-02T00:00:00Z") }
  });
});

test("WhatsApp scheduled message summaries include recurrence information", () => {
  withRepository((repository) => {
    const scheduledAtMs = Date.parse("2026-01-01T00:00:00Z");
    const recurrenceIntervalMs = 24 * 60 * 60 * 1000;
    const recurrenceEndAtMs = Date.parse("2026-01-03T00:00:00Z");

    const scheduled = scheduleMessage(repository, { scheduledAtMs, recurrenceIntervalMs, recurrenceEndAtMs });
    assert.equal(scheduled.recurrenceIntervalMs, recurrenceIntervalMs);
    assert.equal(scheduled.recurrenceEndAtMs, recurrenceEndAtMs);

    const summaries = repository.listScheduledMessages({ limit: 10 });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, scheduled.id);
    assert.equal(summaries[0].scheduledAtMs, scheduledAtMs);
    assert.equal(summaries[0].recurrenceIntervalMs, recurrenceIntervalMs);
    assert.equal(summaries[0].recurrenceEndAtMs, recurrenceEndAtMs);
    assert.equal(summaries[0].messagePreview, "Hello from recurrence test");
  });
});

test("WhatsApp recurring markSent advances until the inclusive end then marks sent", () => {
  withRepository((repository) => {
    const scheduledAtMs = Date.parse("2026-01-01T00:00:00Z");
    const recurrenceIntervalMs = 60 * 1000;
    const recurrenceEndAtMs = scheduledAtMs + recurrenceIntervalMs;
    const scheduled = scheduleMessage(repository, { scheduledAtMs, recurrenceIntervalMs, recurrenceEndAtMs });

    assert.equal(repository.markSending(scheduled.id), true);
    repository.markSent(scheduled.id);

    const advanced = repository.getScheduledMessage(scheduled.id);
    assert.equal(advanced.status, "pending");
    assert.equal(advanced.scheduledAtMs, scheduledAtMs + recurrenceIntervalMs);
    assert.equal(advanced.lastError, undefined);

    assert.equal(repository.markSending(scheduled.id), true);
    repository.markSent(scheduled.id);

    const final = repository.getScheduledMessage(scheduled.id);
    assert.equal(final.status, "sent");
    assert.equal(final.scheduledAtMs, scheduledAtMs + recurrenceIntervalMs);
  });
});

test("WhatsApp recurring markFailed preserves future occurrences then fails final occurrence", () => {
  withRepository((repository) => {
    const scheduledAtMs = Date.parse("2026-01-01T00:00:00Z");
    const recurrenceIntervalMs = 60 * 1000;
    const recurrenceEndAtMs = scheduledAtMs + recurrenceIntervalMs;
    const scheduled = scheduleMessage(repository, { scheduledAtMs, recurrenceIntervalMs, recurrenceEndAtMs });

    assert.equal(repository.markSending(scheduled.id), true);
    repository.markFailed(scheduled.id, "sanitized failure");

    const advanced = repository.getScheduledMessage(scheduled.id);
    assert.equal(advanced.status, "pending");
    assert.equal(advanced.scheduledAtMs, scheduledAtMs + recurrenceIntervalMs);
    assert.equal(advanced.attempts, 1);
    assert.equal(advanced.lastError, "sanitized failure");

    assert.equal(repository.markSending(scheduled.id), true);
    repository.markFailed(scheduled.id, "final sanitized failure");

    const final = repository.getScheduledMessage(scheduled.id);
    assert.equal(final.status, "failed");
    assert.equal(final.attempts, 2);
    assert.equal(final.lastError, "final sanitized failure");
  });
});

test("WhatsApp repository recovers interrupted sending rows as pending", () => {
  withRepository((repository) => {
    const dueAtMs = Date.parse("2026-01-01T00:00:00Z");
    const scheduled = scheduleMessage(repository, { scheduledAtMs: dueAtMs });

    assert.equal(repository.markSending(scheduled.id), true);
    assert.deepEqual(repository.listDueMessages(dueAtMs, 10), []);

    assert.equal(repository.resetInterruptedSendingMessages(), 1);

    const recovered = repository.getScheduledMessage(scheduled.id);
    assert.equal(recovered.status, "pending");
    assert.equal(repository.listDueMessages(dueAtMs, 10).length, 1);
  });
});

function withRepository(callback) {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "whatsapp-scheduling-"));
  const repository = new WhatsappRepository(join(runtimeDirectory, "whatsapp.sqlite"));
  repository.initialize();
  repository.upsertContacts([
    {
      chatId: "15551234567@c.us",
      displayName: "Alice Example",
      name: "Alice Example",
      isUser: true,
      isGroup: false,
      updatedAtMs: Date.now()
    }
  ]);

  try {
    callback(repository);
  } finally {
    repository.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}

function scheduleMessage(repository, overrides) {
  return repository.scheduleMessage({
    recipientName: "Alice Example",
    recipientChatId: "15551234567@c.us",
    message: "Hello from recurrence test",
    scheduledAtMs: Date.parse("2026-01-01T00:00:00Z"),
    ...overrides
  });
}
