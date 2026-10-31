"""SSE framing, Last-Event-ID handling and backpressure (frame coalescing)."""
from __future__ import annotations

import json
from typing import Any, Sequence


def format_sse(event_id: int, event: str, data: dict[str, Any]) -> str:
    payload = json.dumps(data, separators=(",", ":"))
    return f"id: {event_id}\nevent: {event}\ndata: {payload}\n\n"


def parse_last_event_id(value: str | None) -> int:
    if not value:
        return 0
    try:
        return max(0, int(value.strip()))
    except ValueError:
        return 0


def select_pending(log: Sequence[tuple[int, str, dict[str, Any]]], last_id: int) -> list[tuple[int, str, dict[str, Any]]]:
    """Return the events a subscriber still needs after `last_id`.

    Backpressure rule: if several `progress` events are pending (the client fell
    behind), only the newest one is kept. Non-progress events (queue, final,
    error) are always delivered, in order.
    """
    pending = [e for e in log if e[0] > last_id]
    newest_progress = max((e[0] for e in pending if e[1] == "progress"), default=None)
    return [e for e in pending if e[1] != "progress" or e[0] == newest_progress]


class SSEParser:
    """Incremental text/event-stream parser (used for upstream APIs)."""

    def __init__(self) -> None:
        self._buf = ""

    def feed(self, chunk: str) -> list[tuple[str, str]]:
        """Feed text; return completed (event, data) pairs. event defaults to 'message'."""
        self._buf += chunk.replace("\r\n", "\n")
        out: list[tuple[str, str]] = []
        while "\n\n" in self._buf:
            block, self._buf = self._buf.split("\n\n", 1)
            event, data = "message", []
            for line in block.split("\n"):
                if line.startswith(":") or not line:
                    continue
                key, _, val = line.partition(":")
                val = val[1:] if val.startswith(" ") else val
                if key == "event":
                    event = val
                elif key == "data":
                    data.append(val)
            if data:
                out.append((event, "\n".join(data)))
        return out
