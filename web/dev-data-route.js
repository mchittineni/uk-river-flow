/**
 * Resolve a `/data/...` dev-server request to a file on disk.
 *
 * Extracted from the Vite plugin so the containment rule is a tested invariant
 * rather than four lines of middleware nobody exercises. It is the only thing
 * standing between `npm run dev` and the rest of the filesystem, and the dev
 * server is reachable from the network the moment anyone runs it with `--host`.
 *
 * Pure, and takes `dataDir` as an argument, so a test can drive it with POSIX
 * paths on any platform.
 */

import { normalize, join, sep } from "node:path";

export const DATA_PREFIX = "/data/";

/**
 * @param {string} rawUrl A raw request target, query and fragment included.
 * @param {string} dataDir Absolute path of the directory being served.
 * @returns {{status: number, path?: string, pathname: string}} `status` is 200
 *   with a resolved `path`, or the status to reject with.
 */
export function resolveDataPath(rawUrl, dataDir) {
  let pathname = rawUrl;
  let relative;

  try {
    // Parse rather than slice: a raw target still carries `?v=2` and `#frag`, and
    // handing those to the filesystem turns a valid request into a 404.
    //
    // The parser also resolves `..` segments per RFC 3986, so the prefix must be
    // re-checked below rather than assumed — `/data/../data-private/x` arrives
    // here as `/data-private/x`, and blindly slicing six characters off that
    // yields `vate/x`, a path that looks contained and is not the file anyone
    // asked for.
    pathname = new URL(rawUrl, "http://localhost").pathname;
    if (!pathname.startsWith(DATA_PREFIX)) return { status: 403, pathname };

    // Decode *after* the prefix check and *before* normalising. `%2e%2e%2f` is a
    // single opaque segment to the URL parser, so it survives to here intact;
    // normalize() cannot see the `../` inside it until it has been decoded.
    relative = decodeURIComponent(pathname.slice(DATA_PREFIX.length));
  } catch {
    // A malformed percent-escape throws in decodeURIComponent.
    return { status: 400, pathname };
  }

  // fs throws synchronously on a NUL byte, which in middleware means the dev
  // server dies instead of answering.
  if (relative.includes("\0")) return { status: 400, pathname };

  const target = normalize(join(dataDir, relative));

  // `startsWith(dataDir)` is a prefix test, not a containment test: it also
  // accepts any *sibling* whose name merely begins with the same characters, so
  // `/data/../data-private/secrets.env` normalises to `<repo>/data-private/
  // secrets.env` and sails straight through. Requiring the separator — or an
  // exact match on the directory itself — pins the result inside the tree.
  if (target !== dataDir && !target.startsWith(dataDir + sep)) {
    return { status: 403, pathname };
  }

  return { status: 200, path: target, pathname };
}
