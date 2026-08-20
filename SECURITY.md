# Security policy

## What this project is

A static site and a scheduled data pipeline. There is no server, no database, no
user accounts, no authentication, no cookies and no analytics. It stores nothing
about visitors, and it holds no secrets — every upstream API it uses is keyless and
public, which is a deliberate design property, not an accident.

That narrows the realistic attack surface considerably, but it does not eliminate it.

## In scope

- **Supply chain**: a malicious or compromised npm dependency, or a compromised
  GitHub Action. npm dependencies are pinned via lockfile; every Action is pinned to
  a full commit SHA rather than a movable tag, so a retagged release cannot change
  what runs; Dependabot watches both.
- **Workflow injection**: a GitHub Actions workflow interpolating untrusted event
  data into a shell. The workflows here deliberately avoid it, and each carries a
  comment saying so; a case we missed is a valid report.
- **Content Security Policy**: the built page ships a CSP that allows script only
  from its own origin and network access only to the two keyless services it needs.
  A way to load or execute script from anywhere else is a valid report. The policy
  is generated in `web/vite.config.js` and asserted after every build by
  `web/scripts/check-headers.mjs`.
- **Dev-server path traversal**: `npm run dev` serves `data/` through a Vite
  middleware. A request that escapes that directory is a valid report — the
  containment rule lives in `web/dev-data-route.js` and is unit-tested.
- **Cross-site scripting**: the front end renders third-party open data (station and
  river names). The UI is built entirely through `web/src/dom.js`, which routes all
  text through `textContent` — `innerHTML` is not used anywhere. A path that reaches
  the DOM as markup is a valid report.
- **Excessive permissions**: any workflow whose `permissions:` block is broader than
  its job needs.
- **Data integrity**: a way to make the pipeline publish values that misrepresent the
  upstream source, bypassing `pipeline/validate_data.py`.

## Out of scope

- Vulnerabilities in the upstream data providers. Report those to them.
- Availability of free third-party services (tile hosts, Overpass, the data APIs).
- Anything requiring write access to this repository to exploit.

### A note on headers

Security headers used to be listed here as out of scope, on the grounds that a
static host will not let us set them. That was half right, and the half that was
wrong mattered: GitHub Pages serves no custom headers, but a `<meta http-equiv>`
CSP works there, and Cloudflare Pages — the host this project recommends — turns a
`_headers` file into real response headers.

So the build emits both, from one definition, and they are in scope. What remains
genuinely out of scope is a header that *only* a real server can send, on a
deployment that is served by GitHub Pages: `Strict-Transport-Security` is in the
`_headers` file and simply has no effect there. `style-src` also permits
`'unsafe-inline'` and will continue to, because MapLibre positions every control
and popup by writing to `element.style` and CSP counts a style attribute as inline
style. There is no nonce for attributes, so the alternative is not a tighter
policy — it is a map that does not render.

## Reporting

Use **GitHub's private vulnerability reporting** (Security tab → Report a
vulnerability). That keeps the report private until a fix exists.

Please do not open a public issue for a vulnerability. For anything non-sensitive, a
normal issue is perfect.

Expect an acknowledgement within a week. This is a spare-time project, so please be
patient with timelines — and do tell us if you plan to disclose publicly, so we can
line up a fix.
