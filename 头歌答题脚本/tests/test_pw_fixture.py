#!/usr/bin/env python3
"""Playwright 后端本地合成页验证（D4）。

用真实浏览器验证 CDP 后端不方便覆盖的 mouse / keyboard / target 行为：

  · ``connect_playwright`` 接管 9222（或 ``EDUAUTO_TEST_CDP_PORT``）上的调试 Edge；
  · ``create_target`` 打开本地 fixture（file://），``pages`` / ``find_page`` 能命中；
  · ``eval`` / ``eval_json`` 能读写页面；
  · ``mouse_click`` 真实坐标点击按钮并触发页面文本变化；
  · ``Input.dispatchKeyEvent`` 的 Escape 能触发页面 keydown，未知键抛
    ``NotImplementedError``；
  · ``close_target`` 后标签页从适配器和浏览器两个层面消失。

安全约束：只新建本地 fixture 标签页，不访问头歌、不登录、不改档案；
测试结束会关闭自己创建的标签页。

跳过条件（CI 友好，退出码 0）：
  · 未安装 Playwright；
  · 目标调试端口没有浏览器在监听（CI 默认没有 9222）。

默认端口 9222；本地可另起一个隔离的调试 Edge，并用
``EDUAUTO_TEST_CDP_PORT=9333`` 指过去，避免动到日常浏览器。
"""
import json
import os
import socket
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PORT = int(os.environ.get("EDUAUTO_TEST_CDP_PORT") or 9222)
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "pw_page.html"
FIXTURE_URL = FIXTURE.as_uri()
FIXTURE_MARK = "pw_page.html"

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


def skip(reason):
    print(f"SKIP test_pw_fixture（端口 {PORT}）：{reason}")
    sys.exit(0)


def port_alive(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def browser_targets(port):
    """直接读 CDP 的 /json/list，验证浏览器层面的标签页是否真的消失。"""
    url = f"http://127.0.0.1:{port}/json/list"
    # 本地调试端口绕过环境里的 HTTP 代理，避免代理把 127.0.0.1 也接管。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=3) as resp:
        return json.loads(resp.read().decode("utf-8"))


def has_fixture_target(port):
    try:
        return any(FIXTURE_MARK in (t.get("url") or "") for t in browser_targets(port))
    except Exception:
        return False


def wait_gone(port, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not has_fixture_target(port):
            return True
        time.sleep(0.1)
    return not has_fixture_target(port)


if not FIXTURE.is_file():
    check("本地 fixture 存在", False, str(FIXTURE))
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright  # noqa: F401
except ImportError as e:
    skip(f"未安装 Playwright（{e}）")

if not port_alive(PORT):
    skip("调试端口没有浏览器在监听")

import cdp  # noqa: E402
from eduauto import pw_backend  # noqa: E402
from eduauto.flows import list_classroom_cards  # noqa: E402
from eduauto.page import Page  # noqa: E402

try:
    pb = pw_backend.connect_playwright({"edge": {"port": PORT}})
except Exception as e:  # noqa: BLE001
    skip(f"无法接管调试端口（{e}）")

check("connect_playwright 返回 PlaywrightBrowser",
      isinstance(pb, pw_backend.PlaywrightBrowser), type(pb).__name__)
check("connect_playwright 使用指定端口", pb.port == PORT, repr(pb.port))

created_ids = []
fixture_target = None
try:
    before = pb.pages()
    check("连接后能枚举已有标签页", isinstance(before, list), repr(before))
    check("开始测试前没有 fixture 残留",
          not any(FIXTURE_MARK in p.get("url", "") for p in before),
          repr([p.get("url") for p in before]))

    # ---------- create_target / pages / find_page ----------
    fixture_target = pb.create_target(FIXTURE_URL)
    created_ids.append(fixture_target["id"])
    check("create_target 返回 id/url",
          bool(fixture_target.get("id")) and FIXTURE_MARK in fixture_target.get("url", ""),
          repr(fixture_target))

    listed = pb.pages()
    check("pages() 能找到 fixture 标签页",
          any(p["id"] == fixture_target["id"] and FIXTURE_MARK in p["url"]
              for p in listed), repr(listed))

    found = pb.find_page(FIXTURE_MARK)
    check("find_page 命中 fixture 标签页",
          found is not None and found["id"] == fixture_target["id"], repr(found))

    ws = pb.attach(found)
    check("attach 返回可用会话", isinstance(ws, pw_backend.PlaywrightWS))
    check("fixture 页面标题正确",
          ws.eval("document.title") == "Playwright 本地 fixture",
          repr(ws.eval("document.title")))
    check("fixture 包含输入框",
          ws.eval("document.getElementById('inp').tagName") == "INPUT")
    check("fixture 包含可编辑区域",
          ws.eval("document.getElementById('editable').isContentEditable") is True)

    # ---------- eval / eval_json ----------
    state = ws.eval_json(
        "JSON.stringify({title: document.title, clicks: window.__clicks,"
        " input: document.getElementById('inp').tagName,"
        " editable: document.getElementById('editable').isContentEditable})"
    )
    check("eval_json 解析 JSON 字符串",
          state == {"title": "Playwright 本地 fixture", "clicks": 0,
                    "input": "INPUT", "editable": True}, repr(state))
    check("eval_json 直接接收页面对象",
          ws.eval_json("({kind: 'fixture', n: 7})") == {"kind": "fixture", "n": 7},
          repr(ws.eval_json("({kind: 'fixture', n: 7})")))

    # ---------- mouse_click：真实坐标点击按钮 ----------
    rect = ws.eval_json(
        "JSON.stringify(document.getElementById('btn').getBoundingClientRect().toJSON())"
    )
    x = rect["x"] + rect["width"] / 2
    y = rect["y"] + rect["height"] / 2
    check("按钮位置可读取且尺寸正常",
          rect["width"] > 0 and rect["height"] > 0 and x > 0 and y > 0, repr(rect))
    ws.mouse_move(x, y)
    ws.mouse_click(x, y)
    check("mouse_click 后页面记录点击次数",
          ws.wait_for("window.__clicks === 1", timeout=5, poll=0.05),
          repr(ws.eval("window.__clicks")))
    check("mouse_click 后页面文本变化",
          ws.eval("document.getElementById('out').textContent") == "已点击 1",
          repr(ws.eval("document.getElementById('out').textContent")))

    # ---------- Input.dispatchKeyEvent：Escape 与未知键 ----------
    ws.call("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "Escape", "code": "Escape",
        "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27,
    })
    ws.call("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "Escape", "code": "Escape",
        "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27,
    })
    keys = ws.eval_json("JSON.stringify(window.__keys)")
    check("Escape 触发页面 keydown 记录",
          len(keys) == 1 and keys[0]["key"] == "Escape"
          and keys[0]["code"] == "Escape" and keys[0]["type"] == "keydown",
          repr(keys))
    check("Escape 触发页面响应",
          ws.eval("document.getElementById('esc').textContent") == "Escape 已触发",
          repr(ws.eval("document.getElementById('esc').textContent")))
    check("Escape 关闭页面弹窗",
          ws.eval("getComputedStyle(document.getElementById('modal')).display") == "none",
          repr(ws.eval("getComputedStyle(document.getElementById('modal')).display")))
    check_raises("未知按键抛 NotImplementedError", NotImplementedError,
                 lambda: ws.call("Input.dispatchKeyEvent",
                                 {"type": "keyDown", "key": "Enter"}),
                 "Enter")

    # ---------- 课堂卡片标题：状态标签不能顶替章节名 ----------
    ws.eval("""
      document.body.insertAdjacentHTML('beforeend', `
        <div class="listItem_test">
          <div class="titleLeft_test">
            <span>提交中</span><span>已开启补交</span>
            <span class="name___test">第二章作业</span>
          </div>
          <aside>开始学习</aside><span>1/1</span>
        </div>
        <div class="listItem_test">
          <div class="titleLeft_test">
            <span>补交中</span><span class="name___test">第一章作业</span>
          </div>
          <aside>开始学习</aside><span>1/1</span>
        </div>`);
    """)
    cards = list_classroom_cards(Page(ws, fixture_target))
    check("课堂卡片标题跳过状态标签（已开启补交）",
          any(c["name"] == "第二章作业" and c["done"] == 1 and c["total"] == 1
              for c in cards), repr(cards))
    check("课堂卡片标题跳过状态标签（补交中）",
          any(c["name"] == "第一章作业" and c["hasStart"] for c in cards), repr(cards))

    # ---------- close_target：适配器与浏览器两层都不残留 ----------
    pb.close_target(fixture_target["id"])
    created_ids.remove(fixture_target["id"])
    check("close_target 后 find_page 找不到 fixture",
          pb.find_page(FIXTURE_MARK) is None,
          repr(pb.find_page(FIXTURE_MARK)))
    check("close_target 后 pages() 不含已关闭 target",
          fixture_target["id"] not in {p["id"] for p in pb.pages()},
          repr(pb.pages()))
    check("close_target 后浏览器无 fixture 标签页",
          wait_gone(PORT), repr([t.get("url") for t in browser_targets(PORT)]))
    check_raises("关闭后会话不能继续求值", cdp.CDPError,
                 lambda: ws.eval("1"), "标签页已关闭")
    fixture_target = None
finally:
    for tid in list(created_ids):
        try:
            pb.close_target(tid)
        except Exception as e:  # noqa: BLE001
            print(f"  ! 清理标签页 {tid} 失败：{e}")
    try:
        pb.disconnect()
    except Exception as e:  # noqa: BLE001
        print(f"  ! 断开 Playwright 失败：{e}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
