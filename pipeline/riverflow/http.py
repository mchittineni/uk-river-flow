"""Polite HTTP client for public open-data APIs.

Every upstream here is a free public service run on someone else's budget, so
the client is built to be a good citizen first and fast second: a fixed minimum
gap between requests, capped exponential backoff with jitter, retry only on
transient status codes, and a descriptive User-Agent so an operator who sees us
in their logs can find out who we are.
"""

from __future__ import annotations

import gzip
import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

# Retried: 408 timeout, 429 rate limited, 5xx upstream trouble. Everything else
# (404, 400, 401) is a bug in our request and retrying only adds load.
RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504, 509})

USER_AGENT = (
    "riverflow-ingest/1.0 (+https://github.com/mchittineni/uk-river-flow) "
    "open-data visualisation; contact via GitHub issues"
)


class HttpError(RuntimeError):
    """A request failed permanently, after any retries were exhausted."""

    def __init__(self, url: str, status: int | None, detail: str) -> None:
        super().__init__(f"{status or 'ERR'} for {url}: {detail}")
        self.url = url
        self.status = status


@dataclass
class Http:
    """A rate-limited, retrying HTTP client.

    Args:
        min_interval: Minimum seconds between the *start* of two requests. This
            is the throttle that keeps us inside published rate limits.
        retries: How many times to retry a transient failure.
        timeout: Per-request socket timeout in seconds.
        rate_limit_dwell: Seconds to wait after a 429 that does not say which
            window was exceeded. A 429 means a *windowed* quota was hit, so the only
            thing that clears it is the window draining; exponential backoff starting
            at a second or two just burns retries against a limit that has not moved.
        max_dwell: Ceiling on any single 429 wait. Keeps one rate-limited request
            from parking a CI runner for an hour when the limiter's window is
            rolling rather than clock-aligned.
    """

    min_interval: float = 0.25
    retries: int = 4
    timeout: float = 45.0
    rate_limit_dwell: float = 65.0
    max_dwell: float = 900.0
    user_agent: str = USER_AGENT
    _last_request: float = field(default=0.0, init=False, repr=False)

    def _retry_delay(
        self, exc: urllib.error.HTTPError, attempt: int, backoff_base: float = 1.5
    ) -> tuple[float | None, str]:
        """How long to wait before retrying, and a short reason for the log.

        Returns `(None, reason)` when the request should not be retried at all -
        currently only a daily quota, where sleeping is pointless in a scheduled job
        and the caller should persist progress and exit.
        """
        if exc.code != 429:
            return _backoff(attempt, base=backoff_base), exc.reason or "server error"

        # Read the body once: it is small, and it is where the useful detail is.
        # It must be gunzipped first - we ask for `Accept-Encoding: gzip`, and error
        # responses are compressed too, so decoding the raw bytes as UTF-8 yields
        # mojibake and the window hint is silently lost.
        try:
            raw = exc.read()
            if exc.headers and exc.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            body = raw.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - a body we cannot read is simply no hint
            body = ""

        window = classify_rate_limit(body)
        explicit = _retry_after(exc)

        if window == "day":
            # Sleeping out a daily quota inside a scheduled job is pointless: the job
            # would hold a runner for hours. Callers persist progress and exit.
            return None, "daily quota exhausted - not retrying"

        if explicit is not None:
            return min(explicit, self.max_dwell), f"Retry-After {explicit:.0f}s"

        if window is not None:
            # Measured the hard way: retrying immediately after the clock hour rolled
            # still returned "Hourly API request limit exceeded", so Open-Meteo's
            # window is *rolling*, not clock-aligned. Waiting for the boundary is
            # therefore an upper bound, not the answer - we take the smaller of the
            # boundary and `max_dwell` and retry, letting a rolling window drain.
            wait = min(seconds_until_next(window), self.max_dwell)
            return wait, f"{window}ly limit, dwelling {wait:.0f}s"

        return self.rate_limit_dwell, "rate limited, no window given"

    def _throttle(self) -> None:
        gap = self.min_interval - (time.monotonic() - self._last_request)
        if gap > 0:
            time.sleep(gap)
        self._last_request = time.monotonic()

    def get_bytes(self, url: str, params: dict[str, object] | None = None) -> bytes:
        if params:
            # doseq keeps list-valued params (?a=1&a=2) rather than stringifying
            # the list, which some of these APIs use for multi-select filters.
            url = f"{url}?{urllib.parse.urlencode(params, doseq=True)}"

        last: Exception | None = None
        for attempt in range(self.retries + 1):
            self._throttle()
            request = urllib.request.Request(
                url,
                headers={
                    "User-Agent": self.user_agent,
                    "Accept": "application/json, */*",
                    "Accept-Encoding": "gzip",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        payload = gzip.decompress(payload)
                    return payload
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code not in RETRY_STATUS:
                    raise HttpError(url, exc.code, exc.reason or "http error") from exc
                delay, note = self._retry_delay(exc, attempt)
                if delay is None:
                    raise HttpError(url, exc.code, note) from exc
                log.warning("HTTP %s (%s) - retry %d in %.0fs", exc.code, note, attempt + 1, delay)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last = exc
                delay = _backoff(attempt)
                log.warning("network error on %s (%s) - retry %d in %.1fs", url, exc, attempt + 1, delay)

            if attempt < self.retries:
                time.sleep(delay)

        status = getattr(last, "code", None)
        raise HttpError(url, status, f"exhausted {self.retries} retries: {last}")

    def get_json(self, url: str, params: dict[str, object] | None = None) -> object:
        raw = self.get_bytes(url, params)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            # Truncated body or an HTML error page served with a 200. Surface a
            # snippet, because "Expecting value: line 1 column 1" alone is useless.
            raise HttpError(url, 200, f"invalid JSON ({exc}); body starts: {raw[:180]!r}") from exc

    def post_text(self, url: str, body: str, content_type: str = "text/plain") -> bytes:
        """POST a text body. Used for Overpass QL, which is too long for a URL."""
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            self._throttle()
            request = urllib.request.Request(
                url,
                data=body.encode("utf-8"),
                headers={
                    "User-Agent": self.user_agent,
                    "Content-Type": content_type,
                    "Accept-Encoding": "gzip",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        payload = gzip.decompress(payload)
                    return payload
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code not in RETRY_STATUS:
                    raise HttpError(url, exc.code, exc.reason or "http error") from exc
                delay, note = self._retry_delay(exc, attempt, backoff_base=5.0)
                if delay is None:
                    raise HttpError(url, exc.code, note) from exc
                log.warning("HTTP %s (%s) - retry %d in %.0fs", exc.code, note, attempt + 1, delay)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last = exc
                delay = _backoff(attempt, base=5.0)
                log.warning("network error on %s (%s) - retry %d in %.1fs", url, exc, attempt + 1, delay)
            if attempt < self.retries:
                time.sleep(delay)
        raise HttpError(url, getattr(last, "code", None), f"exhausted {self.retries} retries: {last}")


def _backoff(attempt: int, base: float = 1.5, cap: float = 60.0) -> float:
    """Exponential backoff with full jitter, so parallel forks do not sync up."""
    return min(cap, base * (2**attempt)) * (0.5 + random.random() / 2)


def _retry_after(exc: urllib.error.HTTPError) -> float | None:
    raw = exc.headers.get("Retry-After") if exc.headers else None
    if not raw:
        return None
    try:
        return min(3600.0, float(raw))
    except ValueError:
        return None


# Some APIs say which window you exceeded, in the response body, and that is far
# more useful than a fixed dwell. Open-Meteo answers a 429 with, verbatim:
#   {"error":true,"reason":"Hourly API request limit exceeded. Please try again in
#    the next hour."}
# A minute-long dwell against an hourly limit just burns retries; sleeping an hour
# against a minute limit wastes 59 of them. So we read the reason.
_WINDOW_HINTS = (
    ("minutely", "minute"),
    ("hourly", "hour"),
    ("daily", "day"),
)


def classify_rate_limit(body: str) -> str | None:
    """Return "minute", "hour", "day", or None if the body does not say."""
    lowered = body.lower()
    for needle, window in _WINDOW_HINTS:
        if needle in lowered:
            return window
    return None


def seconds_until_next(window: str, now: float | None = None) -> float:
    """Seconds until the given clock window rolls over, plus a small margin.

    Waiting for the actual boundary rather than a fixed duration means one dwell is
    enough: a request that failed at 15:49 against an hourly limit retries at 16:00,
    not at 15:50 and 15:51 and 15:52.
    """
    stamp = time.time() if now is None else now
    if window == "minute":
        return 60 - (stamp % 60) + 2
    if window == "hour":
        return 3600 - (stamp % 3600) + 5
    # A daily limit is not worth sleeping through in a scheduled job; callers treat
    # this as "stop and persist progress".
    return 86400 - (stamp % 86400) + 10
