import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import type { WhatsappConfig } from "../whatsapp/config.js";
import { isWhatsappMessageStatus, toScheduledMessageSummary, WhatsappRepository, WHATSAPP_MESSAGE_STATUSES } from "../whatsapp/repository.js";

const RECURRENCE_UNITS = ["minutes", "hours", "days"] as const;
type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

const RECURRENCE_UNIT_MS: Record<RecurrenceUnit, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000
};

const dateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T/, "Expected an ISO date-time")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date-time");

export async function runWhatsappMcpServer(config: WhatsappConfig): Promise<void> {
  const { repository, server } = createWhatsappMcpServer(config);
  const transport = new StdioServerTransport();
  process.on("SIGINT", () => {
    repository.close();
    void server.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    repository.close();
    void server.close().finally(() => process.exit(0));
  });
  await server.connect(transport);
}

export async function runWhatsappHttpMcpServer(config: WhatsappConfig, options: { hostname: string; port: number; path: string }): Promise<void> {
  const httpServer = createServer((request, response) => void handleMcpHttpRequest(request, response, config, options.path));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.hostname, () => {
      httpServer.off("error", reject);
      console.error(`WhatsApp MCP listening on http://${options.hostname}:${options.port}${options.path}`);
      resolve();
    });
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createWhatsappMcpServer(config: WhatsappConfig): { repository: WhatsappRepository; server: McpServer } {
  const repository = new WhatsappRepository(config.dbPath);
  repository.initialize();
  const server = new McpServer({ name: "personal-agent-whatsapp", version: "0.1.0" });

  server.registerTool(
    "whatsapp_schedule_message",
    {
      title: "Schedule WhatsApp Message",
      description:
        "Schedule a one-shot or recurring WhatsApp message to an exact cached recipient display name. For recurrence, provide all of recurrenceEvery, recurrenceUnit, and recurrenceEndAt. Missing or ambiguous names are rejected.",
      inputSchema: {
        recipientName: z.string().min(1),
        message: z.string().min(1),
        sendAt: dateTimeSchema,
        recurrenceEvery: z.number().int().positive().optional(),
        recurrenceUnit: z.enum(RECURRENCE_UNITS).optional(),
        recurrenceEndAt: dateTimeSchema.optional()
      }
    },
    (args) => {
      const recipientName = args.recipientName.trim();
      const message = args.message.trim();
      const scheduledAtMs = Date.parse(args.sendAt);
      if (!recipientName) {
        return jsonResult({ ok: false, error: "recipientName is required" });
      }
      if (!message) {
        return jsonResult({ ok: false, error: "message is required" });
      }
      if (Number.isNaN(scheduledAtMs)) {
        return jsonResult({ ok: false, error: "sendAt must be a valid ISO date-time" });
      }
      const recurrence = parseWhatsappRecurrence({
        sendAtMs: scheduledAtMs,
        recurrenceEvery: args.recurrenceEvery,
        recurrenceUnit: args.recurrenceUnit,
        recurrenceEndAt: args.recurrenceEndAt
      });
      if (!recurrence.ok) {
        return jsonResult({ ok: false, error: recurrence.error });
      }

      const resolution = repository.resolveExactRecipientName(recipientName);
      if (!resolution.ok) {
        return jsonResult({ ok: false, error: `recipient ${resolution.reason}`, requestedName: resolution.requestedName, candidates: resolution.candidates });
      }

      const scheduled = repository.scheduleMessage({
        recipientName: resolution.canonicalName,
        recipientChatId: resolution.contact.chatId,
        message,
        scheduledAtMs,
        recurrenceIntervalMs: recurrence.recurrence?.intervalMs,
        recurrenceEndAtMs: recurrence.recurrence?.endAtMs
      });
      return jsonResult({ ok: true, scheduled: toScheduledMessageSummary(scheduled), requestedName: resolution.requestedName, canonicalName: resolution.canonicalName });
    }
  );

  server.registerTool(
    "whatsapp_find_recipients",
    {
      title: "Find WhatsApp Recipients",
      description: "Search cached WhatsApp recipient display names for discovery only. Use exact display names when scheduling.",
      inputSchema: {
        query: z.string().min(1),
        includeGroups: z.boolean().optional(),
        limit: z.number().int().positive().max(50).optional()
      }
    },
    (args) => jsonResult({ ok: true, recipients: repository.findRecipients(args.query, { includeGroups: args.includeGroups ?? true, limit: args.limit ?? 10 }) })
  );

  server.registerTool(
    "whatsapp_list_scheduled_messages",
    {
      title: "List Scheduled WhatsApp Messages",
      description: "List scheduled WhatsApp messages with private message bodies reduced to previews.",
      inputSchema: {
        status: z.enum(WHATSAPP_MESSAGE_STATUSES).optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    (args) => jsonResult({ ok: true, messages: repository.listScheduledMessages({ status: args.status, limit: args.limit ?? 25 }) })
  );

  server.registerTool(
    "whatsapp_cancel_scheduled_message",
    {
      title: "Cancel Scheduled WhatsApp Message",
      description: "Cancel a pending or failed WhatsApp scheduled message by ID.",
      inputSchema: { id: z.number().int().positive() }
    },
    (args) => {
      const cancelled = repository.markCancelled(args.id);
      return cancelled ? jsonResult({ ok: true, cancelled }) : jsonResult({ ok: false, error: "Message was not found or cannot be cancelled" });
    }
  );

  server.registerTool(
    "whatsapp_status",
    {
      title: "WhatsApp Status",
      description: "Return non-secret WhatsApp cache, schedule, and worker status. Does not include session data or full messages."
    },
    () => jsonResult({ ...repository.getStatus(config), session: repository.getWahaSession(), webhookInbox: repository.getWebhookCounts() })
  );

  return { repository, server };
}

async function handleMcpHttpRequest(request: IncomingMessage, response: ServerResponse, config: WhatsappConfig, path: string): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
    return;
  }
  if (url.pathname !== path) {
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}\n');
    return;
  }
  if (request.method !== "POST") {
    response
      .writeHead(405, { "content-type": "application/json" })
      .end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}\n');
    return;
  }

  const { repository, server } = createWhatsappMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    repository.close();
    void transport.close();
    void server.close();
  };
  response.once("close", cleanup);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    console.error("Error handling WhatsApp MCP request:", error instanceof Error ? error.message : String(error));
    if (!response.headersSent) {
      response
        .writeHead(500, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}\n');
    }
  } finally {
    if (response.writableEnded || response.destroyed) cleanup();
  }
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function parseWhatsappRecurrence(input: {
  sendAtMs: number;
  recurrenceEvery?: number;
  recurrenceUnit?: RecurrenceUnit;
  recurrenceEndAt?: string;
}): { ok: true; recurrence?: { intervalMs: number; endAtMs: number } } | { ok: false; error: string } {
  const providedCount = [input.recurrenceEvery, input.recurrenceUnit, input.recurrenceEndAt].filter((value) => value !== undefined).length;
  if (providedCount === 0) {
    return { ok: true };
  }
  if (providedCount !== 3) {
    return { ok: false, error: "recurrenceEvery, recurrenceUnit, and recurrenceEndAt must be provided together" };
  }
  const recurrenceEvery = input.recurrenceEvery;
  const recurrenceUnit = input.recurrenceUnit;
  const recurrenceEndAt = input.recurrenceEndAt;
  if (recurrenceEvery === undefined || !Number.isInteger(recurrenceEvery) || recurrenceEvery <= 0) {
    return { ok: false, error: "recurrenceEvery must be a positive integer" };
  }
  if (!recurrenceUnit || !(RECURRENCE_UNITS as readonly string[]).includes(recurrenceUnit)) {
    return { ok: false, error: "recurrenceUnit must be one of minutes, hours, or days" };
  }
  if (!recurrenceEndAt) {
    return { ok: false, error: "recurrenceEndAt must be a valid ISO date-time" };
  }
  const endAtMs = Date.parse(recurrenceEndAt);
  if (Number.isNaN(endAtMs)) {
    return { ok: false, error: "recurrenceEndAt must be a valid ISO date-time" };
  }
  if (endAtMs < input.sendAtMs) {
    return { ok: false, error: "recurrenceEndAt must be at or after sendAt" };
  }
  return { ok: true, recurrence: { intervalMs: recurrenceEvery * RECURRENCE_UNIT_MS[recurrenceUnit], endAtMs } };
}

export const whatsappMcpServerTestHooks = {
  isWhatsappMessageStatus,
  parseWhatsappRecurrence
};
