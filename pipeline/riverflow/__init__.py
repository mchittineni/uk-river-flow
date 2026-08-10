"""Reusable ingest core for river-discharge maps.

Deliberately standard-library only: the scheduled ingest must run on a bare
`python3` with no `pip install` step, so a fork stays reproducible years from
now and CI needs no dependency cache.
"""

__all__ = ["contract", "geometry", "http", "series"]
__version__ = "1.0.0"
