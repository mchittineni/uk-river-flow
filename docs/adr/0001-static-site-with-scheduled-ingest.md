# ADR 0001 — Static site with a scheduled ingest, not browser-side API calls

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

The obvious design for a map like this is the one the Norwegian original uses: a
static page that calls the hydrological API directly from the browser. No backend,
nothing to run, nothing to pay for.

We checked whether that actually works for the Environment Agency's APIs:

```
$ curl -sD - -o /dev/null \
    "https://environment.data.gov.uk/flood-monitoring/id/stations?_limit=1" \
    -H 'Origin: https://example.github.io'
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
Cache-Control: no-transform, max-age=300
```

So it is technically possible. `Access-Control-Allow-Origin: *`, no API key, no
signup. The same is true of the Hydrology API and the NRFA API.

But "the browser *can* call it" is not the same as "the browser *should*".

## Decision

The browser reads **same-origin static JSON**, written by a scheduled ingest.

```
GitHub Actions (cron)                       Browser
  │                                            │
  ├─ fetch EA Hydrology API  ─┐                │
  ├─ fetch EA flood-monitoring│                │
  │                           ▼                │
  │                     normalise + validate   │
  │                           │                │
  │                     data/v1/*.json ────────┤ fetch ./data/v1/…
  │                           │                │
  └─ build + deploy to Pages ─┘                └─ render
```

## Rationale

**Cost of a visitor is one static file set.** A browser-side design turns every
page view into 3–5 API calls. At any real traffic level that is a load we are
putting on a public service funded by someone else, to render data that is
identical for every visitor. Fetching it once per schedule and serving a cached
artefact is the polite architecture as well as the fast one.

**First paint is one round trip, not a fan-out.** The whole bundle is 133 KB
gzipped. Assembling the same picture in the browser means a station list, then a
readings query, then pagination — serialised, because the second call needs the
first's output.

**Upstream outages stop mattering.** If the EA API is down when a visitor arrives,
they see yesterday's map, not an error. That is the correct failure mode for a data
visualisation, and it is unavailable to a browser-side design.

**History accumulates.** The 15-minute real-time endpoint only serves *latest*.
Anything that wants a time series has to record one. The pipeline is the natural
place for that.

**The upstream shape stops being the UI's problem.** The EA publishes JSON-LD
where a single-valued field is a bare object and a multi-valued one is an array,
station identifiers differ between its two services, and 13 stations have null
coordinates. Normalising once in Python beats defending against it in five places
in the front end.

## Consequences

- Data is as fresh as the schedule, not the second. For daily mean discharge this
  is irrelevant; for the 15-minute layer it means up to ~8 hours of lag between
  runs. Accepted, and the UI shows the observation time.
- We need CI minutes. Public repositories get unlimited GitHub-hosted runner
  minutes, so this is free.
- Validation becomes mandatory: the front end now trusts a file rather than an
  API, so a malformed ingest is a broken site. Hence `pipeline/validate_data.py`
  gating every deploy.

## Alternatives considered

**Browser-side fetching.** Rejected above. Worth noting it *would* work, which is
why the decision needs recording — a future contributor will reasonably ask.

**A small proxy API** (Cloudflare Worker, Lambda). Adds a runtime to operate, a
free tier to monitor and a cold-start path, to solve a problem the static bundle
does not have. Rejected.

**Committing refreshed data on every run.** See [ADR 0005](./0005-do-not-commit-refreshed-data.md).
