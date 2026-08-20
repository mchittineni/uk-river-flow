import { defineConfig } from "vite";
import { cp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, extname, basename } from "node:path";

import { DATA_PREFIX, resolveDataPath } from "./dev-data-route.js";

const WEB_DIR = import.meta.dirname;
const DATA_DIR = resolve(WEB_DIR, "../data");

const CONTENT_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
};

/**
 * Serve and ship the generated `data/` bundle.
 *
 * The data lives outside `web/` so the ingest pipeline and the front end stay
 * independently versioned and reviewable, but it must reach the browser from the
 * *same origin* as the page: same-origin fetches mean no CORS negotiation, no
 * preflight, and no dependency on an upstream API being reachable from a
 * visitor's network at page load. So in dev we alias it, and at build we copy it.
 */
function dataBundle() {
  return {
    name: "data-bundle",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(DATA_PREFIX)) return next();

        // Containment lives in dev-data-route.js, where it is unit-tested.
        const { status, path, pathname } = resolveDataPath(request.url, DATA_DIR);
        if (status !== 200) {
          response.statusCode = status;
          return response.end(status === 403 ? "forbidden" : "bad request");
        }

        response.setHeader("Content-Type", CONTENT_TYPES[extname(path)] ?? "application/octet-stream");
        // Nothing here is HTML, and saying so costs one header.
        response.setHeader("X-Content-Type-Options", "nosniff");
        createReadStream(path)
          .on("error", () => {
            response.statusCode = 404;
            response.end(`not found: ${pathname} - run the ingest pipeline first`);
          })
          .pipe(response);
      });
    },

    async closeBundle() {
      if (this.environment?.name && this.environment.name !== "client") return;
      try {
        await stat(DATA_DIR);
      } catch {
        this.warn(
          "data/ not found - run `python3 pipeline/ingest_uk.py` before building, " +
            "or the deployed site will have nothing to show.",
        );
        return;
      }
      await cp(DATA_DIR, resolve(WEB_DIR, "dist/data"), {
        recursive: true,
        // Skip dotfiles. `data/` picks up OS and editor droppings — .DS_Store
        // most often — and a recursive copy would publish them: they were
        // reaching the deployed site, where a directory-metadata file is junk at
        // best and a listing of names nobody chose to publish at worst.
        //
        // `upload-pages-artifact` v4+ drops them from the artifact anyway, so
        // filtering here keeps the local build, the preview and the deployed
        // site showing the same tree instead of three slightly different ones.
        filter: (source) => !basename(source).startsWith("."),
      });
    },
  };
}

/**
 * The only third-party origins the page is allowed to talk to.
 *
 * Both are keyless public services (see docs/adr/0002): OpenFreeMap serves the
 * basemap style, its glyphs, sprites and vector tiles; the AWS Open Data bucket
 * serves terrarium-encoded elevation for the optional 3D terrain.
 */
const TILE_ORIGIN = "https://tiles.openfreemap.org";
const TERRAIN_ORIGIN = "https://s3.amazonaws.com";

/**
 * Content Security Policy for the built site.
 *
 * Notes on the two directives that look loose:
 *
 *   `style-src 'unsafe-inline'` — MapLibre positions every marker, control and
 *   popup by writing to `element.style`, and CSP counts a style *attribute* as
 *   inline style. There is no nonce mechanism for attributes, so the alternative
 *   is not a tighter policy, it is a broken map.
 *
 *   `worker-src blob:` — MapLibre compiles its tile workers from a Blob URL.
 *
 * Everything else is closed: no inline script, no `eval`, no plugins, no framing,
 * no form posts, and no base-tag rewriting of relative URLs.
 */
const CSP_DIRECTIVES = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "worker-src": ["'self'", "blob:"],
  // Retained for browsers that predate worker-src and fall back to child-src.
  "child-src": ["'self'", "blob:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", TILE_ORIGIN, TERRAIN_ORIGIN],
  "connect-src": ["'self'", TILE_ORIGIN, TERRAIN_ORIGIN],
  "font-src": ["'self'", "data:"],
  "manifest-src": ["'self'"],
  "base-uri": ["'none'"],
  "object-src": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
};

const csp = (directives) =>
  Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

/**
 * Ship the security headers with the build.
 *
 * A static site has no server to set headers on, so this emits both forms and
 * lets the host use whichever it understands:
 *
 *   * a `<meta http-equiv>` CSP, which works everywhere including GitHub Pages;
 *   * a `_headers` file, which Cloudflare Pages (the host README recommends)
 *     turns into real response headers.
 *
 * Both are generated from `CSP_DIRECTIVES` above so they cannot drift apart. The
 * meta form drops `frame-ancestors`, which browsers ignore outside a real header —
 * `_headers` carries it, plus `X-Frame-Options` for the same job.
 *
 * Applied at build only: Vite's dev server needs inline scripts and a websocket
 * for HMR, and the way that usually gets "fixed" is by loosening the policy that
 * ships to production.
 */
function securityHeaders() {
  // Directives a `<meta http-equiv>` policy is not allowed to carry: browsers
  // parse the tag but ignore these, so listing them there reads as protection
  // that is not actually in force.
  const HEADER_ONLY = new Set(["frame-ancestors", "report-uri", "sandbox"]);
  const metaDirectives = Object.fromEntries(
    Object.entries(CSP_DIRECTIVES).filter(([name]) => !HEADER_ONLY.has(name)),
  );

  return {
    name: "security-headers",
    apply: "build",

    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: csp(metaDirectives) },
          injectTo: "head-prepend",
        },
      ];
    },

    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: [
          "/*",
          `  Content-Security-Policy: ${csp(CSP_DIRECTIVES)}`,
          "  X-Content-Type-Options: nosniff",
          "  X-Frame-Options: DENY",
          "  Referrer-Policy: no-referrer",
          // No camera, microphone or location is ever requested. MapLibre's
          // geolocate control asks the browser directly and degrades if refused.
          "  Permissions-Policy: accelerometer=(), camera=(), geolocation=(self), gyroscope=(), microphone=(), payment=(), usb=()",
          "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
          "  Cross-Origin-Opener-Policy: same-origin",
          "  Cross-Origin-Resource-Policy: same-origin",
          "",
          // The bundle is regenerated several times a day and served under a
          // content hash, so the JSON must revalidate while the assets need not.
          "/data/*",
          "  Cache-Control: public, max-age=300, must-revalidate",
          "",
          "/assets/*",
          "  Cache-Control: public, max-age=31536000, immutable",
          "",
        ].join("\n"),
      });
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so one build works at a domain root (Cloudflare Pages)
  // and under a /repo-name/ prefix (GitHub Pages) with no rebuild.
  base: "./",
  plugins: [dataBundle(), securityHeaders()],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        // MapLibre is ~90% of the bundle and changes rarely; splitting it means a
        // data or UI change does not invalidate a ~900 KB cached chunk.
        manualChunks: { maplibre: ["maplibre-gl"] },
      },
    },
  },
});
