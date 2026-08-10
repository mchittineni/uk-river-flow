# Contributing

Contributions are welcome. This is a small, deliberately boring codebase — no
framework, no build magic in the pipeline, and decisions recorded in
[`docs/adr/`](docs/adr/) so you can find out *why* before changing *what*.

## Setup

```bash
git clone https://github.com/mchittineni/uk-river-flow
cd uk-river-flow

# Pipeline: nothing to install. Standard library only.
python3 -m unittest discover -s pipeline/tests

# Front end
cd web && npm install && npm run dev
```

A seed data bundle is committed, so the map works immediately. It may be up to a
month old — the deployed site regenerates its own data and does not commit it (see
[ADR 0005](docs/adr/0005-do-not-commit-refreshed-data.md)). To get current data:

```bash
python3 pipeline/ingest_uk.py --days 30
```

## Before you open a pull request

```bash
python3 -m unittest discover -s pipeline/tests   # 40 tests, no network
python3 pipeline/validate_data.py                # contract + page-weight budget
cd web && npm run lint && npm test && npm run build
```

CI runs exactly these. It does **not** hit the upstream APIs — see below.

## Two rules that are enforced, not just preferred

**1. The pipeline stays dependency-free.** No `requirements.txt`, no virtualenv. The
ingest must run on a bare `python3` so a fork years from now is not blocked by an
unresolvable lockfile. CI fails if `pipeline/requirements.txt` becomes non-empty.

If you need something from PyPI, that is a signal to reconsider the approach — every
current need is met by `json`, `csv`, `urllib`, `datetime` and `math`. If it is
genuinely unavoidable, open an issue first; it is an architecture change.

**2. CI does no network I/O.** Every upstream here is a free public service funded by
someone else. A test suite that fetches on every push is both rude and flaky. Live
fetching happens only in the scheduled workflows.

Write tests against fixtures. `pipeline/tests/test_pipeline.py` shows the pattern.

## Being a good citizen of the APIs

If you add or change an upstream call, keep the existing discipline:

- Go through `riverflow.http.Http`. It throttles, backs off with jitter, dwells for a
  whole quota window on 429, and sends a User-Agent that identifies the project.
- Prefer one batched request over many small ones. The EA readings endpoint serves the
  whole country's latest flow in a single ~120 KB response; the CSV endpoint serves 30
  days nationally in one call. Loop only when there is no batch form.
- Never remove the throttle to make a job finish faster.

## The data contract

`data/v1/` is a real API between the pipeline and the front end, which deploy
independently. If you change its shape:

1. Update `pipeline/riverflow/contract.py`, including the validator.
2. Add a test asserting the validator *rejects* the malformed version. Every check in
   there exists because it catches something a human would not notice.
3. Update `web/src/data.js` to match, and bump `CONTRACT_VERSION` for a breaking
   change — the front end refuses to render an unrecognised version rather than
   showing wrong numbers.

## Duplicated logic

`flowState` exists in both Python and JavaScript on purpose (precomputed for first
paint, recomputed for time scrubbing). Both suites assert the same fixture, in
`test_flow_state_matches_the_front_end_thresholds` and `flow-state.test.js`. If you
change a threshold, change it in both places — one of the two tests will tell you if
you forget.

## Style

- Python: standard library, type hints, 4 spaces, ~110 columns. No formatter is
  enforced; match the surrounding code.
- JavaScript: Prettier and ESLint are enforced. `npm run format` fixes most things.
- Comments should say **why**, not what. The code says what.

## Good first issues

- **The station join.** [ADR 0004](docs/adr/0004-two-layers-not-one-join.md) explains
  why the two EA networks are separate layers. 806 of 1,102 hydrology stations carry
  an `nrfaStationID`; a join mediated by those, validated against names and catchment
  areas with a confidence score per match, would be a real improvement.
- **A WebGL particle layer** for the flow animation, replacing the dash-sequence trick
  ([ADR 0002](docs/adr/0002-maplibre-not-cesium.md)).
- **Catchment polygons**, so you can see the area feeding a gauge.
- **A basin/region filter** in the rail — the EA publishes `catchmentName`.
- **Accessibility.** Keyboard navigation between stations, and a tabular view of the
  data for screen readers.

## Reporting problems with the data itself

If a *reading* is wrong, it is almost certainly wrong at the source, and the fix
belongs with the Environment Agency. If we mangled it in transit — wrong place, wrong
scale, a gap we should have shown as a gap — that is ours. The data-quality issue
template asks for the upstream value so we can tell the two apart quickly.
