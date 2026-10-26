import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { isWahaWebhookEventType, type WahaWebhookEventType } from "../../../whatsapp/src/whatsapp/repository.js";

export const WAHA_WEBHOOK_BODY_LIMIT = 1024 * 1024;

export type ValidatedWahaWebhook = {
  id: string;
  event: WahaWebhookEventType;
  session: "default";
  payload: Record<string, unknown>;
  envelope: Record<string, unknown>;
};

export async function readRawBody(request: IncomingMessage, limit = WAHA_WEBHOOK_BODY_LIMIT): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new WebhookBodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

export function verifyWahaWebhookHmac(rawBody: Buffer, header: string | string[] | undefined, secret: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return false;
  const provided = Buffer.from(value, "hex");
  const expected = createHmac("sha512", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function parseWahaWebhook(rawBody: Buffer): ValidatedWahaWebhook {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    throw new Error("Webhook body must be valid JSON encoded as UTF-8");
  }
  if (!isRecord(value)) throw new Error("Webhook body must be an object");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const session = typeof value.session === "string" ? value.session.trim() : "";
  const event = typeof value.event === "string" ? value.event.trim() : "";
  if (!id) throw new Error("Webhook event id is required");
  if (session !== "default") throw new Error("Webhook session must be default");
  if (!isWahaWebhookEventType(event)) throw new Error("Webhook event type is not subscribed");
  const payload = isRecord(value.payload) ? value.payload : {};
  return { id, session, event, payload, envelope: value };
}

export class WebhookBodyTooLargeError extends Error {
  constructor() {
    super("Webhook body too large");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
