#!/usr/bin/env python3
"""run 流程的汇总/退出码回归测试（不依赖浏览器）。"""
import contextlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import eduauto.flows as flows  # noqa: E402
from eduauto.archive import Chapter  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


class Args:
    chapter = []
    yes = True


class FakePage:
    target = {}
    ws = None


class FakeBrowser:
    pass


CFG = {"edge": {"classroom": "http://example"},
       "run": {"answers": "unused.toml", "eval_timeout": 1, "level_timeout": 1}}


def run_case(proc):
    ch = Chapter({"name": "测试章", "homework_id": "123",
                  "levels": [{"name": "L1", "answer": "A", "type": "choice"}]})
    saved = {}
    for name, value in {
        "load_answers": lambda p: [ch],
        "resolve_chapter_args": lambda chs, pats, strict=True: chs,
        "ensure_browser": lambda cfg: FakeBrowser(),
        "classroom_page": lambda browser, cfg, old=None: FakePage(),
        "ensure_login": lambda browser, ws=None: None,
        "scrape_status": lambda *a, **k: [
            {"name": "L1", "full": "10", "score": "0", "status": "未通过"}],
        "process_chapter": proc,
    }.items():
        saved[name] = getattr(flows, name)
        setattr(flows, name, value)
    buf = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                flows.cmd_run(Args(), CFG)
            except SystemExit as e:
                code = e.code
    finally:
        for name, value in saved.items():
            setattr(flows, name, value)
    return code, buf.getvalue()


def abort(*a, **k):
    raise SystemExit(2)


def ok(*a, **k):
    return {"done": 1, "skipped": 0, "failed": 0}


code, out = run_case(abort)
check("run 中止仍打印汇总", code == 2 and "汇总" in out and "已中止" in out
      and "失败 1 关" in out, f"code={code}")
code, out = run_case(ok)
check("run 成功正常汇总", code == 0 and "汇总" in out and "完成" in out
      and "作答 1 关" in out, f"code={code}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
