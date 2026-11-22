#!/usr/bin/env python3
"""本地只读状态面板测试（标准库 HTTP，不启动浏览器）。"""
import json
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from webui import create_server  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


with tempfile.TemporaryDirectory() as td:
    state = Path(td) / "state.status.json"
    state.write_text(json.dumps({"state": "running", "slot": "1", "message": "test"}),
                     encoding="utf-8")
    srv = create_server(0, state)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_port}"
    html = urllib.request.urlopen(base + "/", timeout=3).read().decode()
    data = json.loads(urllib.request.urlopen(base + "/status", timeout=3).read())
    check("首页返回 HTML", "Fuck 头歌" in html)
    check("首页包含状态卡片与日志", "最近日志" in html and "id=\"logs\"" in html)
    check("状态接口返回 JSON", data.get("state") == "running" and data.get("slot") == "1", repr(data))
    try:
        urllib.request.urlopen(base + "/nope", timeout=3)
        check("未知路径 404", False)
    except urllib.error.HTTPError as e:
        check("未知路径 404", e.code == 404)
    srv.shutdown()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
