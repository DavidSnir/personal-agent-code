import assert from "node:assert/strict";
import test from "node:test";

import { renderWhatsappQr } from "../dist/services/cli-api/src/whatsapp/whatsappControlService.js";

test("WhatsApp QR rendering works with qrcode-terminal dynamic import", async () => {
  const payload = "test-whatsapp-qr-payload";
  const output = renderWhatsappQr(payload);

  assert.match(output, /\S/);
  assert.equal(output.includes(payload), false);
});
