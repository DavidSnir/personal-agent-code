export const WAHA_DEFAULT_SESSION = "default";
export const WAHA_REQUIRED_ENGINE = "GOWS";

export type WahaSession = {
  name: string;
  status: string;
  engine?: string;
};

export type WahaClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  sendTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  fetch?: typeof fetch;
};

export class WahaClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WahaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async listSessions(deadlineMs?: number): Promise<WahaSession[]> {
    const value = await this.request("GET", "/api/sessions?all=true", undefined, "lifecycle", deadlineMs);
    if (!Array.isArray(value)) throw new Error("WAHA sessions response is malformed");
    const sessions = value.map(parseSession);
    const defaultIndex = sessions.findIndex((session) => session.name === WAHA_DEFAULT_SESSION);
    if (defaultIndex >= 0 && !sessions[defaultIndex].engine) {
      sessions[defaultIndex] = (await this.getSession(WAHA_DEFAULT_SESSION, deadlineMs)) ?? sessions[defaultIndex];
    }
    return sessions;
  }

  async getSession(name = WAHA_DEFAULT_SESSION, deadlineMs?: number): Promise<WahaSession | undefined> {
    try {
      return parseSession(await this.request("GET", `/api/sessions/${encodeURIComponent(name)}`, undefined, "lifecycle", deadlineMs));
    } catch (error) {
      if (error instanceof WahaHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async createDefaultSession(deadlineMs?: number): Promise<WahaSession> {
    return parseSession(await this.request("POST", "/api/sessions", { name: WAHA_DEFAULT_SESSION, start: true }, "lifecycle", deadlineMs));
  }

  async startDefaultSession(deadlineMs?: number): Promise<WahaSession> {
    const value = await this.request("POST", `/api/sessions/${WAHA_DEFAULT_SESSION}/start`, undefined, "lifecycle", deadlineMs);
    return value === undefined ? (await this.getRequiredDefaultSession(deadlineMs)) : parseSession(value);
  }

  async logoutDefaultSession(): Promise<void> {
    await this.request("POST", `/api/sessions/${WAHA_DEFAULT_SESSION}/logout`);
  }

  async getQrPayload(): Promise<string> {
    const value = await this.request("POST", `/api/${WAHA_DEFAULT_SESSION}/auth/qr?format=raw`);
    if (!isRecord(value) || typeof value.value !== "string" || !value.value.trim()) {
      throw new Error("WAHA QR response is malformed");
    }
    return value.value;
  }

  async getContacts(): Promise<unknown[]> {
    const value = await this.request("GET", `/api/contacts/all?session=${WAHA_DEFAULT_SESSION}`);
    if (!Array.isArray(value)) throw new Error("WAHA contacts response is malformed");
    return value;
  }

  async getChats(): Promise<unknown[]> {
    const value = await this.request("GET", `/api/${WAHA_DEFAULT_SESSION}/chats?limit=1000`);
    if (!Array.isArray(value)) throw new Error("WAHA chats response is malformed");
    return value;
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const value = await this.request("POST", "/api/sendText", { session: WAHA_DEFAULT_SESSION, chatId, text }, "send");
    if (!isRecord(value)) throw new Error("WAHA sendText response is malformed");
    const id = readMessageId(value.id);
    if (!id) throw new Error("WAHA sendText response did not contain a message ID");
    return id;
  }

  private async getRequiredDefaultSession(deadlineMs?: number): Promise<WahaSession> {
    const session = await this.getSession(WAHA_DEFAULT_SESSION, deadlineMs);
    if (!session) throw new Error("WAHA default session was not found after start");
    return session;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, kind: "lifecycle" | "send" = "lifecycle", deadlineMs?: number): Promise<unknown> {
    const configuredTimeout = kind === "send"
      ? this.options.sendTimeoutMs ?? this.options.timeoutMs ?? 120000
      : this.options.lifecycleTimeoutMs ?? this.options.timeoutMs ?? 10000;
    const remainingMs = deadlineMs === undefined ? configuredTimeout : Math.min(configuredTimeout, deadlineMs - Date.now());
    if (remainingMs <= 0) throw new Error("WAHA startup reconciliation deadline expired");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-Api-Key": this.options.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new WahaHttpError(response.status, `WAHA request failed (${response.status}): ${sanitizeWahaError(text || response.statusText)}`);
      if (!text) return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("WAHA response was not valid JSON");
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`WAHA ${kind} request timed out after ${remainingMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class WahaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sanitizeWahaError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(X-Api-Key|WAHA_API_KEY|WAHA_WEBHOOK_SECRET)\s*[:=]\s*[^\s,"']+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(["'](?:text|body)["']\s*:\s*["'])[^"']*(["'])/gi, "$1[redacted]$2")
    .slice(0, 500);
}

export function readMessageId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  const serialized = value._serialized;
  return typeof serialized === "string" && serialized.trim() ? serialized.trim() : undefined;
}

function parseSession(value: unknown): WahaSession {
  if (!isRecord(value)) throw new Error("WAHA session response is malformed");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const status = typeof value.status === "string" ? value.status.trim().toUpperCase() : "";
  const engineMetadata = isRecord(value.engine) ? value.engine : undefined;
  const nestedEngine = engineMetadata?.engine;
  const engineValue = typeof value.engine === "string" ? value.engine : nestedEngine;
  const engine = typeof engineValue === "string"
    ? engineValue.trim().toUpperCase()
    : isRecord(engineMetadata?.gows) ? WAHA_REQUIRED_ENGINE : undefined;
  if (!name || !status) throw new Error("WAHA session response is malformed");
  return { name, status, engine };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
