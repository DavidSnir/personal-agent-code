import assert from "node:assert/strict";
import test from "node:test";

import { TelegramConnectionService } from "../dist/services/telegram/src/telegram/telegramConnectionService.js";

test("Telegram polling retries DNS and timeout failures with capped exponential backoff", async () => {
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const token = "123456:test-secret-token";
  const retryDelays = [];
  const logs = [];
  const activePollStarted = deferred();
  let activePollSignal;
  let fatalError;

  const outcomes = [
    networkError("EAI_AGAIN", `fetch failed for https://api.telegram.org/bot${token}/getUpdates`),
    networkError("UND_ERR_CONNECT_TIMEOUT", "fetch failed"),
    networkError("EAI_AGAIN", "fetch failed"),
    networkError("UND_ERR_CONNECT_TIMEOUT", "fetch failed"),
    networkError("EAI_AGAIN", "fetch failed"),
    networkError("UND_ERR_CONNECT_TIMEOUT", "fetch failed"),
    networkError("EAI_AGAIN", "fetch failed"),
    jsonResponse({ ok: true, result: [] }),
    networkError("UND_ERR_CONNECT_TIMEOUT", "fetch failed")
  ];

  globalThis.fetch = async (url, init = {}) => {
    assert.match(String(url), /\/getUpdates$/);
    const outcome = outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    if (outcome) {
      return outcome;
    }

    activePollSignal = init.signal;
    activePollStarted.resolve();
    return waitForAbort(init.signal);
  };
  console.error = (...values) => logs.push(values.join(" "));

  const service = new TelegramConnectionService({
    token,
    allowedUserId: 123,
    agent: createAgent(),
    onFatal: (error) => {
      fatalError = error;
    },
    retryDelay: async (milliseconds) => {
      retryDelays.push(milliseconds);
    }
  });

  try {
    await service.start();
    await activePollStarted.promise;

    assert.deepEqual(retryDelays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 1000]);
    assert.equal(logs.length, 8);
    assert.match(logs[0], /EAI_AGAIN/);
    assert.match(logs[1], /UND_ERR_CONNECT_TIMEOUT/);
    assert.ok(logs.every((message) => message.includes("Telegram getUpdates failed; retrying")));
    assert.ok(logs.every((message) => !message.includes(token)));
    assert.equal(fatalError, undefined);

    await service.stop();
    assert.equal(activePollSignal.aborted, true);
    assert.equal(fatalError, undefined);
  } finally {
    await service.stop();
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});

test("a failed update error response does not mask the original error or destabilize polling", async () => {
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const token = "987654:test-secret-token";
  const logs = [];
  const retryDelays = [];
  const sentBodies = [];
  const actionBodies = [];
  const events = [];
  const nextPollStarted = deferred();
  let pollCount = 0;
  let fatalError;

  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    if (method === "sendMessage") {
      events.push("error-reply");
      sentBodies.push(body);
      throw networkError("UND_ERR_CONNECT_TIMEOUT", `send failed via bot token ${token}`);
    }
    if (method === "sendChatAction") {
      actionBodies.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    assert.equal(method, "getUpdates");

    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({
        ok: true,
        result: [{ update_id: 41, message: { chat: { id: 7, type: "private" }, from: { id: 123 }, text: "hello" } }]
      });
    }

    nextPollStarted.resolve(body);
    return waitForAbort(init.signal);
  };
  console.error = (...values) => logs.push(values.join(" "));

  const service = new TelegramConnectionService({
    token,
    allowedUserId: 123,
    agent: createAgent({
      sendMessage: async () => {
        throw new Error(`original processing failure ${token}`);
      }
    }),
    onFatal: (error) => {
      fatalError = error;
    },
    retryDelay: async (milliseconds) => {
      retryDelays.push(milliseconds);
    },
    typingRefreshDelay: async (_milliseconds, signal) => {
      try {
        await waitForAbort(signal);
      } finally {
        events.push("typing-stopped");
      }
    }
  });

  try {
    await service.start();
    const nextPollBody = await nextPollStarted.promise;

    assert.equal(nextPollBody.offset, 42);
    assert.deepEqual(retryDelays, []);
    assert.deepEqual(actionBodies, [{ chat_id: 7, action: "typing" }]);
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0].text, /^Error: original processing failure \[redacted\]$/);
    assert.match(logs[0], /Update handling failed: original processing failure \[redacted\]/);
    assert.match(logs[1], /Failed to send Telegram update error response: UND_ERR_CONNECT_TIMEOUT/);
    assert.ok(logs.every((message) => !message.includes(token)));
    assert.ok(logs.every((message) => !message.includes("getUpdates failed")));
    assert.ok(events.indexOf("typing-stopped") < events.indexOf("error-reply"));
    assert.equal(fatalError, undefined);
  } finally {
    await service.stop();
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});

test("ordinary messages maintain typing until before the Markdown reply", async () => {
  const previousFetch = globalThis.fetch;
  const sentActions = [];
  const sentMessages = [];
  const events = [];
  const agentStarted = deferred();
  const agentReply = deferred();
  const firstDelayStarted = deferred();
  const releaseFirstDelay = deferred();
  const refreshSent = deferred();
  const secondDelayStarted = deferred();
  const nextPollStarted = deferred();
  let pollCount = 0;
  let delayCount = 0;
  let fatalError;

  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    if (method === "sendChatAction") {
      events.push(`action-${sentActions.length + 1}`);
      sentActions.push(body);
      if (sentActions.length === 2) {
        refreshSent.resolve();
      }
      return jsonResponse({ ok: true, result: true });
    }
    if (method === "sendMessage") {
      events.push("persistent-reply");
      sentMessages.push(body);
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    assert.equal(method, "getUpdates");

    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({
        ok: true,
        result: [{ update_id: 73, message: { chat: { id: 9, type: "private" }, from: { id: 123 }, text: "hello" } }]
      });
    }

    nextPollStarted.resolve(body);
    return waitForAbort(init.signal);
  };

  const service = new TelegramConnectionService({
    token: "test-token",
    allowedUserId: 123,
    agent: createAgent({
      sendMessage: async () => {
        events.push("agent-started");
        agentStarted.resolve();
        await agentReply.promise;
        events.push("agent-finished");
        return { text: "**complete**", format: "markdown" };
      }
    }),
    onFatal: (error) => {
      fatalError = error;
    },
    typingRefreshDelay: async (milliseconds, signal) => {
      assert.equal(milliseconds, 4_000);
      delayCount += 1;
      if (delayCount === 1) {
        firstDelayStarted.resolve();
        await waitForReleaseOrAbort(releaseFirstDelay.promise, signal);
        return;
      }

      secondDelayStarted.resolve(signal);
      try {
        await waitForAbort(signal);
      } finally {
        events.push("typing-maintenance-stopped");
      }
    }
  });

  try {
    await service.start();
    await agentStarted.promise;
    await firstDelayStarted.promise;

    assert.deepEqual(sentActions, [{ chat_id: 9, action: "typing" }]);
    assert.deepEqual(sentMessages, []);
    releaseFirstDelay.resolve();
    await refreshSent.promise;
    const secondDelaySignal = await secondDelayStarted.promise;

    assert.deepEqual(sentActions, [
      { chat_id: 9, action: "typing" },
      { chat_id: 9, action: "typing" }
    ]);
    agentReply.resolve();
    await nextPollStarted.promise;

    assert.equal(secondDelaySignal.aborted, true);
    assert.equal(sentActions.length, 2);
    assert.deepEqual(sentMessages, [{ chat_id: 9, text: "**complete**", parse_mode: "Markdown" }]);
    assert.ok(events.indexOf("typing-maintenance-stopped") < events.indexOf("persistent-reply"));
    assert.equal(fatalError, undefined);
  } finally {
    agentReply.resolve();
    releaseFirstDelay.resolve();
    await service.stop();
    globalThis.fetch = previousFetch;
  }
});

test("sendChatAction failures are sanitized and do not alter agent handling", async () => {
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const token = "123456:action-secret-token";
  const logs = [];
  const sentMessages = [];
  const nextPollStarted = deferred();
  let pollCount = 0;
  let agentCalls = 0;
  let fatalError;

  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    if (method === "sendChatAction") {
      return jsonResponse({
        ok: false,
        error_code: 400,
        description: `failed via https://api.telegram.org/bot${token}/sendChatAction`
      }, 400);
    }
    if (method === "sendMessage") {
      sentMessages.push(body);
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    }
    assert.equal(method, "getUpdates");

    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({
        ok: true,
        result: [{ update_id: 81, message: { chat: { id: 12, type: "private" }, from: { id: 123 }, text: "hello" } }]
      });
    }

    nextPollStarted.resolve(body);
    return waitForAbort(init.signal);
  };
  console.error = (...values) => logs.push(values.join(" "));

  const service = new TelegramConnectionService({
    token,
    allowedUserId: 123,
    agent: createAgent({
      sendMessage: async () => {
        agentCalls += 1;
        return { text: "ok", format: "markdown" };
      }
    }),
    onFatal: (error) => {
      fatalError = error;
    }
  });

  try {
    await service.start();
    const nextPollBody = await nextPollStarted.promise;

    assert.equal(nextPollBody.offset, 82);
    assert.equal(agentCalls, 1);
    assert.deepEqual(sentMessages, [{ chat_id: 12, text: "ok", parse_mode: "Markdown" }]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Telegram sendChatAction failed/);
    assert.match(logs[0], /https:\/\/api\.telegram\.org\/bot\[redacted\]\/sendChatAction/);
    assert.ok(!logs[0].includes(token));
    assert.equal(fatalError, undefined);
  } finally {
    await service.stop();
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});

test("typing covers private and groups but excludes channels, commands, and unauthorized messages", async () => {
  const previousFetch = globalThis.fetch;
  const actionBodies = [];
  const sentMessages = [];
  const forwardedTexts = [];
  const nextPollStarted = deferred();
  let pollCount = 0;
  let fatalError;

  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(String(url)).pathname.split("/").at(-1);
    const body = JSON.parse(init.body);
    if (method === "sendChatAction") {
      actionBodies.push(body);
      return jsonResponse({ ok: true, result: true });
    }
    if (method === "sendMessage") {
      sentMessages.push(body);
      return jsonResponse({ ok: true, result: { message_id: sentMessages.length } });
    }
    assert.equal(method, "getUpdates");

    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({
        ok: true,
        result: [
          { update_id: 91, message: { chat: { id: 9, type: "private" }, from: { id: 123 }, text: "private hello" } },
          { update_id: 92, message: { chat: { id: -10, type: "group" }, from: { id: 123 }, text: "group hello" } },
          { update_id: 93, message: { chat: { id: -11, type: "supergroup" }, from: { id: 123 }, text: "supergroup hello" } },
          { update_id: 94, message: { chat: { id: -12, type: "channel" }, from: { id: 123 }, text: "channel hello" } },
          { update_id: 95, message: { chat: { id: 10, type: "private" }, from: { id: 123 }, text: "/start" } },
          { update_id: 96, message: { chat: { id: 11, type: "private" }, from: { id: 999 }, text: "denied hello" } }
        ]
      });
    }

    nextPollStarted.resolve(body);
    return waitForAbort(init.signal);
  };

  const service = new TelegramConnectionService({
    token: "test-token",
    allowedUserId: 123,
    agent: createAgent({
      sendMessage: async (_sessionId, text) => {
        forwardedTexts.push(text);
        return { text: "group reply", format: "markdown" };
      }
    }),
    onFatal: (error) => {
      fatalError = error;
    }
  });

  try {
    await service.start();
    const nextPollBody = await nextPollStarted.promise;

    assert.equal(nextPollBody.offset, 97);
    assert.deepEqual(actionBodies, [
      { chat_id: 9, action: "typing" },
      { chat_id: -10, action: "typing" },
      { chat_id: -11, action: "typing" }
    ]);
    assert.deepEqual(forwardedTexts, ["private hello", "group hello", "supergroup hello", "channel hello"]);
    assert.deepEqual(sentMessages, [
      { chat_id: 9, text: "group reply", parse_mode: "Markdown" },
      { chat_id: -10, text: "group reply", parse_mode: "Markdown" },
      { chat_id: -11, text: "group reply", parse_mode: "Markdown" },
      { chat_id: -12, text: "group reply", parse_mode: "Markdown" },
      {
        chat_id: 10,
        text: "Personal Agent is ready. Send text to forward it to opencode, or use /new to start a fresh opencode session."
      },
      { chat_id: 11, text: "Access denied." }
    ]);
    assert.equal(fatalError, undefined);
  } finally {
    await service.stop();
    globalThis.fetch = previousFetch;
  }
});

test("Telegram polling treats Bot API 401, 403, 404, and 409 as fatal", async () => {
  const previousFetch = globalThis.fetch;
  let status = 0;
  let fetchCalls = 0;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    return jsonResponse({ ok: false, error_code: status, description: `status ${status}` }, status);
  };

  try {
    for (status of [401, 403, 404, 409]) {
      const fatal = deferred();
      const service = new TelegramConnectionService({
        token: "test-token",
        allowedUserId: 123,
        agent: createAgent(),
        onFatal: fatal.resolve,
        retryDelay: async () => {
          assert.fail(`status ${status} must not be retried`);
        }
      });

      await service.start();
      const error = await fatal.promise;
      assert.match(error.message, new RegExp(`Telegram getUpdates failed: status ${status}`));
      await service.stop();
    }

    assert.equal(fetchCalls, 4);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("stop aborts an active polling retry delay", async () => {
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const retryStarted = deferred();
  let fetchCalls = 0;
  let retrySignal;
  let fatalError;

  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw networkError("EAI_AGAIN", "fetch failed");
  };
  console.error = () => undefined;

  const service = new TelegramConnectionService({
    token: "test-token",
    allowedUserId: 123,
    agent: createAgent(),
    onFatal: (error) => {
      fatalError = error;
    },
    retryDelay: (milliseconds, signal) => {
      retrySignal = signal;
      retryStarted.resolve(milliseconds);
      return waitForAbort(signal);
    }
  });

  try {
    await service.start();
    assert.equal(await retryStarted.promise, 1000);
    await service.stop();

    assert.equal(retrySignal.aborted, true);
    assert.equal(fetchCalls, 1);
    assert.equal(fatalError, undefined);
  } finally {
    await service.stop();
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  }
});

function createAgent(overrides = {}) {
  return {
    displayName: "test agent",
    health: async () => ({ healthy: true }),
    createSession: async () => "session-1",
    sendMessage: async () => ({ text: "ok", format: "markdown" }),
    listModels: async () => [],
    getModel: () => undefined,
    setModel: async () => undefined,
    ...overrides
  };
}

function networkError(code, message) {
  const cause = Object.assign(new Error(code), { code });
  return new TypeError(message, { cause });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    const rejectForAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener("abort", rejectForAbort, { once: true });
  });
}

function waitForReleaseOrAbort(release, signal) {
  return Promise.race([release, waitForAbort(signal)]);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
