#!/usr/bin/env python3
"""D5 双后端统一接口测试（不依赖真实 Playwright / 浏览器）。

覆盖：
  · 后端选择：默认 cdp、显式 playwright、大小写/空白、未知值回退与提示；
  · 协议：BrowserLike / PageSessionLike 的方法在 cdp 与 Playwright 适配器上齐全，
    运行时 isinstance 能识别完整实现、拒绝缺方法实现；
  · Playwright 模式：端口不通/槽位不一致/无状态时的提示，不启动/不关闭浏览器；
  · connect_configured：默认 cdp，Playwright 端口不通给出清晰提示；
  · Escape 按键映射与未知键报错、ensure_extension no-op。
"""
import contextlib
import io
import os
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cdp  # noqa: E402
import eduauto.browser as browser_mod  # noqa: E402
from eduauto import backend, pw_backend  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


def check_raises(name, exc_type, fn, contains=""):
    try:
        fn()
    except exc_type as e:
        check(name, contains in str(e), str(e))
    except Exception as e:  # noqa: BLE001
        check(name, False, f"抛出了 {type(e).__name__}: {e}")
    else:
        check(name, False, "没有抛异常")


# ---------- 后端选择 ----------

check("未设置 EDUAUTO_BACKEND 时默认 cdp",
      backend.backend_name({}) == "cdp", backend.backend_name({}))
check("空值/纯空白回退 cdp",
      backend.backend_name({"EDUAUTO_BACKEND": "   "}) == "cdp")
check("显式 playwright 才选择 Playwright",
      backend.backend_name({"EDUAUTO_BACKEND": "playwright"}) == "playwright")
check("backend_name 归一化大小写与空白",
      backend.backend_name({"EDUAUTO_BACKEND": "  PlayWright "}) == "playwright")
check("显式 cdp 仍是 cdp",
      backend.backend_name({"EDUAUTO_BACKEND": "CDP"}) == "cdp")
check("未知值原样返回（由调用方回退）",
      backend.backend_name({"EDUAUTO_BACKEND": "puppeteer"}) == "puppeteer")
check("unknown_backend 识别未知值",
      backend.unknown_backend({"EDUAUTO_BACKEND": "puppeteer"}) == "puppeteer")
check("unknown_backend 对合法值返回 None",
      backend.unknown_backend({"EDUAUTO_BACKEND": "playwright"}) is None)
check("is_playwright 只认精确 playwright",
      backend.is_playwright({"EDUAUTO_BACKEND": "playwright"}) is True
      and backend.is_playwright({"EDUAUTO_BACKEND": "unknown"}) is False
      and backend.is_playwright({}) is False)

# ---------- 协议方法 ----------

BROWSER_METHODS = ("pages", "attach", "close_target", "create_target",
                   "find_page", "last_page")
SESSION_METHODS = ("eval", "eval_json", "call", "wait_for",
                   "mouse_move", "mouse_click", "close")


def has_methods(cls, names):
    return all(callable(getattr(cls, name, None)) for name in names)


check("cdp.Browser 满足 BrowserLike 方法面",
      has_methods(cdp.Browser, BROWSER_METHODS),
      [n for n in BROWSER_METHODS if not callable(getattr(cdp.Browser, n, None))])
check("cdp.WS 满足 PageSessionLike 方法面",
      has_methods(cdp.WS, SESSION_METHODS),
      [n for n in SESSION_METHODS if not callable(getattr(cdp.WS, n, None))])
check("PlaywrightBrowser 满足 BrowserLike 方法面",
      has_methods(pw_backend.PlaywrightBrowser, BROWSER_METHODS),
      [n for n in BROWSER_METHODS
       if not callable(getattr(pw_backend.PlaywrightBrowser, n, None))])
check("PlaywrightWS 满足 PageSessionLike 方法面",
      has_methods(pw_backend.PlaywrightWS, SESSION_METHODS),
      [n for n in SESSION_METHODS
       if not callable(getattr(pw_backend.PlaywrightWS, n, None))])


class FullBrowser:
    def pages(self, url_substr=None): return []
    def find_page(self, url_substr): return None
    def last_page(self, url_substr): return None
    def create_target(self, url="about:blank", retries=20): return {}
    def attach(self, target): return FullSession()
    def close_target(self, target_id): return None


class FullSession:
    def eval(self, expression, await_promise=True): return None
    def eval_json(self, expression): return None
    def call(self, method, params=None): return {}
    def wait_for(self, expression, timeout=30.0, poll=0.4, desc=""): return True
    def mouse_move(self, x, y): return None
    def mouse_click(self, x, y): return None
    def close(self): return None


class PartialBrowser:
    def pages(self, url_substr=None): return []


check("BrowserLike 运行时识别完整实现",
      isinstance(FullBrowser(), backend.BrowserLike))
check("BrowserLike 运行时拒绝缺方法的实现",
      not isinstance(PartialBrowser(), backend.BrowserLike))
check("PageSessionLike 运行时识别完整实现",
      isinstance(FullSession(), backend.PageSessionLike))
check("PageSessionLike 运行时拒绝空对象",
      not isinstance(object(), backend.PageSessionLike))

# ---------- ensure_browser 后端选择 ----------

CFG = {
    "edge": {
        "port": 9222,
        "profile": "~/.config/test-profile",
        "extension": "/tmp/test-ext",
    },
    "run": {"answers": "unused.toml"},
}
MATCHED_STATE = {"current": "1", "running": "1",
                 "running_profile": "~/.config/test-profile"}


class ConnBrowser:
    def __init__(self, name):
        self.name = name
        self.extension_calls = []

    def ensure_extension(self, path):
        self.extension_calls.append(path)
        return None


def run_ensure(env_value, *, alive=True, state=None, connect_error=None):
    """跑一次 ensure_browser，返回 (结果, 退出码, 输出, mocks)。"""
    state = dict(MATCHED_STATE if state is None else state)
    env = {} if env_value is None else {"EDUAUTO_BACKEND": env_value}
    calls = {}
    out = io.StringIO()
    code = 0
    got = None
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
        stack.enter_context(mock.patch.object(browser_mod, "port_alive", return_value=alive))
        stack.enter_context(mock.patch.object(browser_mod, "load_state", return_value=state))
        calls["update_state"] = stack.enter_context(
            mock.patch.object(browser_mod, "update_state"))
        calls["connect_browser"] = stack.enter_context(
            mock.patch.object(browser_mod, "connect_browser",
                              return_value=ConnBrowser("cdp")))
        if connect_error is not None:
            calls["connect_playwright"] = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright",
                                  side_effect=connect_error))
        else:
            calls["connect_playwright"] = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright",
                                  return_value=ConnBrowser("playwright")))
        calls["launch_edge"] = stack.enter_context(
            mock.patch.object(browser_mod, "launch_edge"))
        calls["stop_browser"] = stack.enter_context(
            mock.patch.object(browser_mod, "stop_browser"))
        calls["ensure_window_size"] = stack.enter_context(
            mock.patch.object(browser_mod, "ensure_window_size"))
        try:
            with contextlib.redirect_stdout(out):
                got = browser_mod.ensure_browser(CFG)
        except SystemExit as e:
            code = e.code if e.code is not None else 0
    return got, code, out.getvalue(), calls


got, code, out, calls = run_ensure(None)
check("未设置环境变量走默认 cdp",
      got.name == "cdp" and code == 0, out)
check("默认 cdp 不碰 Playwright", calls["connect_playwright"].called is False)
check("默认 cdp 不重启已匹配槽位的浏览器",
      calls["launch_edge"].called is False and calls["stop_browser"].called is False)

got, code, out, calls = run_ensure("playwright")
check("显式 playwright 走 Playwright 适配器",
      got.name == "playwright" and code == 0, out)
check("playwright 不碰 connect_browser", calls["connect_browser"].called is False)
check("playwright 不启动/不关闭共享浏览器",
      calls["launch_edge"].called is False and calls["stop_browser"].called is False)
check("playwright 仍执行窗口尺寸兜底",
      calls["ensure_window_size"].called is True)
check("playwright 匹配槽位时更新运行状态",
      calls["update_state"].called is True)

got, code, out, calls = run_ensure("playwright", alive=False)
check("playwright 端口不通退出码为 2", code == 2, f"code={code}")
check("playwright 端口不通提示要求先启动 Edge",
      "需要 Edge 已经启动" in out and "调试端口 9222" in out, out)
check("playwright 端口不通提示不自动启动/不关共享 Edge",
      "不会自动启动" in out and "不会关闭共享 Edge" in out, out)
check("playwright 端口不通提示不自动切槽/不管理扩展",
      "不自动切换档案槽" in out and "不管理扩展" in out, out)
check("playwright 端口不通不尝试连接",
      calls["connect_playwright"].called is False)

got, code, out, calls = run_ensure(
    "playwright", state={"current": "1", "running": "2",
                         "running_profile": "~/.config/test-profile"})
check("playwright 槽位不一致不切换/不关闭",
      calls["stop_browser"].called is False and calls["launch_edge"].called is False)
check("playwright 槽位不一致给出明确提示", "不切换档案槽" in out, out)
check("playwright 槽位不一致仍复用现有浏览器",
      got.name == "playwright" and code == 0, out)
check("playwright 槽位不一致不覆盖运行状态",
      calls["update_state"].called is False)

got, code, out, calls = run_ensure(
    "playwright", state={"current": "1", "running": "1",
                         "running_profile": "/tmp/other-profile"})
check("playwright 档案不一致不关闭共享 Edge",
      calls["stop_browser"].called is False and calls["launch_edge"].called is False)
check("playwright 档案不一致给出明确提示", "档案与当前槽不一致" in out, out)

got, code, out, calls = run_ensure("playwright", state={})
check("playwright 无状态记录时仍复用",
      got.name == "playwright" and code == 0, out)
check("playwright 无状态记录时写入当前槽", calls["update_state"].called is True)

got, code, out, calls = run_ensure("playwright", connect_error=cdp.CDPError("refused"))
check("playwright 连接失败 die 而不是 traceback", code == 2, f"code={code}")
check("playwright 连接失败提示清楚",
      "Playwright 后端连接失败" in out and "refused" in out, out)

got, code, out, calls = run_ensure("puppeteer")
check("未知 EDUAUTO_BACKEND 回退 cdp", got.name == "cdp" and code == 0, out)
check("未知 EDUAUTO_BACKEND 明确提示",
      "未知的 EDUAUTO_BACKEND" in out and "回退到默认 cdp" in out, out)
check("未知 EDUAUTO_BACKEND 不碰 Playwright",
      calls["connect_playwright"].called is False)


# ---------- connect_configured ----------

def run_connect(env_value, *, alive=True, connect_error=None):
    env = {} if env_value is None else {"EDUAUTO_BACKEND": env_value}
    out = io.StringIO()
    code = 0
    got = None
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, env, clear=True))
        stack.enter_context(mock.patch.object(browser_mod, "port_alive",
                                             return_value=alive))
        cdp_mock = stack.enter_context(
            mock.patch.object(browser_mod, "connect_browser",
                              return_value=ConnBrowser("cdp")))
        if connect_error is not None:
            pw_mock = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright",
                                  side_effect=connect_error))
        else:
            pw_mock = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright",
                                  return_value=ConnBrowser("playwright")))
        try:
            with contextlib.redirect_stdout(out):
                got = browser_mod.connect_configured(CFG, attempts=1)
        except SystemExit as e:
            code = e.code if e.code is not None else 0
    return got, code, out.getvalue(), cdp_mock, pw_mock


got, code, out, cdp_mock, pw_mock = run_connect(None)
check("connect_configured 默认走 cdp",
      got.name == "cdp" and cdp_mock.called and not pw_mock.called)
check("connect_configured 把 attempts 传给 cdp",
      cdp_mock.call_args.kwargs.get("attempts") == 1, repr(cdp_mock.call_args))

got, code, out, cdp_mock, pw_mock = run_connect("playwright")
check("connect_configured playwright 走适配器",
      got.name == "playwright" and pw_mock.called and not cdp_mock.called)

got, code, out, cdp_mock, pw_mock = run_connect("playwright", alive=False)
check("connect_configured playwright 端口不通退出 2", code == 2, f"code={code}")
check("connect_configured playwright 端口不通提示完整",
      "Playwright 模式需要 Edge 已经启动" in out
      and "不自动切换档案槽" in out and "不管理扩展" in out, out)
check("connect_configured playwright 端口不通不连接",
      pw_mock.called is False)

got, code, out, cdp_mock, pw_mock = run_connect(
    "playwright", connect_error=cdp.CDPError("refused"))
check("connect_configured playwright 连接失败 die", code == 2, f"code={code}")
check("connect_configured playwright 连接失败提示清楚",
      "Playwright 后端连接失败" in out and "refused" in out, out)

got, code, out, cdp_mock, pw_mock = run_connect("puppeteer")
check("connect_configured 未知值回退 cdp 并提示",
      got.name == "cdp" and "未知的 EDUAUTO_BACKEND" in out, out)

# ---------- Playwright 会话：Escape / 未知键 ----------

class FakeMouse:
    def __init__(self):
        self.moves = []
        self.clicks = []

    def move(self, x, y):
        self.moves.append((x, y))

    def click(self, x, y):
        self.clicks.append((x, y))


class FakeKeyboard:
    def __init__(self):
        self.calls = []

    def down(self, key):
        self.calls.append(("down", key))

    def up(self, key):
        self.calls.append(("up", key))

    def press(self, key):
        self.calls.append(("press", key))


class FakePage:
    def __init__(self, url="about:blank"):
        self.url = url
        self.closed = False
        self.context = None
        self.mouse = FakeMouse()
        self.keyboard = FakeKeyboard()

    def is_closed(self):
        return self.closed

    def evaluate(self, expression):
        return None

    def goto(self, url, **kwargs):
        self.url = url

    def bring_to_front(self):
        pass

    def wait_for_timeout(self, ms):
        pass

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self):
        self.pages = []

    def new_page(self):
        page = FakePage()
        page.context = self
        self.pages.append(page)
        return page

    def new_cdp_session(self, page):
        raise AssertionError("本测试不应创建 CDP 会话")


class FakeBrowser:
    def __init__(self):
        self.contexts = [FakeContext()]

    def new_context(self):
        raise AssertionError("本测试不应新建上下文")

    def close(self):
        raise AssertionError("本测试不应关闭浏览器")


key_page = FakePage()
key_ws = pw_backend.PlaywrightWS(key_page)
key_ws.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape"})
key_ws.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape"})
check("Escape keyDown/keyUp 映射正确",
      key_page.keyboard.calls == [("down", "Escape"), ("up", "Escape")],
      repr(key_page.keyboard.calls))
key_page.keyboard.calls.clear()
key_ws.call("Input.dispatchKeyEvent", {"type": "char", "code": "Escape"})
check("Escape char 映射为 press",
      key_page.keyboard.calls == [("press", "Escape")],
      repr(key_page.keyboard.calls))
check_raises("未知按键明确抛 NotImplementedError", NotImplementedError,
             lambda: key_ws.call("Input.dispatchKeyEvent",
                                 {"type": "keyDown", "key": "Enter"}),
             "Enter")
check_raises("未知空按键也明确报错", NotImplementedError,
             lambda: key_ws.call("Input.dispatchKeyEvent", {"type": "keyDown"}),
             "None")

# ---------- ensure_extension no-op ----------

ext_browser = pw_backend.PlaywrightBrowser(FakeBrowser(), port=9222)
ext_out = io.StringIO()
with contextlib.redirect_stdout(ext_out):
    ext = ext_browser.ensure_extension("/tmp/ext")
check("Playwright ensure_extension 返回 None", ext is None, repr(ext))
check("Playwright ensure_extension 明确不假装加载",
      "不管理扩展" in ext_out.getvalue(), ext_out.getvalue())
check("Playwright extensions 返回空列表（走兜底路径）",
      ext_browser.extensions() == [])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
