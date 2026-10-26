import assert from "node:assert/strict";
import test from "node:test";

import { WahaClient } from "../dist/services/cli-api/src/whatsapp/wahaClient.js";

test("WAHA sendText uses the exact authenticated request and returns its message ID", async () => {
  const calls = [];
  const client = new WahaClient({
    baseUrl: "http://waha:3000/",
    apiKey: "test-api-key",
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ id: "message-123" });
    }
  });

  assert.equal(await client.sendText("972555123456@c.us", "private text"), "message-123");
  assert.equal(calls[0].url, "http://waha:3000/api/sendText");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "X-Api-Key": "test-api-key", "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { session: "default", chatId: "972555123456@c.us", text: "private text" });
});

test("WAHA requests surface timeout, non-2xx, invalid JSON, and missing send IDs", async () => {
  const timeoutClient = new WahaClient({
    baseUrl: "http://waha:3000",
    apiKey: "key",
    timeoutMs: 5,
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
  });
  await assert.rejects(() => timeoutClient.sendText("1@c.us", "text"), /timed out after 5ms/);

  const errorClient = clientReturning(new Response("X-Api-Key=secret downstream failure", { status: 500 }));
  await assert.rejects(() => errorClient.sendText("1@c.us", "text"), (error) => {
    assert.match(error.message, /WAHA request failed \(500\)/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  await assert.rejects(() => clientReturning(new Response("not-json")).sendText("1@c.us", "text"), /not valid JSON/);
  await assert.rejects(() => clientReturning(Response.json({ ok: true })).sendText("1@c.us", "text"), /did not contain a message ID/);
});

test("WAHA session parsing retains string and nested engine support without treating other metadata as GOWS", async () => {
  for (const [engine, expected] of [
    ["gows", "GOWS"],
    [{ engine: "gows" }, "GOWS"],
    ["webjs", "WEBJS"],
    [{ grpc: { client: "READY", stream: "READY" } }, undefined]
  ]) {
    const client = clientReturning(Response.json({ name: "default", status: "WORKING", engine }));
    assert.deepEqual(await client.getSession(), { name: "default", status: "WORKING", engine: expected });
  }
});

test("WAHA session listing resolves GOWS from the exact pinned detail response", async () => {
  const calls = [];
  const responses = [
    Response.json([
      {
        name: "default",
        status: "FAILED",
        config: null,
        presence: null,
        timestamps: {}
      }
    ]),
    Response.json({
      name: "default",
      status: "FAILED",
      config: null,
      presence: null,
      timestamps: {},
      engine: {
        grpc: { client: "READY", stream: "READY" },
        gows: { found: true, connected: false }
      }
    })
  ];
  const client = new WahaClient({
    baseUrl: "http://waha:3000",
    apiKey: "key",
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  assert.deepEqual(await client.listSessions(), [{ name: "default", status: "FAILED", engine: "GOWS" }]);
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method, apiKey: init.headers["X-Api-Key"] })),
    [
      { url: "http://waha:3000/api/sessions?all=true", method: "GET", apiKey: "key" },
      { url: "http://waha:3000/api/sessions/default", method: "GET", apiKey: "key" }
    ]
  );
});

test("WAHA lists stopped sessions and fetches raw QR data with the documented POST endpoint", async () => {
  const calls = [];
  const responses = [Response.json([]), Response.json({ value: "qr-payload" })];
  const client = new WahaClient({
    baseUrl: "http://waha:3000",
    apiKey: "key",
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });
  assert.deepEqual(await client.listSessions(), []);
  assert.equal(await client.getQrPayload(), "qr-payload");
  assert.equal(calls[0].url, "http://waha:3000/api/sessions?all=true");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].url, "http://waha:3000/api/default/auth/qr?format=raw");
  assert.equal(calls[1].init.method, "POST");
});

function clientReturning(response) {
  return new WahaClient({ baseUrl: "http://waha:3000", apiKey: "key", timeoutMs: 1000, fetch: async () => response });
}
