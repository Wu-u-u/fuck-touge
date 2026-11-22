#!/usr/bin/env python3
"""状态上报契约测试（不依赖浏览器/扩展）。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eduauto.status import StatusPublisher  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


class FakeWS:
    def __init__(self):
        self.exprs = []

    def eval(self, expr):
        self.exprs.append(expr)
        return None

    def close(self):
        pass


class FakeBrowser:
    def __init__(self):
        self.ws = FakeWS()

    def pages(self):
        return [{"id": "p1", "url": "https://www.educoder.net/tasks/x/y/z"}]

    def attach(self, _target):
        return self.ws


browser = FakeBrowser()
pub = StatusPublisher()
pub.attach(browser, "1")
pub.set_state("running", "测试中")
pub.set_context(course="课程A", chapter="第一章", level="第1关")
for i in range(30):
    pub.log(f"日志{i}")
pub.flush()

exprs = browser.ws.exprs
payload = None
for expr in reversed(exprs):
    if "fuck-touge-script" not in expr:
        continue
    body = expr[len("window.postMessage("):].rsplit(", '*')", 1)[0]
    payload = json.loads(body)["payload"]
    break

check("状态走脚本专用 source", payload is not None)
check("状态字段完整",
      payload and payload["slot"] == "1" and payload["state"] == "running"
      and payload["course"] == "课程A" and payload["chapter"] == "第一章"
      and payload["level"] == "第1关", repr(payload))
check("日志最多保留 25 条", payload and len(payload["logs"]) == 25,
      str(len(payload["logs"]) if payload else -1))
check("日志带上下文",
      payload and payload["logs"][-1]["course"] == "课程A"
      and payload["logs"][-1]["levelName"] == "第1关", repr(payload["logs"][-1] if payload else None))

pub.finish()
check("正常结束写 stopped",
      any('"state": "stopped"' in e or '"state":"stopped"' in e for e in browser.ws.exprs),
      str(browser.ws.exprs[-2:]))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
