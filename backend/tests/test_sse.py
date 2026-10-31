from app.sse import SSEParser, format_sse, parse_last_event_id, select_pending


def test_format_roundtrip():
    s = format_sse(7, "progress", {"step": 1})
    assert s == 'id: 7\nevent: progress\ndata: {"step":1}\n\n'
    p = SSEParser()
    assert p.feed(s[:10]) == []
    assert p.feed(s[10:]) == [("progress", '{"step":1}')]


def test_parser_multiline_comments_crlf():
    p = SSEParser()
    out = p.feed(": hi\r\ndata: a\r\ndata: b\r\n\r\nevent: x\ndata:c\n\n")
    assert out == [("message", "a\nb"), ("x", "c")]


def test_last_event_id():
    assert parse_last_event_id(None) == 0
    assert parse_last_event_id(" 12 ") == 12
    assert parse_last_event_id("junk") == 0
    assert parse_last_event_id("-3") == 0


def test_backpressure_keeps_latest_progress_and_terminal():
    log = [(1, "queue", {}), (2, "progress", {"s": 1}), (3, "progress", {"s": 2}),
           (4, "progress", {"s": 3}), (5, "final", {})]
    assert [e[0] for e in select_pending(log, 0)] == [1, 4, 5]
    assert [e[0] for e in select_pending(log, 3)] == [4, 5]
    assert select_pending(log, 5) == []
