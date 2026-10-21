#!/usr/bin/env python3
"""Playwright 后端骨架测试（不依赖真实 Playwright / 浏览器）。

覆盖：target id 与页面映射、eval/eval_json 转发、wait_for、鼠标、close、
未实现 CDP 方法报错、工厂与连接参数。
"""
import json
import os
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cdp  # noqa: E402
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


class FakePage:
    def __init__(self, url="about:blank", title="", results=None):
        self.url = url
        self.title_text = title
        self.results = list(results or [])
        self.evaluated = []
        self.gotos = []
        self.brought_to_front = 0
        self.mouse = FakeMouse()
        self.closed = False

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

    def title(self):
        return self.title_text

    def close(self):
        self.closed = True


class FakeContext:
    def __init__(self, pages=None):
        self.pages = list(pages or [])

    def new_page(self):
        page = FakePage()
        self.pages.append(page)
        return page


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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
