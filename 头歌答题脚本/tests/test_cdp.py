#!/usr/bin/env python3
"""CDP 连接错误的友好包装回归测试（不依赖浏览器）。"""
import sys
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cdp  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("refused")):
    try:
        cdp.http_json("/json", port=9222)
        ok_json = False
        msg = ""
    except cdp.CDPError as e:
        ok_json = True
        msg = str(e)
check("http_json 连接失败包装成 CDPError", ok_json and "无法连接" in msg, msg)

ws = object.__new__(cdp.WS)
ws.closed = False


def _boom():
    raise ConnectionError("peer closed")


ws._recv_frame = _boom
try:
    ws._recv_json_inner()
    ok_recv = False
    msg2 = ""
except cdp.CDPError as e:
    ok_recv = True
    msg2 = str(e)
check("_recv_json_inner 连接断开包装成 CDPError", ok_recv and ws.closed, msg2)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
