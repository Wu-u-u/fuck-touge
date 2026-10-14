#!/usr/bin/env python3
"""零依赖 Chrome DevTools Protocol 客户端（头歌答题脚本专用）。

只用标准库：通过 HTTP 拿目标列表，通过 WebSocket 发 CDP 命令。
支持：浏览器级命令、页面级命令、事件缓冲、便捷封装（点击/求值/等待）。

用法示例：
    from cdp import Browser
    b = Browser(port=9222)
    page = b.find_page("educoder.net")
    ws = b.attach(page)
    print(ws.eval("document.title"))
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import time
import urllib.parse
import urllib.request

DEFAULT_PORT = 9222


class CDPError(RuntimeError):
    """CDP 返回 error 时抛出。"""


class WS:
    """一个 WebSocket 连接（对应一个页面/浏览器会话）。"""

    def __init__(self, url: str, timeout: float = 30.0):
        assert url.startswith("ws://"), url
        rest = url[5:]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("WebSocket 握手失败")
            self.buf += chunk
        header, _, self.buf = self.buf.partition(b"\r\n\r\n")
        if b" 101 " not in header.split(b"\r\n")[0]:
            raise RuntimeError(header.decode(errors="replace"))
        self.msg_id = 0
        self.events: list[dict] = []   # 未被 call() 消费的事件
        self.closed = False

    # ---------- 底层收发 ----------

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("WebSocket 已关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = bytes([0x80 | opcode, 0x80 | n])
        elif n < 65536:
            header = bytes([0x80 | opcode, 0x80 | 126]) + struct.pack(">H", n)
        else:
            header = bytes([0x80 | opcode, 0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def _recv_json(self) -> dict:
        msg = b""
        while True:
            b1 = self._recv_exact(1)[0]
            b2 = self._recv_exact(1)[0]
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(ln)
            if masked:
                mask = payload[:4]
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload[4:]))
            if opcode == 0x9:      # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0x8:
                self.closed = True
                raise ConnectionError("WebSocket 服务端关闭连接")
            msg += payload
            if fin:
                return json.loads(msg.decode("utf-8", "replace"))

    def send(self, obj: dict) -> None:
        self._send_frame(0x1, json.dumps(obj).encode())

    def call(self, method: str, params: dict | None = None) -> dict:
        """发命令并等待结果；期间收到的事件存入 self.events。"""
        self.msg_id += 1
        mid = self.msg_id
        try:
            self.send({"id": mid, "method": method, "params": params or {}})
        except OSError as e:
            raise CDPError(f"{method} 发送失败: {e}") from e
        while True:
            try:
                d = self._recv_json()
            except socket.timeout as e:
                raise CDPError(f"{method} 等待超时") from e
            if d.get("id") == mid:
                if "error" in d:
                    raise CDPError(f"{method} 失败: {d['error']}")
                return d.get("result", {})
            self.events.append(d)

    def drain(self) -> list[dict]:
        """把 socket 里已缓冲的事件全部收进 self.events 并返回新事件。

        做法：发一个无副作用的命令，借收包循环把排队事件全部读出来。
        """
        try:
            self.call("Runtime.evaluate", {"expression": "1", "returnByValue": True})
        except (CDPError, ConnectionError):
            pass
        out = self.events[:]
        self.events.clear()
        return out

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass
        self.closed = True

    # ---------- 便捷方法 ----------

    def eval(self, expression: str, await_promise: bool = True):
        """执行 JS 并返回结果值；页面抛异常时抛 CDPError。"""
        r = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        if r.get("exceptionDetails"):
            desc = r["exceptionDetails"].get("exception", {}).get("description") \
                or json.dumps(r["exceptionDetails"], ensure_ascii=False)
            raise CDPError(f"JS 异常: {desc[:300]}")
        return r.get("result", {}).get("value")

    def eval_json(self, expression: str):
        """执行返回 JSON 字符串的 JS，并解析为 Python 对象。"""
        v = self.eval(expression)
        if v is None:
            return None
        return json.loads(v)

    def wait_for(self, expression: str, timeout: float = 30.0,
                 poll: float = 0.4, desc: str = "") -> bool:
        """轮询直到 JS 表达式为真。返回是否成功。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval(expression):
                    return True
            except CDPError:
                pass
            time.sleep(poll)
        return False

    def mouse_click(self, x: float, y: float) -> None:
        """在坐标处派发一次真实鼠标点击（按下+抬起）。"""
        for typ in ("mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", {
                "type": typ, "x": x, "y": y, "button": "left", "clickCount": 1,
            })

    def mouse_move(self, x: float, y: float) -> None:
        """把鼠标移到坐标（用于触发 hover 类控件，如头歌的「代码文件」下拉）。"""
        self.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})


def http_json(path: str, port: int = DEFAULT_PORT, timeout: float = 5.0):
    url = f"http://127.0.0.1:{port}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


class Browser:
    """浏览器级会话：管理目标标签页、加载扩展等。"""

    def __init__(self, port: int = DEFAULT_PORT):
        self.port = port
        self.ws = WS(http_json("/json/version", port)["webSocketDebuggerUrl"])

    # 标签页

    def pages(self, url_substr: str | None = None) -> list[dict]:
        out = []
        for t in http_json("/json", self.port):
            if t.get("type") != "page":
                continue
            if url_substr and url_substr not in t.get("url", ""):
                continue
            out.append(t)
        return out

    def find_page(self, url_substr: str) -> dict | None:
        pages = self.pages(url_substr)
        return pages[0] if pages else None

    def last_page(self, url_substr: str) -> dict | None:
        pages = self.pages(url_substr)
        return pages[-1] if pages else None

    def create_target(self, url: str = "about:blank", retries: int = 20) -> dict:
        tid = self.ws.call("Target.createTarget", {"url": url})["targetId"]
        for _ in range(retries):
            time.sleep(0.25)
            for t in http_json("/json", self.port):
                if t.get("id") == tid:
                    return t
        raise RuntimeError("创建标签页后找不到目标")

    def attach(self, target: dict) -> WS:
        ws = WS(target["webSocketDebuggerUrl"])
        ws.call("Runtime.enable")
        try:
            ws.call("Page.enable")
        except CDPError:
            pass
        return ws

    def close_target(self, target_id: str) -> None:
        try:
            self.ws.call("Target.closeTarget", {"targetId": target_id})
        except (CDPError, ConnectionError):
            pass

    def activate(self, target_id: str) -> None:
        try:
            self.ws.call("Target.activateTarget", {"targetId": target_id})
        except (CDPError, ConnectionError):
            pass

    # 扩展

    def extensions(self) -> list[dict]:
        try:
            return self.ws.call("Extensions.getExtensions").get("extensions", [])
        except CDPError:
            return []

    def close_browser(self) -> None:
        """请求整个浏览器退出（Browser.close）。"""
        try:
            self.ws.call("Browser.close")
        except (CDPError, ConnectionError, OSError):
            pass

    def ensure_extension(self, path: str) -> dict:
        """确保以解压形式加载了指定扩展，返回该扩展信息。"""
        abs_path = os.path.abspath(os.path.expanduser(path))
        for ext in self.extensions():
            if os.path.abspath(ext.get("path", "")) == abs_path:
                return ext
        try:
            res = self.ws.call("Extensions.loadUnpacked", {"path": abs_path})
        except CDPError as e:
            raise RuntimeError(
                f"无法自动加载扩展 {abs_path}（可在该浏览器里手动加载一次）：{e}"
            ) from e
        for ext in self.extensions():
            if ext.get("id") == res.get("id"):
                return ext
        return {"id": res.get("id"), "path": abs_path}


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    b = Browser(port)
    for t in b.pages():
        print(f"{t.get('id')} | {t.get('title', '')[:50]} | {t.get('url', '')[:100]}")
