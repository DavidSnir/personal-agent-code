export type AgentHealth = {
  healthy: boolean;
  version?: string;
};

export type AgentReply = {
  text: string;
  format?: "markdown";
};

export type AgentModelOption = {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
};

export type AgentService = {
  name: string;
  displayName: string;
  health(): Promise<AgentHealth>;
  createSession(chatId: number): Promise<string>;
  listModels(): Promise<AgentModelOption[]>;
  getModel(): string | undefined;
  setModel(model: string): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<AgentReply>;
};

export type OpencodeTelegramAgentConfig = {
  opencodeServerUrl: string;
  opencodeServerUsername?: string;
  opencodeServerPassword?: string;
  opencodeAgent?: string;
  opencodeModel?: string;
  opencodeDirectory?: string;
  opencodeRequestTimeoutMs: number;
};

type SessionResponse = {
  id?: string;
  sessionID?: string;
};

type MessagePart = {
  type?: string;
  text?: string;
  content?: string;
};

type MessageResponse = {
  parts?: MessagePart[];
};

type ProviderModel = {
  id?: string;
  name?: string;
};

type Provider = {
  id: string;
  name?: string;
  models?: Record<string, ProviderModel>;
};

type ProviderResponse = {
  all?: Provider[];
  connected?: string[];
};

export class OpencodeTelegramAgent implements AgentService {
  readonly name = "opencode";
  readonly displayName = "opencode";

  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private selectedModel?: string;

  constructor(private readonly config: OpencodeTelegramAgentConfig) {
    this.baseUrl = config.opencodeServerUrl.replace(/\/+$/, "");
    this.selectedModel = config.opencodeModel;

    if (config.opencodeServerPassword) {
      const username = config.opencodeServerUsername ?? "opencode";
      const credentials = Buffer.from(`${username}:${config.opencodeServerPassword}`).toString("base64");
      this.authHeader = `Basic ${credentials}`;
    }
  }

  async health(): Promise<AgentHealth> {
    return this.request<AgentHealth>("/global/health", { method: "GET" });
  }

  async createSession(chatId: number): Promise<string> {
    const titleParts = [`Telegram chat ${chatId}`];
    if (this.config.opencodeDirectory) {
      titleParts.push(this.config.opencodeDirectory);
    }

    const session = await this.request<SessionResponse>("/session", {
      method: "POST",
      body: JSON.stringify({ title: titleParts.join(" - ") })
    });

    const sessionId = session.id ?? session.sessionID;
    if (!sessionId) {
      throw new Error("opencode did not return a session id");
    }

    return sessionId;
  }

  async listModels(): Promise<AgentModelOption[]> {
    const response = await this.request<ProviderResponse>("/provider", { method: "GET" });
    const providers = response.all ?? [];
    const connected = new Set(response.connected ?? []);
    const visibleProviders = connected.size ? providers.filter((provider) => connected.has(provider.id)) : providers;

    return visibleProviders.flatMap((provider) =>
      Object.entries(provider.models ?? {})
        .map(([modelKey, model]) => ({
          id: `${provider.id}/${model.id ?? modelKey}`,
          providerId: provider.id,
          providerName: provider.name ?? provider.id,
          modelId: model.id ?? modelKey,
          modelName: model.name ?? model.id ?? modelKey
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    );
  }

  getModel(): string | undefined {
    return this.selectedModel;
  }

  async setModel(model: string): Promise<void> {
    const normalized = model.trim();
    if (!normalized) {
      throw new Error("Model is required. Use /model to list available models.");
    }

    const models = await this.listModels();
    if (!models.some((option) => option.id === normalized)) {
      throw new Error(`Unknown model: ${normalized}. Use /model to list available models.`);
    }

    this.selectedModel = normalized;
  }

  async sendMessage(sessionId: string, text: string): Promise<AgentReply> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }]
    };

    if (this.config.opencodeAgent) {
      body.agent = this.config.opencodeAgent;
    }
    if (this.selectedModel) {
      const slashIndex = this.selectedModel.indexOf("/");
      if (slashIndex !== -1) {
        body.model = { providerID: this.selectedModel.slice(0, slashIndex), modelID: this.selectedModel.slice(slashIndex + 1) };
      } else {
        body.model = this.selectedModel;
      }
    }

    const response = await this.request<MessageResponse>(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      body: JSON.stringify(body)
    });

    const textParts = response.parts
      ?.filter((part) => part.type !== "reasoning")
      .map((part) => part.text ?? part.content)
      .filter((part): part is string => Boolean(part?.trim())) ?? [];

    return { text: textParts.join("\n\n").trim() || "opencode returned an empty response.", format: "markdown" };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");

    if (init.body) {
      headers.set("content-type", "application/json");
    }
    if (this.authHeader) {
      headers.set("authorization", this.authHeader);
    }

    const url = new URL(`${this.baseUrl}${path}`);
    if (this.config.opencodeDirectory) {
      url.searchParams.set("directory", this.config.opencodeDirectory);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.opencodeRequestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, headers, signal: controller.signal });
      if (!response.ok) {
        const details = sanitizeOpencodeError(await response.text().catch(() => ""));
        throw new Error(`opencode ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`opencode request timed out after ${this.config.opencodeRequestTimeoutMs}ms; check OPENCODE_SERVER_URL and OPENCODE_REQUEST_TIMEOUT_MS`);
      }
      if (error instanceof Error && error.message.startsWith("opencode ")) throw error;
      throw new Error(`opencode request failed: ${sanitizeOpencodeError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sanitizeOpencodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(authorization|password|token)\s*[:=]\s*[^\s,"']+/gi, "$1=[redacted]")
    .slice(0, 500);
}
