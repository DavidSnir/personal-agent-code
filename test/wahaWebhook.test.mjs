import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import { DagentApiService } from "../dist/services/cli-api/src/dagentApiService.js";
import { parseWahaWebhook, verifyWahaWebhookHmac } from "../dist/services/cli-api/src/whatsapp/webhook.js";
import { WahaWebhookProcessor } from "../dist/services/cli-api/src/whatsapp/webhookProcessor.js";
import { WhatsappRepository } from "../dist/services/whatsapp/src/whatsapp/repository.js";

const secret = "webhook-test-secret";

test("webhook HMAC validates exact raw bytes and rejects missing, malformed, and wrong-length values", () => {
  const raw = Buffer.from('{"id":"event-1","session":"default","event":"message","payload":{}}');
  const signature = sign(raw);
  assert.equal(verifyWahaWebhookHmac(raw, signature, secret), true);
  assert.equal(verifyWahaWebhookHmac(Buffer.from(`${raw.toString()} `), signature, secret), false);
  assert.equal(verifyWahaWebhookHmac(raw, undefined, secret), false);
  assert.equal(verifyWahaWebhookHmac(raw, "not-hex", secret), false);
  assert.equal(verifyWahaWebhookHmac(raw, "aa", secret), false);
});

test("signed webhook envelope validation requires id, default session, and one exact event type", () => {
  assert.equal(parseWahaWebhook(eventBody("event-1", "message")).id, "event-1");
  assert.throws(() => parseWahaWebhook(Buffer.from("{")), /valid JSON/);
  assert.throws(() => parseWahaWebhook(Buffer.from(JSON.stringify({ id: "", session: "default", event: "message" }))), /id is required/);
  assert.throws(() => parseWahaWebhook(Buffer.from(JSON.stringify({ id: "x", session: "other", event: "message" }))), /session must be default/);
  assert.throws(() => parseWahaWebhook(Buffer.from(JSON.stringify({ id: "x", session: "default", event: "presence.update" }))), /not subscribed/);
});

test("HTTP webhook route is HMAC-only, deduplicates before acknowledgement, rejects malformed signed JSON, and limits bodies", async () => {
  const whatsapp = new FakeWhatsappControl();
  const service = new DagentApiService({ runtimeDirectory: process.cwd(), hostname: "127.0.0.1", port: 0, token: "bearer-token", whatsapp, whatsappWebhookSecret: secret });
  await service.start();
  const baseUrl = `http://127.0.0.1:${service.getListeningPort()}`;
  try {
    const raw = eventBody("http-event", "message");
    const first = await postWebhook(baseUrl, raw, sign(raw));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true, duplicate: false });
    const duplicate = await postWebhook(baseUrl, raw, sign(raw));
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    assert.equal(whatsapp.accepted.size, 1);
    await waitImmediate();
    assert.equal(whatsapp.processingWakes, 1);

    assert.equal((await postWebhook(baseUrl, raw)).status, 401);
    assert.equal((await postWebhook(baseUrl, raw, "aa")).status, 401);
    const malformed = Buffer.from("{");
    assert.equal((await postWebhook(baseUrl, malformed, sign(malformed))).status, 400);

    const oversized = Buffer.alloc(1024 * 1024 + 1, 97);
    assert.equal((await postWebhook(baseUrl, oversized, sign(oversized))).status, 413);

    assert.equal((await fetch(`${baseUrl}/health`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/health`, { headers: { authorization: "Bearer bearer-token" } })).status, 200);
  } finally {
    await service.stop();
  }
});

test("webhook inbox deduplicates, recovers interrupted claims, retries boundedly, cleans payloads, and normalizes all event types", async () => {
  await withRepository(async (repository) => {
    const message = envelope("message-event", "message", { id: "message-1", fromMe: true, to: "1555@c.us", from: "me@c.us", timestamp: 100, body: "original", hasMedia: true });
    assert.equal(repository.insertWebhookEvent({ eventId: "message-event", eventType: "message", session: "default", payload: rawEnvelope(message) }), true);
    assert.equal(repository.insertWebhookEvent({ eventId: "message-event", eventType: "message", session: "default", payload: rawEnvelope(message) }), false);
    for (const value of [
      envelope("ack-event", "message.ack", { id: "message-1", ack: 3, ackName: "READ", timestamp: 101 }),
      envelope("edit-event", "message.edited", { editedMessageId: "message-1", body: "edited", timestamp: 102 }),
      envelope("revoke-event", "message.revoked", { revokedMessageId: "message-1", timestamp: 103 }),
      { ...envelope("status-event", "session.status", { status: "WORKING" }), timestamp: 1_700_000_000_104, engine: "GOWS" }
    ]) {
      repository.insertWebhookEvent({ eventId: value.id, eventType: value.event, session: "default", payload: rawEnvelope(value) });
    }

    const processor = new WahaWebhookProcessor(repository, 3);
    processor.start();
    await processor.stop();
    const normalized = repository.getWahaMessage("message-1");
    assert.equal(normalized.direction, "outgoing");
    assert.equal(normalized.chatId, "1555@c.us");
    assert.equal(normalized.body, "edited");
    assert.equal(normalized.hasMedia, true);
    assert.equal(normalized.acknowledgementName, "READ");
    assert.equal(normalized.revokedAtMs, 103000);
    assert.deepEqual(repository.getWahaSession(), { session: "default", status: "WORKING", engine: "GOWS", updatedAtMs: 1_700_000_000_104 });
    repository.acknowledgeWahaMessage("message-1", 2, "DEVICE", 100000);
    repository.upsertWahaMessage({ messageId: "message-1", body: "stale edit", bodyUpdatedAtMs: 90000, hasMedia: false, editedAtMs: 90000 });
    repository.upsertWahaSession({ session: "default", status: "STOPPED", engine: "GOWS", updatedAtMs: 1_700_000_000_000 });
    assert.equal(repository.getWahaMessage("message-1").acknowledgementName, "READ");
    assert.equal(repository.getWahaMessage("message-1").body, "edited");
    assert.equal(repository.getWahaMessage("message-1").editedAtMs, 102000);
    assert.equal(repository.getWahaSession().status, "WORKING");
    assert.equal(repository.getWebhookEvent("message-event").payload, null);
    assert.equal(repository.getWebhookCounts().processed, 5);

    const bad = envelope("bad-event", "message", { body: "missing id" });
    repository.insertWebhookEvent({ eventId: bad.id, eventType: bad.event, session: "default", payload: rawEnvelope(bad) });
    const retryProcessor = new WahaWebhookProcessor(repository, 2);
    retryProcessor.start();
    await retryProcessor.stop();
    const failed = repository.getWebhookEvent("bad-event");
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 2);
    assert.equal(Buffer.isBuffer(failed.payload), true);

    const interrupted = envelope("interrupted", "session.status", { status: "WORKING" });
    repository.insertWebhookEvent({ eventId: interrupted.id, eventType: interrupted.event, session: "default", payload: rawEnvelope(interrupted) });
    assert.equal(repository.claimNextWebhookEvent(3).eventId, "interrupted");
    assert.equal(repository.recoverInterruptedWebhookEvents(3), 1);
    const recoveryProcessor = new WahaWebhookProcessor(repository, 3);
    recoveryProcessor.start();
    await recoveryProcessor.stop();
    assert.equal(repository.getWebhookEvent("interrupted").status, "processed");
  });
});

function eventBody(id, event) {
  return Buffer.from(JSON.stringify(envelope(id, event, {})));
}

function envelope(id, event, payload) {
  return { id, session: "default", event, payload };
}

function rawEnvelope(value) {
  return Buffer.from(JSON.stringify(value));
}

function sign(raw) {
  return createHmac("sha512", secret).update(raw).digest("hex");
}

function postWebhook(baseUrl, raw, signature) {
  return fetch(`${baseUrl}/internal/whatsapp/webhook`, { method: "POST", headers: signature ? { "X-Webhook-Hmac": signature } : {}, body: raw });
}

async function withRepository(callback) {
  const directory = mkdtempSync(join(tmpdir(), "waha-webhook-"));
  const repository = new WhatsappRepository(join(directory, "whatsapp.sqlite"));
  repository.initialize();
  try {
    await callback(repository);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

class FakeWhatsappControl {
  accepted = new Set();
  processingWakes = 0;
  async start() {}
  async stop() {}
  acceptWebhook({ id }) {
    if (this.accepted.has(id)) return false;
    this.accepted.add(id);
    return true;
  }
  processAcceptedWebhooks() { this.processingWakes += 1; }
}
