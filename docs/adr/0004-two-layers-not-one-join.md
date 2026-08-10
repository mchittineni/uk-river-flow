# ADR 0004 — Two independent station layers, not one merged network

- **Status:** Accepted
- **Date:** 2026-08-10

## Context

The Environment Agency publishes river flow through two separate services:

| | Hydrology API | Real-time flood-monitoring API |
| --- | --- | --- |
| Flow stations | 1,102 | ~352 |
| Resolution | Daily mean | 15 minutes |
| Quality flags | Yes (Good / Unchecked / Estimated / Suspect) | No |
| Coordinates present | 1,102 of 1,102 | 339 of 352 |
| River name present | 1,099 | 86 |
| Latest national snapshot | one CSV request | one JSON request |

Both are useful and they are complementary: one has breadth, history and metadata,
the other has freshness. The obvious move is to merge them into one station list
where a station has both a daily series and a live value.

So we measured whether they can actually be joined:

```
hydrology wiskiIDs: 1104 | flood-monitoring stationReferences: 352
direct identifier overlap: 87
coordinate overlap (3 dp): 169 of 314
label overlap:             95 of 334
```

A 25% identifier match. Coordinate matching reaches 54%, and matching on rounded
coordinates across two networks is exactly the kind of heuristic that silently
attaches the wrong river's readings to a station.

## Decision

Publish them as **two independent layers** the user toggles between. No join.

- `stations.json` + `series.json` — the Hydrology archive. The default layer.
- `live.json` — the real-time snapshot. Rendered as a distinct marker shape.

## Rationale

A join at 25% confidence is worse than no join. The failure mode is not a missing
value — it is a *plausible wrong* value: a station labelled with one river's name
showing another river's discharge. Nobody would notice, and the map would be
quietly lying.

Presenting two layers is honest about what the underlying data actually is, and it
costs one segmented control. The live marker is a different *shape* rather than a
different colour, so "this is the other network" is legible without a legend
lookup.

## Consequences

- A user who wants 15-minute data for a specific station has to look on the live
  layer and may not find it there. The panel explains why.
- The time slider applies only to the archive layer; it is hidden on the live
  layer, because a single snapshot has no history to scrub and leaving the control
  visible would imply otherwise.
- The two layers can disagree, which is legitimate: a daily mean and an
  instantaneous reading are different quantities.
- The live layer is additive, so its failure is caught and logged rather than
  failing the ingest — losing freshness must not take down the layer people
  actually navigate by.

## If someone wants to fix this properly

The EA does publish crosswalks in places — hydrology stations carry
`nrfaStationID` for 806 of 1,102 stations. A join mediated by NRFA identifiers,
validated against station names and catchment areas and with an explicit
confidence score per match, would be a genuine improvement. It is a real piece of
data-engineering work, not a coordinate round, and it belongs in its own PR with
its own tests.
