#!/usr/bin/env python3
"""Validate a published data bundle against the contract.

Run in CI on every change, and by the ingest workflow *before* it commits. The
ordering matters: a bundle that fails validation must never reach the deployed
site, because the front end has no way to recover from malformed data beyond
showing an error page.

Usage:
    python3 pipeline/validate_data.py
    python3 pipeline/validate_data.py --root data/v1 --max-bytes 4000000
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from riverflow import contract

# A page-weight budget, enforced rather than aspirational. Chosen so the whole
# bundle stays inside a few seconds on a slow connection; if an ingest change
# blows past it, that should fail review, not surprise a visitor.
DEFAULT_MAX_GZIP_BYTES = 2_500_000


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("data/v1"))
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_GZIP_BYTES,
        help="fail if the gzipped bundle exceeds this total",
    )
    parser.add_argument("--quiet", "-q", action="store_true")
    parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="succeed with a notice if no bundle exists yet (the bootstrap case: a "
        "fresh repository has no committed seed until the first ingest lands)",
    )
    args = parser.parse_args()

    bundle_present = args.root.exists() and any(
        (args.root / name).exists() for name in contract.REQUIRED_FILES
    )
    if not bundle_present:
        message = f"no bundle at {args.root} - run the ingest pipeline to generate one"
        if args.allow_missing:
            # Bootstrap: a brand-new fork has no seed until the first scheduled
            # ingest opens its PR. Failing CI for that would block the very change
            # that fixes it.
            print(f"SKIP  {message}")
            return 0
        print(f"FAIL  {message}", file=sys.stderr)
        return 1

    errors = contract.validate_bundle(args.root)

    total_raw = total_gzip = 0
    rows: list[tuple[str, int, int]] = []
    for path in sorted(args.root.glob("*.json")) + sorted(args.root.glob("*.geojson")):
        raw = path.read_bytes()
        compressed = len(gzip.compress(raw, compresslevel=6))
        rows.append((path.name, len(raw), compressed))
        total_raw += len(raw)
        total_gzip += compressed

    if total_gzip > args.max_bytes:
        errors.append(
            f"bundle is {total_gzip / 1e6:.2f} MB gzipped, over the {args.max_bytes / 1e6:.2f} MB budget"
        )

    if not args.quiet:
        print(f"bundle: {args.root}")
        for name, raw, compressed in rows:
            print(f"  {name:<22} {raw / 1024:8.1f} KB raw  {compressed / 1024:8.1f} KB gzip")
        print(f"  {'TOTAL':<22} {total_raw / 1024:8.1f} KB raw  {total_gzip / 1024:8.1f} KB gzip")

        meta_path = args.root / "meta.json"
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                counts = meta.get("counts", {})
                print(
                    f"  generated {meta.get('generated_at')} | "
                    f"{counts.get('stations', '?')} stations, "
                    f"{counts.get('samples', '?')} samples, "
                    f"{counts.get('live', 0)} live"
                )
            except json.JSONDecodeError:
                pass

    if errors:
        print(f"\nFAIL  {len(errors)} contract violation(s):", file=sys.stderr)
        for error in errors[:60]:
            print(f"  - {error}", file=sys.stderr)
        if len(errors) > 60:
            print(f"  ... and {len(errors) - 60} more", file=sys.stderr)
        return 1

    print("\nOK    bundle satisfies contract v" + str(contract.CONTRACT_VERSION))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
