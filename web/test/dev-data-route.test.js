/**
 * Dev-server path containment.
 *
 * These are the tests for a security boundary, so they are written as attacks
 * rather than as examples. The `data-private` case is the one that matters: the
 * obvious `startsWith(DATA_DIR)` check passes it, because a prefix test happily
 * accepts a *sibling* directory whose name begins with the same characters.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDataPath } from "../dev-data-route.js";

const DATA_DIR = "/repo/data";

const status = (url) => resolveDataPath(url, DATA_DIR).status;

test("serves a file inside the data directory", () => {
  const result = resolveDataPath("/data/v1/meta.json", DATA_DIR);
  assert.equal(result.status, 200);
  assert.equal(result.path, "/repo/data/v1/meta.json");
});

test("strips the query and fragment before touching the filesystem", () => {
  // A cache-buster is not part of the filename; treating it as one is a 404 on a
  // file that is sitting right there.
  assert.equal(resolveDataPath("/data/v1/meta.json?v=2", DATA_DIR).path, "/repo/data/v1/meta.json");
  assert.equal(resolveDataPath("/data/v1/meta.json#top", DATA_DIR).path, "/repo/data/v1/meta.json");
});

test("rejects a classic dot-dot escape", () => {
  assert.equal(status("/data/../../.ssh/id_rsa"), 403);
  assert.equal(status("/data/v1/../../../etc/passwd"), 403);
});

test("rejects a percent-encoded escape", () => {
  // Undecoded, these normalise to a harmless literal filename and the containment
  // check never sees a traversal at all.
  assert.equal(status("/data/%2e%2e%2f%2e%2e%2fetc/passwd"), 403);
  assert.equal(status("/data/..%2f..%2fetc/passwd"), 403);
});

test("rejects a sibling directory that merely shares the prefix", () => {
  // The regression this file exists for: `/repo/data-private` starts with
  // `/repo/data`, so a naive prefix test serves it.
  assert.equal(status("/data/../data-private/secrets.env"), 403);
  assert.equal(status("/data/../database.yml"), 403);
});

test("rejects a NUL byte instead of letting fs throw", () => {
  // fs throws synchronously on these, which inside middleware kills the server.
  assert.equal(status("/data/v1/meta.json%00.png"), 400);
});

test("rejects a malformed percent-escape", () => {
  assert.equal(status("/data/%E0%A4%A"), 400);
});

test("allows the data directory itself", () => {
  assert.equal(resolveDataPath("/data/", DATA_DIR).status, 200);
});

test("a filename containing dots is not mistaken for a traversal", () => {
  assert.equal(resolveDataPath("/data/v1/..keep.json", DATA_DIR).status, 200);
  assert.equal(resolveDataPath("/data/v1/a..b.json", DATA_DIR).path, "/repo/data/v1/a..b.json");
});
