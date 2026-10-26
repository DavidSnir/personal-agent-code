import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WhatsappControlService, normalizeWahaContacts } from "../dist/services/cli-api/src/whatsapp/whatsappControlService.js";
import { WhatsappRepository } from "../dist/services/whatsapp/src/whatsapp/repository.js";

test("default session reconciliation is idempotent, starts stopped sessions, enforces GOWS, and reports unexpected active sessions unhealthy", async () => {
  await withControl(async ({ control, client }) => {
    client.sessions = [];
    const created = await control.reconcileDefaultSession();
    assert.equal(created.name, "default");
    assert.equal(client.created, 1);

    client.sessions = [{ name: "default", status: "STOPPED", engine: "GOWS" }];
    assert.equal((await control.reconcileDefaultSession()).status, "WORKING");
    assert.equal(client.started, 1);

    client.sessions = [{ name: "default", status: "WORKING", engine: "WEBJS" }];
    await assert.rejects(() => control.reconcileDefaultSession(), /must use GOWS/);

    client.sessions = [{ name: "default", status: "WORKING" }];
    await assert.rejects(() => control.reconcileDefaultSession(), /must use GOWS/);

    client.sessions = [
      { name: "default", status: "WORKING", engine: "GOWS" },
      { name: "other", status: "WORKING", engine: "GOWS" }
    ];
    await control.reconcileDefaultSession();
    const status = await control.getStatus();
    assert.equal(status.healthy, false);
    assert.deepEqual(status.unexpectedActiveSessions, ["other"]);
  });
});

test("WAHA auth QR polling, WORKING completion, status, logout, and contact sync are control API operations", async () => {
  await withControl(async ({ control, client, repository }) => {
    client.sessions = [{ name: "default", status: "SCAN_QR_CODE", engine: "GOWS" }];
    const auth = await control.startAuth();
    const pending = await control.getAuth(auth.id);
    assert.equal(pending.status, "pending");
    assert.match(pending.qrArt, /\S/);
    assert.equal(pending.qrArt.includes(client.qr), false);

    client.sessions = [{ name: "default", status: "STARTING", engine: "GOWS" }];
    assert.equal((await control.getAuth(auth.id)).status, "pending");

    client.sessions = [{ name: "default", status: "WORKING", engine: "GOWS" }];
    assert.equal((await control.getAuth(auth.id)).status, "complete");
    const contacts = await control.syncContacts();
    assert.deepEqual(contacts, { upserted: 2, cachedContactCount: 2 });
    assert.equal(repository.resolveExactRecipientName("Alice").ok, true);
    assert.equal(repository.resolveExactRecipientName("Group Chat").ok, true);

    const status = await control.getStatus();
    assert.equal(status.session.status, "WORKING");
    assert.equal(status.session.engine, "GOWS");
    assert.equal(status.healthy, true);
    assert.equal(status.webhookProcessor.running, false);
    assert.equal((await control.logout()).status, "STOPPED");
    assert.equal(client.loggedOut, 1);
  });
});

test("contact normalization preserves exact WAHA user and group recipient IDs", () => {
  assert.deepEqual(
    normalizeWahaContacts(
      [{ id: "15551234567@c.us", name: "Alice", pushName: "Ignored" }, { id: "19999999999@c.us", name: "Contact Only" }],
      [{ id: "120363000@g.us", name: "Group Chat" }, { id: "15551234567@c.us", name: "Alice Chat" }]
    ).map(({ chatId, displayName, isUser, isGroup }) => ({ chatId, displayName, isUser, isGroup })),
    [
      { chatId: "120363000@g.us", displayName: "Group Chat", isUser: false, isGroup: true },
      { chatId: "15551234567@c.us", displayName: "Alice", isUser: true, isGroup: false }
    ]
  );
});

test("scheduled sends require WORKING, claim atomically, preserve recurrence, store WAHA ID, and correlate acknowledgement", async () => {
  await withControl(async ({ control, client, repository }) => {
    const due = Date.now() - 1000;
    const message = repository.scheduleMessage({
      recipientName: "Alice",
      recipientChatId: "15551234567@c.us",
      message: "private",
      scheduledAtMs: due,
      recurrenceIntervalMs: 60_000,
      recurrenceEndAtMs: due + 60_000
    });
    client.sessions = [{ name: "default", status: "STOPPED", engine: "GOWS" }];
    await control.runDueMessages();
    assert.equal(repository.getScheduledMessage(message.id).status, "pending");

    client.sessions = [{ name: "default", status: "WORKING", engine: "GOWS" }];
    await Promise.all([control.runDueMessages(), control.runDueMessages()]);
    const sent = repository.getScheduledMessage(message.id);
    assert.equal(client.sent.length, 1);
    assert.equal(sent.status, "pending");
    assert.equal(sent.wahaMessageId, "waha-1");
    assert.equal(repository.getWahaMessage("waha-1").scheduledMessageId, message.id);
    repository.acknowledgeWahaMessage("waha-1", 3, "READ", Date.now());
    assert.equal(repository.getScheduledMessage(message.id).acknowledgementName, "READ");
  });
});

test("startup reconciliation has a finite overall deadline when WAHA hangs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "waha-control-deadline-"));
  const repository = new WhatsappRepository(join(directory, "whatsapp.sqlite"));
  const client = new FakeWahaClient();
  client.listSessions = async () => new Promise(() => {});
  const control = new WhatsappControlService({
    runtimeDirectory: directory,
    dbPath: repository.dbPath,
    workerIntervalSeconds: 60,
    sendTimeoutMs: 100,
    lifecycleTimeoutMs: 10,
    startupReconcileTimeoutMs: 30,
    startupRetryIntervalMs: 5
  }, client, repository);
  const startedAt = Date.now();
  try {
    await assert.rejects(() => control.start(), /startup reconciliation failed within 30ms/);
    assert.ok(Date.now() - startedAt < 250);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withControl(callback) {
  const directory = mkdtempSync(join(tmpdir(), "waha-control-"));
  const repository = new WhatsappRepository(join(directory, "whatsapp.sqlite"));
  repository.initialize();
  repository.upsertContacts([
    { chatId: "15551234567@c.us", displayName: "Alice", isUser: true, isGroup: false, updatedAtMs: Date.now() }
  ]);
  const client = new FakeWahaClient();
  const control = new WhatsappControlService({ runtimeDirectory: directory, dbPath: repository.dbPath, workerIntervalSeconds: 60, sendTimeoutMs: 100 }, client, repository);
  try {
    await callback({ control, client, repository });
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

class FakeWahaClient {
  sessions = [{ name: "default", status: "WORKING", engine: "GOWS" }];
  contacts = [{ id: "15551234567@c.us", name: "Alice" }];
  chats = [{ id: "120363000@g.us", name: "Group Chat" }, { id: "15551234567@c.us", name: "Alice Chat" }];
  qr = "safe-test-qr-payload";
  created = 0;
  started = 0;
  loggedOut = 0;
  sent = [];
  async listSessions() { return this.sessions; }
  async getSession() { return this.sessions.find((session) => session.name === "default"); }
  async createDefaultSession() { this.created += 1; const session = { name: "default", status: "STARTING", engine: "GOWS" }; this.sessions = [session]; return session; }
  async startDefaultSession() { this.started += 1; const session = { name: "default", status: "WORKING", engine: "GOWS" }; this.sessions = [session]; return session; }
  async logoutDefaultSession() { this.loggedOut += 1; }
  async getQrPayload() { return this.qr; }
  async getContacts() { return this.contacts; }
  async getChats() { return this.chats; }
  async sendText(chatId, text) { this.sent.push({ chatId, text }); return `waha-${this.sent.length}`; }
}
