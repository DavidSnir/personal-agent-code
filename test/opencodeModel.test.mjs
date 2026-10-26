import assert from "node:assert/strict";
import test from "node:test";

import { OpencodeClient } from "../dist/services/agent/src/opencode/opencodeClient.js";
import { OpencodeTelegramAgent } from "../dist/services/telegram/src/telegram/opencodeTelegramAgent.js";
import { buildModelSelection } from "../dist/services/telegram/src/telegram/telegramConnectionService.js";

const baseConfig = {
  telegramEnabled: true,
  opencodeServerHostname: "127.0.0.1",
  opencodeServerPort: 4096,
  opencodeServerDirectory: "/tmp/project",
  opencodeServerPrintLogs: true,
  opencodeServerAutoStart: false,
  opencodeServerUrl: "http://127.0.0.1:4096",
  opencodeDirectory: "/tmp/project"
};

test("opencode model selection updates subsequent message bodies", async () => {
  const previousFetch = globalThis.fetch;
  const requestBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/provider") {
      return jsonResponse({
        connected: ["opencode"],
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            models: {
              "gpt-5": { id: "gpt-5", name: "GPT 5" },
              "gpt-5-mini": { id: "gpt-5-mini", name: "GPT 5 Mini" }
            }
          },
          {
            id: "unused",
            name: "Unused",
            models: { ignored: { id: "ignored", name: "Ignored" } }
          }
        ]
      });
    }
    if (path === "/session/session-1/message") {
      requestBodies.push(JSON.parse(init.body));
      return jsonResponse({ parts: [{ text: "ok" }] });
    }
    throw new Error(`Unexpected request ${path}`);
  };

  try {
    const client = new OpencodeClient({ ...baseConfig, opencodeModel: "opencode/gpt-5" });
    assert.equal(client.getModel(), "opencode/gpt-5");

    await client.setModel("opencode/gpt-5-mini");
    await client.sendMessage("session-1", "hello");

    assert.equal(client.getModel(), "opencode/gpt-5-mini");
    assert.deepEqual(requestBodies, [
      {
        model: { providerID: "opencode", modelID: "gpt-5-mini" },
        parts: [{ type: "text", text: "hello" }]
      }
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("opencode model selection rejects unknown models", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      connected: ["opencode"],
      all: [{ id: "opencode", name: "OpenCode", models: { "gpt-5": { id: "gpt-5", name: "GPT 5" } } }]
    });

  try {
    const client = new OpencodeClient(baseConfig);

    await assert.rejects(() => client.setModel("opencode/missing"), /Unknown model: opencode\/missing/);
    assert.equal(client.getModel(), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Telegram to opencode requests abort hanging servers with sanitized actionable errors", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("authorization=secret-value")));
  });
  try {
    const agent = new OpencodeTelegramAgent({
      opencodeServerUrl: "http://127.0.0.1:4096",
      opencodeRequestTimeoutMs: 10
    });
    await assert.rejects(() => agent.health(), (error) => {
      assert.match(error.message, /opencode request timed out after 10ms/);
      assert.match(error.message, /OPENCODE_REQUEST_TIMEOUT_MS/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("buildModelSelection produces text and keyboard with indexed models", () => {
  const result = buildModelSelection(
    [
      {
        id: "opencode/gpt-5",
        providerId: "opencode",
        providerName: "OpenCode",
        modelId: "gpt-5",
        modelName: "GPT 5"
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        providerId: "anthropic",
        providerName: "Anthropic",
        modelId: "claude-sonnet-4-5",
        modelName: "Claude Sonnet 4.5"
      }
    ],
    "opencode/gpt-5"
  );

  assert.match(result.text, /Current model: opencode\/gpt-5/);
  assert.match(result.text, /1\. GPT 5 \(opencode\/gpt-5\)/);
  assert.match(result.text, /2\. Claude Sonnet 4\.5 \(anthropic\/claude-sonnet-4-5\)/);
  assert.match(result.text, /\/model <number>/);
  assert.equal(result.modelIds.length, 2);
  assert.equal(result.modelIds[0], "opencode/gpt-5");
  assert.equal(result.modelIds[1], "anthropic/claude-sonnet-4-5");
  assert.equal(result.keyboard.inline_keyboard.length, 2);
  assert.equal(result.keyboard.inline_keyboard[0][0].text, "1. GPT 5");
  assert.equal(result.keyboard.inline_keyboard[0][0].callback_data, "ms:opencode/gpt-5");
});

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
