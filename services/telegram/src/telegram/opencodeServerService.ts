import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import type { AppService } from "../../../../shared/service/appService.js";

type FatalHandler = (error: Error) => void;

export class OpencodeServerService implements AppService {
  readonly name = "opencode-server";

  private child?: ChildProcessByStdio<null, Readable, Readable>;
  private stopping = false;
  private started = false;
  private output = "";

  constructor(
    private readonly config: Config,
    private readonly onFatal: FatalHandler
  ) {}

  async start(): Promise<void> {
    if (!this.config.opencodeServerAutoStart) {
      console.log("Opencode server auto-start disabled; expecting an existing server.");
      return;
    }

    if (this.child) {
      return;
    }

    this.stopping = false;
    const args = ["serve", "--port", String(this.config.opencodeServerPort), "--hostname", this.config.opencodeServerHostname];
    if (this.config.opencodeServerPrintLogs) {
      args.push("--print-logs");
    }

    const child = spawn("opencode", args, {
      cwd: this.config.opencodeServerDirectory,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleOutput(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => this.handleOutput(chunk, true));

    let ready = false;
    const startupFailure = new Promise<never>((_, reject) => {
      child.once("error", (error) => {
        if (!ready) {
          reject(new Error(`Failed to start opencode serve: ${error.message}`));
          return;
        }
        this.handleUnexpectedExit(new Error(`opencode serve process error: ${error.message}`));
      });

      child.once("exit", (code, signal) => {
        const message = formatExit(code, signal);
        if (!ready) {
          reject(new Error(`opencode serve exited before it was ready: ${message}${this.outputSuffix()}`));
          return;
        }
        if (!this.stopping) {
          this.handleUnexpectedExit(new Error(`opencode serve exited unexpectedly: ${message}`));
        }
      });
    });

    try {
      await Promise.race([this.waitUntilReady(), startupFailure]);
      ready = true;
      this.started = true;
      console.log(`Opencode server ready at ${this.config.opencodeServerUrl}.`);
    } catch (error) {
      this.stopping = true;
      if (child.pid) {
        await this.stop();
      } else {
        this.child = undefined;
        this.started = false;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.child || !this.config.opencodeServerAutoStart) {
      return;
    }

    this.stopping = true;
    const child = this.child;
    if (child.exitCode !== null || child.killed) {
      this.child = undefined;
      this.started = false;
      return;
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");

    try {
      const timedOut = await Promise.race([exited.then(() => false), delay(5000).then(() => true)]);
      if (timedOut) {
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      this.child = undefined;
      this.started = false;
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + 30000;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const response = await this.fetchHealth();
        if (response.ok) {
          return;
        }
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
      } catch (error) {
        lastError = error;
      }

      await delay(500);
    }

    throw new Error(
      `opencode serve did not become ready at ${this.config.opencodeServerUrl} within 30s${formatLastError(lastError)}${this.outputSuffix()}`
    );
  }

  private async fetchHealth(): Promise<Response> {
    const headers = new Headers();
    headers.set("accept", "application/json");
    if (this.config.opencodeServerPassword) {
      const username = this.config.opencodeServerUsername ?? "opencode";
      const credentials = Buffer.from(`${username}:${this.config.opencodeServerPassword}`).toString("base64");
      headers.set("authorization", `Basic ${credentials}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      return await fetch(`${this.config.opencodeServerUrl.replace(/\/+$/, "")}/global/health`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleOutput(chunk: Buffer, stderr: boolean): void {
    const text = chunk.toString();
    this.output = `${this.output}${text}`.slice(-4000);
    if (!this.config.opencodeServerPrintLogs) {
      return;
    }

    (stderr ? process.stderr : process.stdout).write(text);
  }

  private handleUnexpectedExit(error: Error): void {
    if (!this.started || this.stopping) {
      return;
    }
    this.onFatal(error);
  }

  private outputSuffix(): string {
    return this.output.trim() ? `\nRecent opencode output:\n${this.output.trim()}` : "";
  }
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }
  return `exit code ${code ?? "unknown"}`;
}

function formatLastError(error: unknown): string {
  if (!error) {
    return "";
  }
  return `: ${error instanceof Error ? error.message : String(error)}`;
}
