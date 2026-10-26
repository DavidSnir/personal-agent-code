import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { persistRuntimeServiceEnabled, readRuntimeServiceStatus } from "../dist/shared/utils/serviceSettings.js";

test("service preferences persist to runtime .settings instead of .env", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-service-settings-"));
  const previous = process.env.TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_ENABLED;
  try {
    const status = persistRuntimeServiceEnabled(runtimeDirectory, "telegram", false);
    const settingsPath = join(runtimeDirectory, ".settings");
    const envPath = join(runtimeDirectory, ".env");

    assert.equal(status.enabled, false);
    assert.equal(status.source, "runtime-settings");
    assert.equal(status.settingsPath, settingsPath);
    assert.equal(existsSync(settingsPath), true);
    assert.equal(existsSync(envPath), false);
    assert.match(readFileSync(settingsPath, "utf8"), /^TELEGRAM_ENABLED=false$/m);
  } finally {
    if (previous === undefined) {
      delete process.env.TELEGRAM_ENABLED;
    } else {
      process.env.TELEGRAM_ENABLED = previous;
    }
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("environment service overrides take precedence over runtime .settings", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-service-settings-"));
  const previous = process.env.GOOGLE_CALENDAR_ENABLED;
  try {
    delete process.env.GOOGLE_CALENDAR_ENABLED;
    persistRuntimeServiceEnabled(runtimeDirectory, "calendar", false);
    process.env.GOOGLE_CALENDAR_ENABLED = "true";

    const status = readRuntimeServiceStatus(runtimeDirectory, "calendar");

    assert.equal(status.enabled, true);
    assert.equal(status.source, "environment");
    assert.equal(status.persistedEnabled, false);
  } finally {
    if (previous === undefined) {
      delete process.env.GOOGLE_CALENDAR_ENABLED;
    } else {
      process.env.GOOGLE_CALENDAR_ENABLED = previous;
    }
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("runtime .env service values remain overrides but are not the persistence target", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-service-settings-"));
  const previous = process.env.OPENCODE_SERVER_AUTO_START;
  delete process.env.OPENCODE_SERVER_AUTO_START;
  try {
    persistRuntimeServiceEnabled(runtimeDirectory, "opencode", true);
    writeFileSync(join(runtimeDirectory, ".env"), "OPENCODE_SERVER_AUTO_START=false\n");

    const status = readRuntimeServiceStatus(runtimeDirectory, "opencode");

    assert.equal(status.enabled, false);
    assert.equal(status.source, "runtime-env");
    assert.equal(status.persistedEnabled, true);
    assert.match(readFileSync(join(runtimeDirectory, ".settings"), "utf8"), /^OPENCODE_SERVER_AUTO_START=true$/m);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_SERVER_AUTO_START;
    } else {
      process.env.OPENCODE_SERVER_AUTO_START = previous;
    }
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
