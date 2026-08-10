import { defineConfig } from "vite";
import { cp, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, normalize, join } from "node:path";

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
        if (!request.url?.startsWith("/data/")) return next();

        // Resolve then verify containment: without this check a request for
        // /data/../../.ssh/id_rsa would escape the data directory.
        const target = normalize(join(DATA_DIR, request.url.slice("/data/".length)));
        if (!target.startsWith(DATA_DIR)) {
          response.statusCode = 403;
          return response.end("forbidden");
        }

        const extension = target.slice(target.lastIndexOf("."));
        response.setHeader("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
        createReadStream(target)
          .on("error", () => {
            response.statusCode = 404;
            response.end(`not found: ${request.url} - run the ingest pipeline first`);
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
      await cp(DATA_DIR, resolve(WEB_DIR, "dist/data"), { recursive: true });
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so one build works at a domain root (Cloudflare Pages)
  // and under a /repo-name/ prefix (GitHub Pages) with no rebuild.
  base: "./",
  plugins: [dataBundle()],
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
