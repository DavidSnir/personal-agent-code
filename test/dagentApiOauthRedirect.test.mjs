import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOAuthRedirectHost } from "../dist/services/cli-api/src/dagentApiService.js";

test("OAuth redirect host uses localhost instead of unspecified bind address", () => {
  assert.equal(normalizeOAuthRedirectHost("0.0.0.0:7331"), "127.0.0.1:7331");
  assert.equal(normalizeOAuthRedirectHost("0.0.0.0"), "127.0.0.1");
  assert.equal(normalizeOAuthRedirectHost("example.test:7331"), "example.test:7331");
});
