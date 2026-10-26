import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DagentApiService } from "../dist/services/cli-api/src/dagentApiService.js";

test("Telegram auth endpoint requires bearer auth and persists owner-only credentials in the Telegram runtime", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-api-runtime-"));
  const telegramRuntimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-api-telegram-"));
  const service = new DagentApiService({ runtimeDirectory, telegramRuntimeDirectory, hostname: "127.0.0.1", port: 0, token: "fake-api-token" });
  const botToken = "123456:fake-telegram-test-token";
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.getListeningPort()}`;
    const unauthorized = await fetch(`${baseUrl}/telegram/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken, userId: "123456" })
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/telegram/auth`, {
      method: "POST",
      headers: { authorization: "Bearer fake-api-token", "content-type": "application/json" },
      body: JSON.stringify({ botToken, userId: "123456" })
    });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.doesNotMatch(responseText, new RegExp(botToken));
    const result = JSON.parse(responseText);
    assert.equal(result.botTokenPresent, true);
    assert.equal(result.allowedUserId, 123456);

    const credentialsPath = join(telegramRuntimeDirectory, "data", "telegram", "credentials.json");
    assert.deepEqual(JSON.parse(readFileSync(credentialsPath, "utf8")), {
      botToken,
      allowedUserId: 123456,
      updatedAt: result.updatedAt
    });
    assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(telegramRuntimeDirectory, "data", "telegram")).mode & 0o777, 0o700);
  } finally {
    await service.stop();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(telegramRuntimeDirectory, { recursive: true, force: true });
  }
});

test("Telegram auth endpoint rejects a non-numeric user id without exposing the token", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-api-telegram-invalid-"));
  const service = new DagentApiService({ runtimeDirectory, hostname: "127.0.0.1", port: 0 });
  const botToken = "123456:fake-invalid-test-token";
  try {
    await service.start();
    const response = await fetch(`http://127.0.0.1:${service.getListeningPort()}/telegram/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken, userId: "not-numeric" })
    });
    assert.equal(response.status, 400);
    const responseText = await response.text();
    assert.match(responseText, /positive numeric Telegram user id/);
    assert.doesNotMatch(responseText, new RegExp(botToken));
  } finally {
    await service.stop();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
