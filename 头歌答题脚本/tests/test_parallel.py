#!/usr/bin/env python3
"""并行 launcher 的纯逻辑测试：端口、状态合并、进程清理。"""
import json
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parallel  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


# 端口占用检测
s = socket.socket()
s.bind(("127.0.0.1", 0))
port = s.getsockname()[1]
s.listen(1)
check("端口占用时不可用", not parallel._port_free(port))
s.close()
check("端口释放后可用", parallel._port_free(port))

# worker state 合并
with tempfile.TemporaryDirectory() as td:
    main = Path(td) / "state.json"
    main.write_text(json.dumps({"current": "1", "names": {"1": "A"},
                                "logins": {"1": "a"}, "course_orders": {}}),
                    encoding="utf-8")
    worker = Path(td) / "worker.json"
    worker.write_text(json.dumps({"current": "2", "names": {"2": "B"},
                                  "logins": {"2": "b"},
                                  "course_orders": {"2": ["C"]}}),
                      encoding="utf-8")
    old = os.environ.get("EDUAUTO_STATE_FILE")
    os.environ["EDUAUTO_STATE_FILE"] = str(main)
    try:
        parallel._merge_worker_state(worker)
        merged = json.loads(main.read_text(encoding="utf-8"))
    finally:
        if old is None:
            os.environ.pop("EDUAUTO_STATE_FILE", None)
        else:
            os.environ["EDUAUTO_STATE_FILE"] = old
    check("worker 状态回填 names/logins/course_orders",
          merged["names"] == {"1": "A", "2": "B"}
          and merged["logins"] == {"1": "a", "2": "b"}
          and merged["course_orders"] == {"2": ["C"]})
    check("不覆盖主 state 的 current", merged["current"] == "1")

# 终端进程组清理
p = subprocess.Popen(["sleep", "30"], start_new_session=True)
parallel._stop_processes([(1, 9301, 0, Path("x"), p)])
check("停止 worker 进程组", p.poll() is not None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
