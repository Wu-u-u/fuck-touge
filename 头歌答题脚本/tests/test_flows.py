#!/usr/bin/env python3
"""run/harvest 流程的汇总/退出码回归测试（不依赖浏览器）。"""
import contextlib
import io
import sys
import tempfile
import tomllib
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


def with_patches(patches: dict, fn):
    """给 flows 模块打补丁跑一次 fn，结束后恢复（含原函数）。"""
    saved = {}
    for name, value in patches.items():
        saved[name] = getattr(flows, name)
        setattr(flows, name, value)
    try:
        return fn()
    finally:
        for name, value in saved.items():
            setattr(flows, name, value)


def catch_exit(fn):
    """跑 fn，接住 SystemExit；返回 (exit_code, 输出)。"""
    buf = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(buf):
        try:
            fn()
        except SystemExit as e:
            code = e.code if e.code is not None else 0
    return code, buf.getvalue()


def abort(*a, **k):
    raise SystemExit(2)


def ok(*a, **k):
    return {"done": 1, "skipped": 0, "failed": 0}


def soft_fail(*a, **k):
    return {"done": 0, "skipped": 0, "failed": 1}


code, out = run_case(abort)
check("run 中止仍打印汇总", code == 2 and "汇总" in out and "已中止" in out
      and "失败 1 关" in out, f"code={code}")
code, out = run_case(ok)
check("run 成功正常汇总", code == 0 and "汇总" in out and "完成" in out
      and "作答 1 关" in out, f"code={code}")
code, out = run_case(soft_fail)
check("run 软失败（有章失败）→ exit 2",
      code == 2 and "完成（有 1 章失败" in out and "失败 1 关" in out
      and "已中止" not in out, f"code={code} out={out}")


# ── 真实 process_chapter 中途 die：已经作答的关数不能丢 ──────────
class DieRunPage:
    """L1 选择题作答并评测通过后，页面卡在「进不了下一关」。"""
    target = {}
    _st = {"index": 1, "name": "L1", "hasNext": True, "hasPrev": False,
           "hasEditor": False, "choiceCount": 1, "hasEval": True,
           "evalDisabled": False, "failMsgs": 0, "url": "u", "ready": "complete"}

    def __init__(self, *_a, **_k):
        pass

    def state(self):
        return dict(self._st)

    def wait_level(self, want_index=None, timeout=30, need_editor=None):
        return dict(self._st)

    def click_eval(self):
        return True


def run_real_die_case():
    ch = Chapter({"name": "测试章", "homework_id": "123",
                  "levels": [{"name": "L1", "answer": "A", "type": "choice"}]})

    def body():
        return catch_exit(lambda: flows.cmd_run(Args(), CFG))

    patches = {"load_answers": lambda p: [ch],
               "resolve_chapter_args": lambda chs, pats, strict=True: chs,
               "ensure_browser": lambda cfg: FakeBrowser(),
               "classroom_page": lambda browser, cfg, old=None: FakePage(),
               "ensure_login": lambda browser, ws=None: None,
               "scrape_status": lambda *a, **k: [
                   {"name": "L1", "full": "10", "score": "0", "status": "未通过"}],
               "Page": DieRunPage,
               "enter_chapter": lambda b, classroom, name, timeout=20, on_fail="die": (
                   {"id": "chap-1", "url": "https://cls.test/tasks/99/555/1"}, None),
               "_open_levels_from_detail": lambda b, t, pg: (t, pg, True),
               "rewind_to_first": lambda page, timeout=60: (
                   {"index": 1, "name": "L1", "hasNext": True, "hasPrev": False}, True),
               "wait_index_change": lambda page, old, timeout=60: {"index": old},
               "advance_level": lambda page, old, timeout=60: {"index": old},
               "wait_outcome": lambda page, ctx, timeout: {
                   "kind": "next", "detail": "评测通过（模拟）"},
               "answer_choice": lambda page, items: None}
    return with_patches(patches, body)


code, out = run_real_die_case()
check("中止保留部分统计：已作答 1 关可见",
      code == 2 and "已中止" in out and "第1关评测已通过，但页面无法进入下一关" in out
      and "测试章：作答 1 关，跳过 0 关，失败 1 关" in out,
      f"code={code} out={out}")


# ── harvest 中止：已采答案先写回档案再退出 ──────────────────────
HARVEST_FIX = """# 档案
version = 1

[[chapters]]
name = "第一章"
homework_id = "555"

[[chapters.levels]]
name = "L1"
multi = false
answer = ""
"""


class ScrapeWS:
    """课堂/详情页替身：支撑真实 scrape_status 与 card_progress_js。"""

    def __init__(self, rows, prog):
        self.rows = rows
        self.prog = prog

    def call(self, *a, **k):
        return {}

    def wait_for(self, expr, timeout=30.0, **kw):
        return True    # URL 落地、表格渲染都按成功处理

    def eval(self, expr):
        if "ant-spin-spinning" in expr:
            return False
        if "querySelectorAll('.ant-table-row').length" in expr:
            return len(self.rows)
        if "ant-table-row" in expr:
            return all((r.get("status") or "").strip() for r in self.rows)
        return None

    def eval_json(self, expr):
        if "ant-table-row" in expr:
            return [dict(r) for r in self.rows]
        if "findCard" in expr:
            return dict(self.prog)
        return None

    def mouse_click(self, *a, **k):
        pass

    def close(self):
        pass


class FlowPage:
    def __init__(self, ws=None, target=None):
        self.ws = ws
        self.target = target or {}


class HarvestBrowser:
    def __init__(self):
        self.closed = []

    def pages(self):
        return []

    def close_target(self, tid):
        self.closed.append(tid)


HARGS = type("HArgs", (), {"chapter": [], "force": False})


def run_harvest_abort(tmp_dir: Path):
    arch = tmp_dir / "answers.toml"
    arch.write_text(HARVEST_FIX, encoding="utf-8")
    hcfg = {"edge": {"classroom": "http://example"},
            "run": {"answers": str(arch), "eval_timeout": 1, "level_timeout": 1}}
    browser = HarvestBrowser()
    ws = ScrapeWS([{"name": "L1", "full": "10", "score": "10", "status": "已通过"}],
                  {"done": 1, "total": 1, "name": "第一章"})
    patches = {
        "ensure_browser": lambda cfg: browser,
        "ensure_login": lambda browser, ws=None: None,
        "list_classroom_cards": lambda page: [
            {"name": "第一章", "hasStart": True, "closed": False, "done": 1, "total": 1}],
        "classroom_page": lambda b, cfg, old=None: FlowPage(
            ws, {"id": "cls-1", "url": "https://cls.test/classrooms/abc/shixun_homework"}),
        "enter_chapter": lambda b, classroom, name, timeout=20, on_fail="die": (
            {"id": "chap-1", "url": "https://cls.test/tasks/99/555/1"}, None),
        "Page": FlowPage,
        "rewind_to_first": lambda page, timeout=60: (
            {"index": 1, "name": "L1", "hasNext": True, "hasPrev": False}, True),
        "read_saved_answer": lambda page, st: ("code", "print(88)", "8 字符"),
        "advance_level": lambda page, old, timeout=60: {"index": old},
    }

    def body():
        return catch_exit(lambda: flows.cmd_harvest(HARGS(), hcfg))
    return with_patches(patches, body), browser, arch


_out_pair, _hb, _arch = run_harvest_abort(Path(tempfile.mkdtemp()))
code, out = _out_pair
with open(_arch, "rb") as _f:
    _data = tomllib.load(_f)
_lv = _data["chapters"][0]["levels"][0]
check("harvest 中止：已采答案写回档案再退出",
      code == 2 and "print(88)" in str(_lv.get("answer", ""))
      and "已写回答案档案：第一章 1 关" in out
      and "采集中止" in out and "chap-1" in _hb.closed,
      f"code={code} lv={_lv} closed={_hb.closed} out={out}")
check("harvest 中止：die 原因与已写回日志仍在",
      "第1关采集后无法进入下一关" in out and "已写回：「L1」" in out, f"out={out}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
