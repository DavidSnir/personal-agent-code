import { setTimeout as delay } from "node:timers/promises";
import type { AppService } from "../../../../shared/service/appService.js";
import type { AgentModelOption, AgentService } from "./opencodeTelegramAgent.js";

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id: string;
  from: { id: number };
  message?: {
    chat: { id: number };
    message_id: number;
    text?: string;
  };
  data?: string;
};

type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

type ModelSelectionResult = {
  text: string;
  keyboard: TelegramInlineKeyboardMarkup;
  modelIds: string[];
};

type TelegramMessage = {
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
  };
  from?: { id: number };
  text?: string;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

type TelegramParseMode = "Markdown";

type FatalHandler = (error: Error) => void;
type RetryDelay = (milliseconds: number, signal: AbortSignal) => Promise<void>;

type TypingMaintenance = {
  controller: AbortController;
  completion: Promise<void>;
};

type TelegramConnectionServiceOptions = {
  token: string;
  allowedUserId: number;
  agent: AgentService;
  onFatal: FatalHandler;
  retryDelay?: RetryDelay;
  typingRefreshDelay?: RetryDelay;
};

const POLL_RETRY_BASE_DELAY_MS = 1000;
const POLL_RETRY_MAX_DELAY_MS = 30_000;
const TYPING_REFRESH_DELAY_MS = 4_000;

class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

export class TelegramConnectionService implements AppService {
  readonly name = "telegram";

  private readonly apiUrl: string;
  private readonly sessions = new Map<number, string>();
  private offset = 0;
  private polling?: Promise<void>;
  private stopping = false;
  private currentPoll?: AbortController;
  private currentDelay?: AbortController;
  private currentTyping?: TypingMaintenance;
  private readonly retryDelay: RetryDelay;
  private readonly typingRefreshDelay: RetryDelay;

  constructor(private readonly options: TelegramConnectionServiceOptions) {
    this.apiUrl = `https://api.telegram.org/bot${options.token}`;
    this.retryDelay = options.retryDelay ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    this.typingRefreshDelay = options.typingRefreshDelay ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }

  async start(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.stopping = false;
    const polling = this.poll();
    this.polling = polling;
    void polling.then(
      () => {
        if (!this.stopping && this.polling === polling) {
          this.options.onFatal(new Error("Telegram polling stopped unexpectedly."));
        }
      },
      (error: unknown) => {
        if (!this.stopping && this.polling === polling) {
          this.options.onFatal(error instanceof Error ? error : new Error(`Telegram polling failed: ${String(error)}`));
        }
      }
    );
    console.log("Personal Agent Telegram bot started with long polling.");
  }

  async stop(): Promise<void> {
    if (!this.polling) {
      return;
    }

    this.stopping = true;
    this.currentPoll?.abort();
    this.currentDelay?.abort();
    if (this.currentTyping) {
      await this.stopTyping(this.currentTyping);
    }
    try {
      await this.polling;
    } catch {
      // The app runner is already handling the fatal polling error; stop still needs to finish cleanup.
    } finally {
      this.polling = undefined;
    }
  }

  private async poll(): Promise<void> {
    let consecutiveFailures = 0;

    while (!this.stopping) {
      let updates: TelegramUpdate[];
      try {
        this.currentPoll = new AbortController();
        updates = await this.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ["message", "callback_query"]
          },
          this.currentPoll.signal
        );
        this.currentPoll = undefined;
      } catch (error) {
        this.currentPoll = undefined;
        if (this.stopping) {
          break;
        }

        if (isUnrecoverablePollingError(error)) {
          throw error;
        }

        consecutiveFailures += 1;
        const retryDelayMs = pollRetryDelayMs(consecutiveFailures);
        console.error(
          `Telegram getUpdates failed; retrying in ${retryDelayMs} ms (attempt ${consecutiveFailures}): ${this.safeErrorMessage(error)}`
        );
        try {
          this.currentDelay = new AbortController();
          await this.retryDelay(retryDelayMs, this.currentDelay.signal);
        } catch {
          // Stop aborts the retry delay so shutdown is not held by backoff.
        } finally {
          this.currentDelay = undefined;
        }
        continue;
      }

      consecutiveFailures = 0;
      for (const update of updates) {
        if (this.stopping) {
          break;
        }

        this.offset = Math.max(this.offset, update.update_id + 1);
        try {
          await this.handleUpdate(update);
        } catch (error) {
          // Update failures must not escape into getUpdates retry handling.
          console.error(`Telegram update ${update.update_id} failed: ${this.safeErrorMessage(error)}`);
        }
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      this.offset = Math.max(this.offset, update.update_id + 1);
      return;
    }

    const message = update.message;
    if (!message) {
      return;
    }

    const chatId = message.chat.id;
    const text = message.text?.trim();

    try {
      if (message.from?.id !== this.options.allowedUserId) {
        await this.sendMessage(chatId, "Access denied.");
        return;
      }

      if (!text) {
        return;
      }

      if (text === "/start") {
        await this.sendMessage(chatId, "Personal Agent is ready. Send text to forward it to opencode, or use /new to start a fresh opencode session.");
        return;
      }

      if (text === "/health") {
        const health = await this.options.agent.health();
        const version = health.version ? `\nversion: ${health.version}` : "";
        await this.sendMessage(chatId, `${this.options.agent.displayName} healthy: ${health.healthy}${version}`);
        return;
      }

      if (text === "/new") {
        const sessionId = await this.options.agent.createSession(chatId);
        this.sessions.set(chatId, sessionId);
        await this.sendMessage(chatId, `Started a new ${this.options.agent.displayName} session: ${sessionId}`);
        return;
      }

      if (text === "/model") {
        const models = await this.options.agent.listModels();
        const selection = buildModelSelection(models, this.options.agent.getModel());
        await this.sendMessageWithKeyboard(chatId, selection.text, selection.keyboard);
        return;
      }

      if (text.startsWith("/model ")) {
        const arg = text.slice("/model ".length).trim();
        const num = Number(arg);
        if (Number.isSafeInteger(num) && num > 0) {
          const models = await this.options.agent.listModels();
          const index = num - 1;
          if (index >= 0 && index < models.length) {
            await this.options.agent.setModel(models[index].id);
            await this.sendMessage(chatId, `${this.options.agent.displayName} model set to ${this.options.agent.getModel() ?? models[index].id}`);
            return;
          }
          await this.sendMessage(chatId, `Invalid model number ${num}. Use /model to list available models.`);
          return;
        }
        await this.options.agent.setModel(arg);
        await this.sendMessage(chatId, `${this.options.agent.displayName} model set to ${this.options.agent.getModel() ?? arg}`);
        return;
      }

      if (text.startsWith("/")) {
        await this.sendMessage(chatId, "Unknown command. Available commands: /start, /health, /new, /model");
        return;
      }

      const typing = message.chat.type === "private" || message.chat.type === "group" || message.chat.type === "supergroup"
        ? await this.startTyping(chatId)
        : undefined;
      let reply: Awaited<ReturnType<AgentService["sendMessage"]>>;
      try {
        const sessionId = await this.getOrCreateSession(chatId);
        reply = await this.options.agent.sendMessage(sessionId, text);
      } finally {
        if (typing) {
          await this.stopTyping(typing);
        }
      }
      await this.sendMessage(chatId, reply.text, reply.format === "markdown" ? "Markdown" : undefined);
    } catch (error) {
      console.error(`Update handling failed: ${this.safeErrorMessage(error)}`);
      try {
        await this.sendMessage(chatId, `Error: ${this.safeErrorMessage(error)}`);
      } catch (reportError) {
        console.error(`Failed to send Telegram update error response: ${this.safeErrorMessage(reportError)}`);
      }
    }
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (query.from?.id !== this.options.allowedUserId) {
      await this.answerCallbackQuery(query.id, "Access denied.");
      return;
    }

    const data = query.data ?? "";
    if (!data.startsWith("ms:")) {
      await this.answerCallbackQuery(query.id, "Unknown action.");
      return;
    }

    const modelId = data.slice(3);
    try {
      await this.options.agent.setModel(modelId);
      const displayName = this.options.agent.getModel() ?? modelId;
      await this.answerCallbackQuery(query.id, `Model set to ${displayName}`);

      if (query.message) {
        const models = await this.options.agent.listModels();
        const selection = buildModelSelection(models, this.options.agent.getModel());
        await this.editMessageTextAndKeyboard(
          query.message.chat.id,
          query.message.message_id,
          selection.text,
          selection.keyboard
        );
      }
    } catch (error) {
      console.error(`Callback handling failed: ${this.safeErrorMessage(error)}`);
      try {
        await this.answerCallbackQuery(query.id, `Error: ${this.safeErrorMessage(error)}`);
      } catch (reportError) {
        console.error(`Failed to send Telegram callback error response: ${this.safeErrorMessage(reportError)}`);
      }
    }
  }

  private async getOrCreateSession(chatId: number): Promise<string> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }

    const sessionId = await this.options.agent.createSession(chatId);
    this.sessions.set(chatId, sessionId);
    return sessionId;
  }

  private async startTyping(chatId: number): Promise<TypingMaintenance> {
    const controller = new AbortController();
    let markInitialComplete!: () => void;
    const initialComplete = new Promise<void>((resolve) => {
      markInitialComplete = resolve;
    });
    const completion = this.maintainTyping(chatId, controller.signal, markInitialComplete).catch((error) => {
      if (!controller.signal.aborted) {
        console.error(`Telegram typing maintenance failed: ${this.safeErrorMessage(error)}`);
      }
    });
    const maintenance = { controller, completion };
    this.currentTyping = maintenance;
    await initialComplete;
    return maintenance;
  }

  private async maintainTyping(
    chatId: number,
    signal: AbortSignal,
    markInitialComplete: () => void
  ): Promise<void> {
    try {
      await this.sendTyping(chatId, signal);
    } finally {
      markInitialComplete();
    }

    while (!signal.aborted) {
      try {
        await this.typingRefreshDelay(TYPING_REFRESH_DELAY_MS, signal);
      } catch (error) {
        if (!signal.aborted) {
          console.error(`Telegram typing refresh delay failed: ${this.safeErrorMessage(error)}`);
        }
        return;
      }

      if (!signal.aborted) {
        await this.sendTyping(chatId, signal);
      }
    }
  }

  private async sendTyping(chatId: number, signal: AbortSignal): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" }, signal);
    } catch (error) {
      if (!signal.aborted) {
        console.error(`Telegram sendChatAction failed: ${this.safeErrorMessage(error)}`);
      }
    }
  }

  private async stopTyping(maintenance: TypingMaintenance): Promise<void> {
    maintenance.controller.abort();
    await maintenance.completion;
    if (this.currentTyping === maintenance) {
      this.currentTyping = undefined;
    }
  }

  private async sendMessage(chatId: number, text: string, parseMode?: TelegramParseMode): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) {
      await this.call("sendMessage", { chat_id: chatId, text: chunk, ...(parseMode ? { parse_mode: parseMode } : {}) });
    }
  }

  private async sendMessageWithKeyboard(chatId: number, text: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
  }

  private async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
  }

  private async editMessageTextAndKeyboard(chatId: number, messageId: number, text: string, replyMarkup: TelegramInlineKeyboardMarkup): Promise<void> {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: replyMarkup });
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.apiUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal
    });

    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new TelegramApiError(method, payload.error_code ?? response.status, payload.description ?? response.statusText);
    }

    return payload.result as T;
  }

  private safeErrorMessage(error: unknown): string {
    const code = findErrorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    const summary = code && !message.includes(code) ? `${code}: ${message}` : message;
    return sanitizeErrorMessage(summary, this.options.token);
  }
}

export function buildModelSelection(models: AgentModelOption[], currentModel: string | undefined): ModelSelectionResult {
  if (!models.length) {
    return {
      text: "No opencode models are available from the current providers.",
      keyboard: { inline_keyboard: [] },
      modelIds: []
    };
  }

  const modelIds = models.map((m) => m.id);
  const current = currentModel ? `Current model: ${currentModel}` : "Current model: opencode default";
  const lines = [current, "", "Available models:"];
  const keyboard: TelegramInlineKeyboardButton[][] = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const num = i + 1;
    const label = model.modelName !== model.modelId ? model.modelName : model.modelId;
    lines.push(`${num}. ${model.modelName !== model.modelId ? `${model.modelName} (${model.id})` : model.id}`);
    keyboard.push([{ text: `${num}. ${label}`, callback_data: `ms:${model.id}` }]);
  }

  lines.push("", "Select a model below or send /model <number>.");

  return {
    text: lines.join("\n"),
    keyboard: { inline_keyboard: keyboard },
    modelIds
  };
}

function isUnrecoverablePollingError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.method !== "getUpdates") {
    return false;
  }

  return error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409;
}

function pollRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 5);
  return Math.min(POLL_RETRY_MAX_DELAY_MS, POLL_RETRY_BASE_DELAY_MS * 2 ** exponent);
}

function findErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function sanitizeErrorMessage(message: string, token: string): string {
  const withoutToken = token ? message.split(token).join("[redacted]") : message;
  return withoutToken
    .replace(/https?:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot[redacted]")
    .replace(/\s+/g, " ")
    .trim() || "Unknown error";
}

function splitTelegramMessage(text: string): string[] {
  const limit = 4096;
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }

  return chunks.length ? chunks : [""];
}
