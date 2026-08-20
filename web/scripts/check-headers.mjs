/**
 * Assert that a build still ships the security headers it is supposed to.
 *
 * The CSP and the `_headers` file are produced by a Vite plugin, so a config
 * edit, a plugin-ordering change or a dependency bump can drop them without
 * anything else failing. A security control nobody checks is a control that
 * quietly stops existing, so this inspects the built output rather than trusting
 * the intent.
 *
 * It also fails on an inline `<script>`, because that is the usual route to a
 * weakened policy: something appears in the page that needs `'unsafe-inline'`,
 * and the quickest way to silence the console is to grant it.
 *
 * Run after `npm run build`, locally or in CI:
 *
 *   npm run check:headers
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const DIST = resolve(dirname(import.meta.dirname), "dist");

/** Directives that must survive in the `_headers` file. */
const REQUIRED_HEADER_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
];

/** Headers that must be present at all, whatever their value. */
const REQUIRED_HEADERS = [
  "Content-Security-Policy:",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
  "Referrer-Policy:",
  "Strict-Transport-Security:",
];

const failures = [];
const fail = (message) => failures.push(message);

async function read(name) {
  try {
    return await readFile(resolve(DIST, name), "utf8");
  } catch {
    fail(`${name} is missing from dist/ - did the build run?`);
    return null;
  }
}

const headers = await read("_headers");
if (headers) {
  for (const directive of REQUIRED_HEADER_DIRECTIVES) {
    if (!headers.includes(directive)) fail(`_headers no longer contains "${directive}"`);
  }
  for (const header of REQUIRED_HEADERS) {
    if (!headers.includes(header)) fail(`_headers no longer sets "${header}"`);
  }
  if (/unsafe-eval/.test(headers)) fail("_headers grants 'unsafe-eval'");
  // 'unsafe-inline' is expected for style-src (MapLibre writes element.style) but
  // never for script-src, which is the one that matters for XSS.
  const scriptSrc = headers.match(/script-src ([^;]*)/)?.[1] ?? "";
  if (/unsafe-inline/.test(scriptSrc)) fail("_headers grants 'unsafe-inline' to script-src");
}

const html = await read("index.html");
if (html) {
  // The meta tag is what protects GitHub Pages, which cannot serve headers at
  // all. Single quotes arrive HTML-escaped inside the attribute.
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    fail("index.html has no Content-Security-Policy meta tag");
  }
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? "";
  const decoded = meta
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'"]) {
    if (!decoded.includes(directive)) fail(`the meta CSP no longer contains "${directive}"`);
  }

  const inlineScripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    ([, attributes, body]) => !/\ssrc=/.test(attributes) && body.trim(),
  );
  if (inlineScripts.length) {
    fail(`index.html contains ${inlineScripts.length} inline <script>, which the CSP blocks`);
  }
}

if (failures.length) {
  for (const message of failures) {
    // GitHub renders this as an annotation on the run; harmless locally.
    console.error(`::error::${message}`);
  }
  process.exit(1);
}

console.info("security headers present, no inline script");
