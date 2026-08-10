# ADR 0005 — Do not commit refreshed data; commit a monthly seed

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

The scheduled ingest produces a ~450 KB bundle three times a day. Where should it
go?

Committing it to `main` is the common pattern and has real appeal: the repository
becomes a growing public archive of UK river discharge, every change is a
reviewable diff, and the deployed site is exactly what is in git.

The arithmetic is the problem. 450 KB x 3 x 365 is roughly **490 MB of new git
objects a year**, before packing. GitHub's soft limit is 1 GB per repository and
it recommends staying under 5 GB. A clone would get slower every month, forever,
to store data that is regenerable from a free public API in about sixty seconds.

## Decision

Two different artefacts with two different lifecycles:

1. **Deployed data is never committed.** `refresh-and-deploy.yml` generates it,
   validates it, builds the site and publishes to GitHub Pages as a deployment
   artefact. Pages deployments do not live in git history.
2. **A seed bundle is committed, refreshed monthly by pull request.**
   `refresh-seed.yml` regenerates `data/v1/` and opens a PR.

The seed exists so that:

- a fresh clone renders immediately — `npm run dev` works with no pipeline run,
- CI has a fixture to validate the contract against without network access,
- the deploy job has a baseline to sanity-check a fresh ingest against (the
  station-count collapse guard),
- the repo is useful offline and as a citable snapshot.

Monthly cadence keeps history growth to roughly 5 MB a year.

## Rationale

The two artefacts have genuinely different requirements. Deployed data must be
fresh and is disposable. The seed must be stable, reviewable and small. Trying to
serve both from one mechanism means either a bloated repository or a site that is
a month stale.

A pull request rather than a direct push, because the seed is the fixture every CI
run depends on: it should not change without a human glancing at the diff, and
`main` stays protectable.

## Consequences

- The repository is **not** a historical archive. If someone wants one, the right
  answer is a separate data repo, or a release asset per month — not `main`.
- `data/v1/` in git is up to a month old. The README says so, and `meta.json`
  carries `generated_at`, so the staleness is visible rather than implied.
- A first-time contributor sees data that does not match the live site. Documented
  in `CONTRIBUTING.md`.
- If Pages is disabled, nothing is lost but the deployment — the pipeline and seed
  are unaffected.

## Alternatives considered

**A `data` branch with force-push.** Keeps `main` clean and data current, but a
force-pushed branch is hostile to forks and the history is a lie either way.

**Cloudflare R2 or a gist.** Adds an account and a credential, breaking the
zero-signup property.

**Commit every run, then periodically rewrite history.** Rewriting a public
repository's history breaks every fork and clone. Never for routine housekeeping.
