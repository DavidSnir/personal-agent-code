import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DagentApiService } from "../dist/services/cli-api/src/dagentApiService.js";

test("control API initializes both exact remote MCPs and rejects broad CLI and supervisor routes", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "dagent-api-routing-"));
  const agentRuntimeDirectory = mkdtempSync(join(tmpdir(), "dagent-agent-routing-"));
  const configPath = join(agentRuntimeDirectory, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ custom: "preserved", mcp: { other: { enabled: false } } }));
  const service = new DagentApiService({
    runtimeDirectory,
    agentRuntimeDirectory,
    agentOpencodeConfigPath: configPath,
    hostname: "127.0.0.1",
    port: 0
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.getListeningPort()}`;
    const initialized = await fetch(`${baseUrl}/deployment/init`, { method: "POST" });
    assert.equal(initialized.status, 200);
    const result = await initialized.json();
    assert.equal(result.opencodeConfig.configPath, configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.custom, "preserved");
    assert.deepEqual(config.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
    assert.deepEqual(config.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });

    for (const path of ["/cli", "/start", "/stop", "/internal/detached"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: path === "/cli" ? JSON.stringify({ argv: ["start"] }) : undefined
      });
      assert.equal(response.status, 400, path);
      const body = await response.text();
      assert.match(body, path === "/cli" ? /broad CLI proxy is disabled/ : /Remote native supervisor/);
    }
  } finally {
    await service.stop();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(agentRuntimeDirectory, { recursive: true, force: true });
  }
});
