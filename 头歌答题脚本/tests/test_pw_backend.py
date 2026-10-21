#!/usr/bin/env python3
"""Playwright 后端测试（不依赖真实 Playwright / 浏览器）。

覆盖：target id 与页面映射、eval/eval_json 转发、wait_for、鼠标、close、
Escape 按键映射、未实现 CDP 方法报错、窗口尺寸兜底、扩展 no-op、
ensure_browser 的后端选择与共享 Edge 保护、工厂与连接参数。
"""
import contextlib
import io
import json
import os
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cdp  # noqa: E402
import eduauto.browser as browser_mod  # noqa: E402
from eduauto import pw_backend  # noqa: E402

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


class FakeCDPSession:
    def __init__(self, bounds=None):
        self.sent = []
        self.detached = False
        self.bounds = bounds or {"width": 1707, "height": 1021}

    def send(self, method, params=None):
        self.sent.append((method, dict(params or {})))
        if method == "Browser.getWindowForTarget":
            return {"windowId": 7, "bounds": dict(self.bounds)}
        return {}

    def detach(self):
        self.detached = True


class FakePage:
    def __init__(self, url="about:blank", title="", results=None):
        self.url = url
        self.title_text = title
        self.results = list(results or [])
        self.evaluated = []
        self.gotos = []
        self.brought_to_front = 0
        self.mouse = FakeMouse()
        self.keyboard = FakeKeyboard()
        self.closed = False
        self.context = None
        self.pumps = 0

    def is_closed(self):
        return self.closed

    def evaluate(self, expression):
        self.evaluated.append(expression)
        if self.results:
            value = self.results.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value
        return None

    def goto(self, url, **kwargs):
        self.gotos.append((url, kwargs))
        self.url = url

    def bring_to_front(self):
        self.brought_to_front += 1

    def wait_for_timeout(self, ms):
        self.pumps += 1

    def title(self):
        return self.title_text

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, pages=None):
        self.pages = list(pages or [])
        self.cdp_sessions = []
        for page in self.pages:
            page.context = self

    def new_page(self):
        page = FakePage()
        page.context = self
        self.pages.append(page)
        return page

    def new_cdp_session(self, page):
        session = FakeCDPSession()
        self.cdp_sessions.append((page, session))
        return session


class FakeBrowser:
    def __init__(self, pages=None):
        self.contexts = [FakeContext(pages)]
        self.closed = False
        self.new_context_calls = 0

    def new_context(self):
        self.new_context_calls += 1
        ctx = FakeContext()
        self.contexts.append(ctx)
        return ctx

    def close(self):
        self.closed = True


# ---------- 页面映射 ----------

p1 = FakePage("https://www.educoder.net/classrooms/JODEM6CH/shixun_homework", "课堂")
p2 = FakePage("https://www.educoder.net/tasks/abc", "任务")
browser = FakeBrowser([p1, p2])
pb = pw_backend.PlaywrightBrowser(browser, port=9222)

pages = pb.pages()
check("pages() 返回全部页面", len(pages) == 2, repr(pages))
check("pages() 返回 id/url/type",
      all({"id", "url", "type"} <= set(p) for p in pages), repr(pages))
check("target id 唯一", pages[0]["id"] != pages[1]["id"], repr(pages))
check("target id 稳定", pb.pages()[0]["id"] == pages[0]["id"], repr(pb.pages()))
check("url 映射正确", pages[0]["url"] == p1.url, repr(pages))
check("find_page 返回第一个匹配",
      pb.find_page("educoder.net")["id"] == pages[0]["id"])
check("last_page 返回最后一个匹配",
      pb.last_page("educoder.net")["id"] == pages[1]["id"])
check("find_page 无匹配返回 None", pb.find_page("example.com") is None)

only_tasks = pb.pages("/tasks/")
check("pages(url_substr) 过滤", [p["id"] for p in only_tasks] == [pages[1]["id"]],
      repr(only_tasks))

# 同步 API 只在自己的调用里派发事件：pages() 必须先泵一次，否则轮询
# 永远看不到「点按钮新开的标签页」（D3 真实 harvest 踩坑）。
pumps_before = p1.pumps
pb.pages()
check("pages() 枚举前泵一次事件", p1.pumps == pumps_before + 1, repr(p1.pumps))

pump_browser = FakeBrowser([FakePage("https://www.educoder.net/classrooms/x")])
pump_pb = pw_backend.PlaywrightBrowser(pump_browser, port=9222)
new_page = FakePage("https://www.educoder.net/tasks/new")
pump_page = pump_browser.contexts[0].pages[0]


def _reveal_page(ms):
    pump_page.pumps += 1
    if new_page not in pump_browser.contexts[0].pages:
        pump_browser.contexts[0].pages.append(new_page)


pump_page.wait_for_timeout = _reveal_page
revealed = pump_pb.pages()
check("pages() 泵事件后能看到新开的标签页",
      any(p["url"].endswith("/tasks/new") for p in revealed), repr(revealed))
check("新标签页也能被 url 过滤命中",
      [p["url"] for p in pump_pb.pages("/tasks/")] == [new_page.url],
      repr(pump_pb.pages("/tasks/")))

# 泵事件失败不能影响页面枚举（页面崩溃/已关闭时 wait_for_timeout 可能抛错）
bad_browser = FakeBrowser([FakePage("https://www.educoder.net/a")])
bad_pb = pw_backend.PlaywrightBrowser(bad_browser, port=9222)


def _boom(_ms):
    raise RuntimeError("页面已关闭")


bad_browser.contexts[0].pages[0].wait_for_timeout = _boom
check("泵事件抛错时 pages() 仍返回页面",
      [p["url"] for p in bad_pb.pages()] == ["https://www.educoder.net/a"],
      repr(bad_pb.pages()))

# 没有任何页面时也不能因为泵事件而报错
empty_pb = pw_backend.PlaywrightBrowser(FakeBrowser([]), port=9222)
check("没有页面时 pages() 返回空列表", empty_pb.pages() == [], repr(empty_pb.pages()))

# 页面导航后 pages()/find_page 仍能按新 URL 找到同一标签页
nav_page = FakePage("https://www.educoder.net/a")
nav_browser = FakeBrowser([nav_page])
nav_pb = pw_backend.PlaywrightBrowser(nav_browser, port=9222)
nav_id = nav_pb.pages()[0]["id"]
nav_page.url = "https://www.educoder.net/tasks/b"
check("pages() 反映导航后的 URL", nav_pb.pages()[0]["url"].endswith("/tasks/b"),
      repr(nav_pb.pages()))
check("find_page 用新 URL 找到同一页", (nav_pb.find_page("/tasks/b") or {}).get("id") == nav_id,
      repr(nav_pb.find_page("/tasks/b")))

# 已关闭页面从映射里清除
p2.closed = True
left = pb.pages()
check("已关闭页面被清理", [p["url"] for p in left] == [p1.url], repr(left))
check("已关闭页面的 id 被移除", pages[1]["id"] not in {p["id"] for p in left})

# ---------- 会话转发 ----------

p2.closed = False
ws = pb.attach(pages[0])
check("attach 返回 PlaywrightWS", isinstance(ws, pw_backend.PlaywrightWS))
check("attach 保留 target 信息", ws.target.get("id") == pages[0]["id"], repr(ws.target))

p1.results = ["https://www.educoder.net/x", 42]
check("eval 转发并返回页面值", ws.eval("location.href") == "https://www.educoder.net/x")
check("eval 原样转发表达式", p1.evaluated[-1] == "location.href", repr(p1.evaluated))
check("eval 返回值不被篡改", ws.eval("1+1") == 42)
p1.results = [1]
check("eval 接受 await_promise 兼容参数",
      ws.eval("Promise.resolve(1)", await_promise=False) == 1)

p1.results = [json.dumps({"index": 3, "name": "测试"})]
check("eval_json 解析 JSON 字符串", ws.eval_json("STATE") == {"index": 3, "name": "测试"})
p1.results = [{"already": "parsed"}]
check("eval_json 兼容已解析对象", ws.eval_json("STATE") == {"already": "parsed"})
p1.results = [None]
check("eval_json None 透传", ws.eval_json("null") is None)
p1.results = ["not-json"]
check_raises("eval_json 非法 JSON 抛 CDPError", cdp.CDPError,
             lambda: ws.eval_json("bad"), "不是合法 JSON")
p1.results = [ValueError("boom")]
check_raises("eval 页面异常包装成 CDPError", cdp.CDPError,
             lambda: ws.eval("throw"), "JS 执行失败")

# wait_for：先抛错、再假、最后真
p1.results = [pw_backend.PlaywrightBackendError("暂时读不到"), False, True]
with mock.patch.object(pw_backend.time, "sleep", lambda *_: None):
    ok = ws.wait_for("ready", timeout=2, poll=0)
check("wait_for 重试并返回 True", ok is True)
check("wait_for 轮询了三次", len(p1.evaluated) >= 3, repr(p1.evaluated))
p1.results = [False]
check("wait_for 超时返回 False", ws.wait_for("never", timeout=0) is False)

# 鼠标
ws.mouse_move(10, 20)
ws.mouse_click(30, 40)
check("mouse_move 转发", p1.mouse.moves == [(10, 20)], repr(p1.mouse.moves))
check("mouse_click 转发", p1.mouse.clicks == [(30, 40)], repr(p1.mouse.clicks))

# call：已实现与未实现
r = ws.call("Page.navigate", {"url": "https://www.educoder.net/new"})
check("Page.navigate 转发到 goto", p1.gotos and p1.gotos[-1][0].endswith("/new"),
      repr(p1.gotos))
check("Page.navigate 返回 dict", isinstance(r, dict), repr(r))
check("Page.bringToFront 转发", ws.call("Page.bringToFront") == {}
      and p1.brought_to_front == 1, repr(p1.brought_to_front))
check_raises("Page.navigate 缺 url 抛 CDPError", cdp.CDPError,
             lambda: ws.call("Page.navigate"), "缺少 url")
check_raises("未实现方法抛 NotImplementedError", NotImplementedError,
             lambda: ws.call("Runtime.enable"), "Runtime.enable")
check_raises("Input 方法也未实现", NotImplementedError,
             lambda: ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved"}))

# Input.dispatchKeyEvent：只映射 Escape
ws.call("Input.dispatchKeyEvent", {
    "type": "keyDown", "key": "Escape", "code": "Escape",
    "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27,
})
ws.call("Input.dispatchKeyEvent", {
    "type": "keyUp", "key": "Escape", "code": "Escape",
    "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27,
})
check("Escape keyDown/keyUp 映射到 keyboard",
      p1.keyboard.calls == [("down", "Escape"), ("up", "Escape")],
      repr(p1.keyboard.calls))
check_raises("未知按键抛 NotImplementedError", NotImplementedError,
             lambda: ws.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter"}),
             "Enter")

# close 只结束会话，不关标签页
ws.close()
check("close 标记会话关闭", ws.closed is True)
check("close 不关闭标签页", p1.closed is False)
check_raises("关闭后 eval 报错", cdp.CDPError, lambda: ws.eval("1"), "会话已关闭")

# ---------- close_target / create_target ----------

target2 = pb.find_page("/tasks/")      # 重新扫描，恢复 p2 的 target id
check("关闭过的页面重新出现后可再次映射", target2 is not None)
pb.close_target(target2["id"])
check("close_target 关闭页面", p2.closed is True)
check("close_target 清理映射", pb.find_page("/tasks/") is None)
pb.close_target("不存在")          # 不应抛异常
check("close_target 未知 id 静默返回", True)

new_target = pb.create_target("https://www.educoder.net/tasks/new")
check("create_target 返回 id/url", new_target.get("id") and new_target.get("url") ==
      "https://www.educoder.net/tasks/new", repr(new_target))
new_ws = pb.attach(new_target)
check("create_target 后可 attach", isinstance(new_ws, pw_backend.PlaywrightWS))
check("create_target 只在已有 context 新建页面", browser.new_context_calls == 0)
check("create_target 执行了导航", new_ws.page.gotos and
      new_ws.page.gotos[-1][0] == "https://www.educoder.net/tasks/new")

# ---------- 浏览器生命周期 ----------

pb.close_browser()
check("close_browser 不调用 Browser.close", browser.closed is False)

# disconnect 断开 Playwright 但不关闭浏览器
fake_pw = mock.Mock()
pb.playwright = fake_pw
pb.disconnect()
check("disconnect 停止 Playwright", fake_pw.stop.called)
check("disconnect 不关闭浏览器", browser.closed is False)

# ---------- 扩展与窗口尺寸兜底 ----------

ext_out = io.StringIO()
with contextlib.redirect_stdout(ext_out):
    ext = pb.ensure_extension("/tmp/ext")
check("ensure_extension 返回 None", ext is None, repr(ext))
check("ensure_extension 明确不假装加载", "不管理扩展" in ext_out.getvalue(),
      ext_out.getvalue())

win_page = FakePage("about:blank")
win_browser = FakeBrowser([win_page])
win_pb = pw_backend.PlaywrightBrowser(win_browser, port=9222)
win_target = win_pb.pages()[0]
info = win_pb.ws.call("Browser.getWindowForTarget", {"targetId": win_target["id"]})
check("browser.ws 提供 Browser.getWindowForTarget", info.get("windowId") == 7, repr(info))
win_ctx = win_browser.contexts[0]
check("窗口命令复用同一个页面 CDP 会话", len(win_ctx.cdp_sessions) == 1,
      repr(win_ctx.cdp_sessions))
win_pb.ws.call("Browser.setWindowBounds", {
    "windowId": 7, "bounds": {"windowState": "maximized"}})
session = win_ctx.cdp_sessions[0][1]
check("Browser.setWindowBounds 转发到 CDP",
      session.sent[-1] == ("Browser.setWindowBounds",
                           {"windowId": 7, "bounds": {"windowState": "maximized"}}),
      repr(session.sent))
check_raises("未知浏览器级方法抛 NotImplementedError", NotImplementedError,
             lambda: win_pb.ws.call("Target.createTarget", {"url": "about:blank"}),
             "Target.createTarget")

# ensure_window_size 遇到小窗口会尝试最大化，且不会崩
class SmallContext(FakeContext):
    def new_cdp_session(self, page):
        session = FakeCDPSession({"width": 800, "height": 600})
        self.cdp_sessions.append((page, session))
        return session


class SmallBrowser(FakeBrowser):
    def __init__(self, pages=None):
        self.contexts = [SmallContext(pages)]
        self.closed = False
        self.new_context_calls = 0

    def new_context(self):
        self.new_context_calls += 1
        ctx = SmallContext()
        self.contexts.append(ctx)
        return ctx


small_browser = SmallBrowser([FakePage("about:blank")])
small_pb = pw_backend.PlaywrightBrowser(small_browser, port=9222)
small_ctx = small_browser.contexts[0]
win_out = io.StringIO()
with mock.patch.object(browser_mod.time, "sleep", lambda *_: None), \
        contextlib.redirect_stdout(win_out):
    browser_mod.ensure_window_size(small_pb)
small_session = small_ctx.cdp_sessions[0][1]
check("ensure_window_size 对 Playwright 不崩", True)
check("小窗口触发 setWindowBounds",
      any(m == "Browser.setWindowBounds" for m, _ in small_session.sent),
      repr(small_session.sent))
check("最大化成功提示只在真正设置后打印", "最大化" in win_out.getvalue(), win_out.getvalue())

# 已足够大的窗口不重复设置（也不会误报最大化）
big_page = FakePage("about:blank")
big_browser = FakeBrowser([big_page])
big_pb = pw_backend.PlaywrightBrowser(big_browser, port=9222)
big_out = io.StringIO()
with mock.patch.object(browser_mod.time, "sleep", lambda *_: None), \
        contextlib.redirect_stdout(big_out):
    browser_mod.ensure_window_size(big_pb)
big_session = big_browser.contexts[0].cdp_sessions[0][1]
check("大窗口不调用 setWindowBounds",
      all(m != "Browser.setWindowBounds" for m, _ in big_session.sent),
      repr(big_session.sent))
check("大窗口不打印最大化提示", "最大化" not in big_out.getvalue(), big_out.getvalue())


# ---------- connect_playwright / 工厂 ----------

class FakeChromium:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def connect_over_cdp(self, url):
        self.calls.append(url)
        if self.error:
            raise self.error
        return self.result


class FakePlaywright:
    def __init__(self, chromium):
        self.chromium = chromium
        self.stopped = False

    def stop(self):
        self.stopped = True


class FakeSyncPlaywright:
    def __init__(self, pw):
        self.pw = pw
        self.started = False

    def start(self):
        self.started = True
        return self.pw


fake_browser2 = FakeBrowser([FakePage("https://www.educoder.net/a")])
fake_chromium = FakeChromium(result=fake_browser2)
fake_pw2 = FakePlaywright(fake_chromium)
fake_sync = FakeSyncPlaywright(fake_pw2)
with mock.patch.object(pw_backend, "_load_sync_playwright", return_value=lambda: fake_sync):
    connected = pw_backend.connect_playwright({"edge": {"port": 9333}})
check("connect_playwright 启动 Playwright", fake_sync.started is True)
check("connect_playwright 使用 127.0.0.1:<port>",
      fake_chromium.calls == ["http://127.0.0.1:9333"], repr(fake_chromium.calls))
check("connect_playwright 保存端口", connected.port == 9333, repr(connected.port))
check("connect_playwright 返回适配器", isinstance(connected, pw_backend.PlaywrightBrowser))
connected.disconnect()
check("断开后 Playwright 停止", fake_pw2.stopped is True)
check("断开后 Edge 仍存活", fake_browser2.closed is False)

fail_pw = FakePlaywright(FakeChromium(error=RuntimeError("refused")))
with mock.patch.object(pw_backend, "_load_sync_playwright",
                       return_value=lambda: FakeSyncPlaywright(fail_pw)):
    check_raises("连接失败包装成 CDPError", cdp.CDPError,
                 lambda: pw_backend.connect_playwright({"edge": {"port": 9222}}),
                 "无法通过 Playwright")
check("连接失败后停止 Playwright", fail_pw.stopped is True)

with mock.patch.dict(os.environ, {"EDUAUTO_BACKEND": "playwright"}):
    with mock.patch.object(pw_backend, "connect_playwright",
                           return_value="PW-BROWSER") as factory:
        picked = pw_backend.make_browser({"edge": {"port": 9222}})
check("EDUAUTO_BACKEND=playwright 选择新后端", picked == "PW-BROWSER")
check("工厂把 cfg 传给 connect_playwright", factory.call_args[0][0]["edge"]["port"] == 9222)

with mock.patch.dict(os.environ, {"EDUAUTO_BACKEND": "unknown"}):
    check_raises("未知后端抛 ValueError", ValueError,
                 lambda: pw_backend.make_browser({"edge": {"port": 9222}}), "未知")


# ---------- ensure_browser：后端选择与共享 Edge 保护 ----------

CFG = {
    "edge": {
        "port": 9222,
        "profile": "~/.config/test-profile",
        "extension": "/tmp/test-ext",
    },
    "run": {"answers": "unused.toml"},
}


class FakeConnBrowser:
    def __init__(self, name):
        self.name = name

    def ensure_extension(self, path):
        return None


def run_ensure(env_value, *, alive=True, state=None, connect_error=None):
    """跑一次 browser.ensure_browser，返回 (结果, 退出码, 输出, mocks)。"""
    state = dict(state or {})
    calls = {}
    out = io.StringIO()
    code = 0
    got = None
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.dict(os.environ, {"EDUAUTO_BACKEND": env_value}))
        stack.enter_context(mock.patch.object(browser_mod, "port_alive", return_value=alive))
        calls["load_state"] = stack.enter_context(
            mock.patch.object(browser_mod, "load_state", return_value=state))
        calls["update_state"] = stack.enter_context(
            mock.patch.object(browser_mod, "update_state"))
        calls["connect_browser"] = stack.enter_context(
            mock.patch.object(browser_mod, "connect_browser",
                              return_value=FakeConnBrowser("cdp")))
        if connect_error is not None:
            pw_mock = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright", side_effect=connect_error))
        else:
            pw_mock = stack.enter_context(
                mock.patch.object(pw_backend, "connect_playwright",
                                  return_value=FakeConnBrowser("playwright")))
        calls["connect_playwright"] = pw_mock
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


matched_state = {"current": "1", "running": "1",
                 "running_profile": "~/.config/test-profile"}

got, code, out, calls = run_ensure("cdp", state=matched_state)
check("默认 cdp 后端走 connect_browser", got.name == "cdp" and code == 0, out)
check("默认 cdp 后端不碰 Playwright", calls["connect_playwright"].called is False)
check("默认 cdp 后端不重启浏览器", calls["launch_edge"].called is False, out)

got, code, out, calls = run_ensure("legacy", state=matched_state)
check("未知 EDUAUTO_BACKEND 仍走 cdp", got.name == "cdp" and code == 0, out)
check("未知 EDUAUTO_BACKEND 不碰 Playwright", calls["connect_playwright"].called is False)

got, code, out, calls = run_ensure("playwright", state=matched_state)
check("playwright 后端走 connect_playwright", got.name == "playwright" and code == 0, out)
check("playwright 后端不碰 connect_browser", calls["connect_browser"].called is False)
check("playwright 后端不启动/关闭浏览器",
      calls["launch_edge"].called is False and calls["stop_browser"].called is False)
check("playwright 后端更新运行状态", calls["update_state"].called is True)
check("playwright 后端执行窗口兜底", calls["ensure_window_size"].called is True)

got, code, out, calls = run_ensure("playwright", alive=False)
check("playwright 端口不通返回退出码 2", code == 2, f"code={code}")
check("playwright 端口不通给出清晰提示",
      "Playwright" in out and "调试端口 9222" in out and "不会自动启动" in out, out)
check("playwright 端口不通不尝试连接", calls["connect_playwright"].called is False)

got, code, out, calls = run_ensure("playwright", state=matched_state,
                                   connect_error=cdp.CDPError("refused"))
check("playwright 连接失败 die（不是 traceback）", code == 2, f"code={code}")
check("playwright 连接失败提示清楚",
      "Playwright 后端连接失败" in out and "refused" in out, out)

mismatch_state = {"current": "1", "running": "2",
                  "running_profile": "~/.config/test-profile"}
got, code, out, calls = run_ensure("playwright", state=mismatch_state)
check("playwright 槽位不一致不关闭共享 Edge",
      calls["stop_browser"].called is False and calls["launch_edge"].called is False)
check("playwright 槽位不一致给出明确提示", "不切换档案槽" in out, out)
check("playwright 槽位不一致仍复用现有浏览器", got.name == "playwright" and code == 0, out)
check("playwright 槽位不一致不覆盖运行状态", calls["update_state"].called is False)

profile_state = {"current": "1", "running": "1",
                 "running_profile": "/tmp/other-profile"}
got, code, out, calls = run_ensure("playwright", state=profile_state)
check("playwright 档案不一致不关闭共享 Edge",
      calls["stop_browser"].called is False and calls["launch_edge"].called is False)
check("playwright 档案不一致给出明确提示", "档案与当前槽不一致" in out, out)

got, code, out, calls = run_ensure("playwright", state={})
check("playwright 无状态记录时仍复用", got.name == "playwright" and code == 0, out)
check("playwright 无状态记录时写入当前槽", calls["update_state"].called is True)

# stop_browser 在 Playwright 模式下明确跳过，不调用 CDP Browser.close
with mock.patch.dict(os.environ, {"EDUAUTO_BACKEND": "playwright"}), \
        mock.patch.object(browser_mod.cdp, "Browser") as cdp_browser, \
        mock.patch.object(browser_mod, "port_alive", return_value=True):
    stop_out = io.StringIO()
    with contextlib.redirect_stdout(stop_out):
        stopped = browser_mod.stop_browser(9222)
check("playwright 模式 stop_browser 返回 False", stopped is False)
check("playwright 模式 stop_browser 不调用 Browser.close", cdp_browser.called is False)
check("playwright 模式 stop_browser 给出提示", "不会关闭共享 Edge" in stop_out.getvalue(),
      stop_out.getvalue())

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
