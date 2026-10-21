#!/usr/bin/env python3
"""code.py / answers.py 边界修复的单元测试（不依赖浏览器，mock/纯函数覆盖）：

· 同名 basename 歧义：必须完整路径全等，拒绝 basename 兜底（防点错同名兄弟文件）；
· active 兜底：激活路径与目标全等 + 取「该激活文件对应 model」，否则返回 None
  （绝不拿最新 model 充数）——read_saved_files / _write_files 两条路径都覆盖；
· 单文件关 read_saved_answer 优先读评测记录（防把 public class Demo 类占位写进档案）；
· close_file_menu 三轮收不起来必须 log + raise，不静默放弃。

运行：python3 头歌答题脚本/tests/test_code.py
"""
import contextlib
import io
import sys
import unittest.mock as mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import eduauto.code as code                       # noqa: E402
import eduauto.answers as answers                 # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("✓", name)
    else:
        failed += 1
        print("✗", name, detail)
    return cond


@contextlib.contextmanager
def fast_sleep():
    """关掉两个模块里的 time.sleep（time 是同一 stdlib 模块，测试内全局生效）。"""
    with mock.patch.object(code.time, "sleep", lambda *_: None), \
            mock.patch.object(answers.time, "sleep", lambda *_: None):
        yield


def _item(path, x=100.0, y=200.0, visible=True):
    return {"path": path, "visible": visible, "x": x, "y": y}


class FakePage:
    def __init__(self, ws):
        self.ws = ws


class FakeWS:
    """按表达式特征路由结果的假 ws（模拟 CDP eval/eval_json，不依赖浏览器）。"""

    def __init__(self, items=(), uris=(), hit=None, active_model=None,
                 active_text=None, trigger=None):
        self.items = list(items)
        self.uris = list(uris)
        self.hit = hit
        self.active_model = dict(active_model) if active_model else None
        self.active_text = active_text
        self.trigger = trigger
        self.clicks, self.moves = [], []
        self.on_click = None
        self.on_move = None

    def eval_json(self, expr):
        if "elementFromPoint" in expr:                 # FILE_HIT_JS 里也含菜单项选择器，先判
            return self.hit
        if "ant-dropdown-menu-item" in expr:
            return [dict(x) for x in self.items]
        if "getModels().map(m => m.uri.toString())" in expr:
            return list(self.uris)
        if "reactFiber" in expr:
            return dict(self.active_model) if self.active_model else None
        if "pathActive" in expr:
            return self.active_text
        if "代码文件" in expr:
            return dict(self.trigger) if self.trigger else None
        if "elementFromPoint" in expr:
            return self.hit
        raise AssertionError("未预期的 eval_json 表达式：" + expr[:80])

    def eval(self, expr):
        if "visibilityState" in expr:
            return "visible"
        raise AssertionError("未预期的 eval 表达式：" + expr[:80])

    def mouse_click(self, x, y):
        self.clicks.append((x, y))
        if self.on_click:
            self.on_click()

    def mouse_move(self, x, y):
        self.moves.append((x, y))
        if self.on_move:
            self.on_move()

    def call(self, method, params=None):
        return {}


# ── 1. 同名 basename 歧义：_same_path / _find_item ────────────────
amb = [_item("src/A.java"), _item("test/A.java")]
check("same_path 完整路径相等", code._same_path("src/A.java", "src/A.java", amb))
check("same_path 歧义时拒绝 basename 兜底",
      not code._same_path("test/A.java", "src/A.java", amb))
check("same_path 无歧义时仍可用兜底",
      code._same_path("main.py", "src/main.py", [_item("main.py")]))
check("same_path 不传 items 保持旧行为",
      code._same_path("a.java", "src/Sub/a.java"))
check("same_path 空路径返回 False",
      not code._same_path("", "x.java") and not code._same_path("x.java", "  "))
check("find_item 完整路径优先命中", code._find_item(amb, "src/A.java")["path"] == "src/A.java")
check("find_item 同名两个一律拒绝", code._find_item(amb, "src/ZZ.java") is None)
check("find_item 唯一同名可用",
      code._find_item([_item("main.py")], "src/main.py")["path"] == "main.py")
check("find_item 空 want 拒绝", code._find_item(amb, "") is None)

# ── 2. click_code_file：歧义时绝不点击、放弃 ──────────────────────
with fast_sleep(), contextlib.redirect_stdout(io.StringIO()):
    ws1 = FakeWS(items=[_item("src/A.java"), _item("test/A.java")],
                 uris=["inmemory://model/1"], hit="test/A.java")
    got = code.click_code_file(FakePage(ws1), "src/A.java", timeout=0.3)
check("同名兄弟文件歧义：放弃本次点击且未真实点击",
      got is None and ws1.clicks == [], f"{got} clicks={ws1.clicks}")

ws2 = FakeWS(items=[_item("main.py")], uris=["inmemory://model/1"], hit="main.py")
ws2.on_click = lambda: ws2.uris.append("inmemory://model/9")
mm = {}
uri = code.click_code_file(FakePage(ws2), "src/main.py", timeout=0.3, model_map=mm)
check("无歧义时正常点击并记录 路径→model 映射",
      uri == "inmemory://model/9" and mm == {"src/main.py": "inmemory://model/9"},
      f"{uri} {mm}")

# ── 3. active 兜底：全等 + 对应 model，确认不了返回 None ───────────
want = "src/A.java"


def _resolve(am, uris, model_map=None):
    ws = FakeWS(uris=uris, active_model=am)
    return code._resolve_active_model(FakePage(ws), want, model_map)


check("兜底取显示 model 而非最新 model",
      _resolve({"path": "src/A.java", "uri": "inmemory://model/3"},
               ["inmemory://model/1", "inmemory://model/2",
                "inmemory://model/3", "inmemory://model/4"])
      == "inmemory://model/3")
m3 = {}
check("兜底 resolve 后映射被更新",
      _resolve({"path": "src/A.java", "uri": "inmemory://model/3"},
               ["inmemory://model/3"], m3) == "inmemory://model/3"
      and m3.get(want) == "inmemory://model/3")
check("确认不了显示 model 且无映射：返回 None（不取最新）",
      _resolve({"path": "src/A.java", "uri": None},
               ["inmemory://model/1", "inmemory://model/4"], {}) is None)
check("兜底用流程内映射（映射优先于最新 model）",
      _resolve({"path": "src/A.java", "uri": None},
               ["inmemory://model/1", "inmemory://model/2", "inmemory://model/4"],
               {want: "inmemory://model/2"}) == "inmemory://model/2")
check("兜底唯一 model 可确认",
      _resolve({"path": "src/A.java", "uri": None},
               ["inmemory://model/1"], {}) == "inmemory://model/1")
check("激活路径非全等（仅同名）拒绝",
      _resolve({"path": "test/A.java", "uri": "inmemory://model/3"},
               ["inmemory://model/3"], {}) is None)
check("显示 model 不在现有 models 里不采信",
      _resolve({"path": "src/A.java", "uri": "inmemory://model/99"},
               ["inmemory://model/1", "inmemory://model/4"], {}) is None)

# 整链路：点「已激活」文件 → 无新 model → 返回显示 model 而不是最新的
with fast_sleep(), contextlib.redirect_stdout(io.StringIO()):
    ws3 = FakeWS(items=[_item("src/A.java"), _item("test/B.java")],
                 uris=["inmemory://model/1", "inmemory://model/2", "inmemory://model/4"],
                 hit="src/A.java",
                 active_model={"path": "src/A.java", "uri": "inmemory://model/2"})
    got3 = code.click_code_file(FakePage(ws3), "src/A.java", timeout=0.3)
    ws4 = FakeWS(items=[_item("src/A.java"), _item("test/B.java")],
                 uris=["inmemory://model/1", "inmemory://model/2", "inmemory://model/4"],
                 hit="src/A.java",
                 active_model={"path": "test/B.java", "uri": "inmemory://model/4"})
    got4 = code.click_code_file(FakePage(ws4), "src/A.java", timeout=0.05)
check("点已激活文件返回该文件显示的 model（不是最新）",
      got3 == "inmemory://model/2", str(got3))
check("激活路径与目标不一致：整链路返回 None",
      got4 is None and len(ws4.clicks) >= 1, str(got4))

# ── 4. read_saved_files / _write_files 两条路径共用同一映射 ────────
DISPATCH = {"a.py": "inmemory://model/11", "b.py": "inmemory://model/12"}
CODES = {"a.py": "x=1", "b.py": "y=2"}
calls, maps_seen = [], []


def fake_click(pg, path, timeout=5, model_map=None):
    calls.append(path)
    maps_seen.append(model_map)
    return DISPATCH[path]


def fake_wait(pg, uri, timeout=8, need_stable=2):
    for path, u in DISPATCH.items():
        if u == uri:
            return CODES[path]
    return ""


with fast_sleep(), contextlib.redirect_stdout(io.StringIO()), \
        mock.patch.object(code, "click_code_file", fake_click), \
        mock.patch.object(code, "wait_uri_settled", fake_wait), \
        mock.patch.object(code, "write_uri_code", lambda pg, u, c: len(c)):
    code.write_files(FakePage(FakeWS()), ["a.py", "b.py"],
                     [{"path": "a.py", "answer": "x=1"}, {"path": "b.py", "answer": "y=2"}])
check("write_files 两轮按序点击全部文件", calls == ["a.py", "b.py", "a.py", "b.py"], str(calls))
check("write_files 全程共用同一个 路径→model 映射",
      all(m is maps_seen[0] for m in maps_seen) and maps_seen[0] is not None, str(maps_seen))

rcalls, rmaps = [], []


def fake_click2(pg, path, timeout=5, model_map=None):
    rcalls.append(path)
    rmaps.append(model_map)
    return "inmemory://model/20"


with fast_sleep(), contextlib.redirect_stdout(io.StringIO()), \
        mock.patch.object(code, "click_code_file", fake_click2), \
        mock.patch.object(code, "wait_uri_settled", lambda pg, u, timeout=8, need_stable=2: "rele"):
    out = code.read_saved_files(FakePage(FakeWS()), ["a.py", "b.py"])
check("read_saved_files 两文件都采到",
      out[0] == "files" and [(p, c) for p, c in out[1]] == [("a.py", "rele"), ("b.py", "rele")],
      str(out))
check("read_saved_files 共用同一映射", all(m is rmaps[0] for m in rmaps)
      and rmaps[0] is not None, str(rmaps))

with fast_sleep(), contextlib.redirect_stdout(io.StringIO()), \
        mock.patch.object(code, "click_code_file",
                          lambda pg, path, timeout=5, model_map=None: None):
    out = code.read_saved_files(FakePage(FakeWS()), ["a.py"])
check("读不到 model 走失败路径", out[0] is None and "失败" in out[2], str(out))

with fast_sleep(), contextlib.redirect_stdout(io.StringIO()), \
        mock.patch.object(code, "click_code_file",
                          lambda pg, path, timeout=5, model_map=None: None):
    try:
        code._write_files(FakePage(FakeWS()), ["a.py"],
                          [{"path": "a.py", "answer": "x=1"}])
        check("写文件点不开 model 即报错", False, "没有抛 RuntimeError")
    except RuntimeError as e:
        check("写文件点不开 model 即报错", "点开文件" in str(e), str(e))

# ── 5. read_saved_answer：单文件关记录优先于模板编辑器 ─────────────
REC = ("package app;\npublic class Demo {\n"
       "    public static void main(String[] args) {\n"
       "        int total = 0;\n" + "        total += total + 1;\n" * 30 +
       "    }\n}\n")                     # 真实代码（含 class Demo，无占位标记）
TPL = "// 请在此填写代码\npublic class Demo {}\n"
EDITOR_OK = "class Main { public static void main(String[] a) { System.out.println(1); } }"


def run_rsa(st, record="unset", editor="unset", paths=("Main.java",), hint=None):
    """mock 掉页面交互，跑 read_saved_answer；返回 (结果, 各函数调用计数)。"""
    nums = {"close": 0, "rec": 0, "editor": 0, "multi": 0, "list": 0}

    def _close(pg):
        nums["close"] += 1

    def _rec(pg):
        nums["rec"] += 1
        if record == "raise":
            raise RuntimeError("记录弹窗打不开")
        return None if record == "unset" else record

    def _editor(pg, timeout=8, need_stable=3):
        nums["editor"] += 1
        return None if editor == "unset" else editor

    def _list(pg):
        nums["list"] += 1
        return (list(paths), "")

    def _multi(pg, ps):
        nums["multi"] += 1
        return ("files", [], "多文件")

    with mock.patch.object(answers, "close_file_menu", _close), \
            mock.patch.object(answers, "read_submitted_code", _rec), \
            mock.patch.object(answers, "read_editor_code", _editor), \
            mock.patch.object(answers, "list_code_files", _list), \
            mock.patch.object(answers, "read_saved_files", _multi), \
            contextlib.redirect_stdout(io.StringIO()):
        return answers.read_saved_answer(FakePage(FakeWS()), st, multi_hint=hint), nums


S1 = {"hasEditor": True, "models": 1}
S2 = {"hasEditor": True, "models": 2}

r, n = run_rsa(S1, record=REC, editor=EDITOR_OK)
check("单文件：记录优先，用评测记录",
      r[0] == "code" and r[1] == REC and "评测记录" in r[2], str(r[2]) if r else "")
check("单文件记录可用时不读编辑器", r[0] == "code" and n["editor"] == 0 and n["rec"] == 1, str(n))
check("单文件：先收下拉", r[0] == "code" and n["close"] == 1, str(n))

r, n = run_rsa(S1, record=None, editor=EDITOR_OK)
check("单文件：记录没读到回退编辑器",
      r[0] == "code" and r[1] == EDITOR_OK and "编辑器" in r[2] and "评测记录没读到" in r[2], str(r))

r, n = run_rsa(S1, record=TPL, editor=EDITOR_OK)
check("单文件：记录也像模板时回退编辑器",
      r[0] == "code" and r[1] == EDITOR_OK and "评测记录也像模板" in r[2], str(r))

r, n = run_rsa(S1, record=None, editor=TPL)
check("单文件：记录与编辑器都无效 → None（不采模板）",
      r[0] is None and "像模板" in r[2], str(r))

r, n = run_rsa(S1, record="raise", editor=EDITOR_OK)
check("单文件：评测记录读取异常回退编辑器",
      r[0] == "code" and r[1] == EDITOR_OK and "评测记录也没读到" in r[2], str(r))

r, n = run_rsa(S1, record=None, editor=EDITOR_OK, hint=False)
check("单文件提示 multi=False：跳过文件下拉检测",
      r[0] == "code" and r[1] == EDITOR_OK and n["list"] == 0, str(n))

r, n = run_rsa(S1, record=REC)               # 不碰编辑器
check("单文件：真实记录可用即使用，绝不落回占位编辑器",
      r[0] == "code" and r[1] == REC and n["editor"] == 0, str(r[2]))

r, n = run_rsa(S2, editor=EDITOR_OK)
check("多 model：编辑器可用直接用，不读记录",
      r[0] == "code" and r[1] == EDITOR_OK and "（编辑器）" in r[2] and n["rec"] == 0, str(r))

r, n = run_rsa(S2, record=REC, editor=None)
check("多 model：编辑器为空 → 原失败语义",
      r[0] is None and "2 个 model" in r[2] and n["rec"] == 0, str(r))

r, n = run_rsa(S2, record=REC, editor=TPL)
check("多 model：编辑器像模板 → 原失败语义",
      r[0] is None and r[2] == "编辑器内容像模板，且无法读取评测记录" and n["rec"] == 0, str(r))

r, n = run_rsa(S1, paths=("a.java", "b.java"))
check("多文件路径不变：走 read_saved_files", r == ("files", [], "多文件")
      and n["multi"] == 1 and n["close"] == 0 and n["rec"] == 0, str(n))

# ── 6. close_file_menu：收不起来必须报错 ──────────────────────────
with fast_sleep(), contextlib.redirect_stdout(io.StringIO()):
    try:
        code.close_file_menu(FakePage(FakeWS(items=[_item("a.py")])))
        check("三轮收不起来 → RuntimeError", False, "没有抛错")
    except RuntimeError as e:
        check("三轮收不起来 → RuntimeError", "无法收起" in str(e) and "遮罩" in str(e), str(e))

with fast_sleep(), contextlib.redirect_stdout(io.StringIO()):
    ws5 = FakeWS(items=[_item("a.py")])
    ws5.on_move = lambda: setattr(ws5, "items", [])   # 移开鼠标就收
    code.close_file_menu(FakePage(ws5))
check("移开鼠标能收：正常返回且没点击触发器", ws5.clicks == [], str(ws5.clicks))

ws3c = FakeWS()
code.close_file_menu(FakePage(ws3c))
check("没有下拉时立即返回", ws3c.clicks == [] and ws3c.moves == [])

with fast_sleep(), contextlib.redirect_stdout(io.StringIO()):
    ws6 = FakeWS(items=[_item("a.py")], trigger={"x": 5.0, "y": 5.0})
    ws6.on_move = lambda: None                        # 移开也没收：走点击触发器兜底
    ws6.on_click = lambda: setattr(ws6, "items", [])  # 点触发器后收起
    code.close_file_menu(FakePage(ws6))
check("点击触发器收起成功", len(ws6.moves) == 1 and len(ws6.clicks) == 1,
      f"moves={ws6.moves} clicks={ws6.clicks}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
