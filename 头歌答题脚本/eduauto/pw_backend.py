"""Playwright 后端适配器骨架（D1）。

默认答题路径仍然走 `cdp.py`，本模块只提供一个最小兼容层：
把现有代码用到的 `WS` / `Browser` 调用面映射到 Playwright 的 Page / Browser
对象上，用于验证 Playwright 能否接管已经运行的调试 Edge。

设计约束：
  · 不启动新浏览器、不重新登录：只通过 ``connect_over_cdp`` 接管已有调试 Edge；
  · 不关闭共享浏览器：``PlaywrightBrowser.close_browser()`` 明确拒绝执行
    ``Browser.close``，避免误关用户正在使用的 Edge；
  · 未实现的 CDP 方法一律抛 ``NotImplementedError``，不静默假装成功。

安装（仅 Playwright 后端需要，核心脚本仍可只用标准库运行）::

    python3 -m pip install -r requirements.txt

连接现有 Edge 不需要再执行 ``playwright install`` 下载浏览器内核。

可选工厂（D1 尚未接入 ``答题.py`` 的默认 CLI 路径，默认行为不变）::

    from eduauto.pw_backend import make_browser
    browser = make_browser(cfg)      # 默认 cdp；设置 EDUAUTO_BACKEND=playwright 时走本模块
"""

from __future__ import annotations

import json
import os
import time

import cdp
from eduauto.util import log

DEFAULT_PORT = 9222


class PlaywrightBackendError(cdp.CDPError):
    """Playwright 后端的统一异常。

    继承 ``cdp.CDPError``，这样现有 ``except cdp.CDPError`` 的调用点无需改动。
    """


def _load_sync_playwright():
    """延迟导入 Playwright，避免未安装时影响核心脚本与单元测试。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise PlaywrightBackendError(
            "未安装 Playwright。请先运行：python3 -m pip install -r requirements.txt"
        ) from e
    return sync_playwright


def _page_closed(page) -> bool:
    try:
        return bool(page.is_closed())
    except Exception:
        return True


def _page_url(page) -> str:
    try:
        return page.url or ""
    except Exception:
        return ""


class PlaywrightWS:
    """一个 Playwright 页面会话，兼容 ``cdp.WS`` 的常用方法。

    注意：这里的 ``close()`` 只结束本适配器会话，**不会关闭标签页**，
    与 CDP 里关闭 WebSocket 会话的语义一致。
    """

    def __init__(self, page, target: dict | None = None):
        self.page = page
        self.target = target or {}
        self.closed = False
        self.events: list[dict] = []       # 兼容 cdp.WS 的属性，当前后端不产生事件

    # ---------- 内部 ----------

    def _ensure_open(self) -> None:
        if self.closed:
            raise PlaywrightBackendError("Playwright 会话已关闭")
        if _page_closed(self.page):
            raise PlaywrightBackendError("标签页已关闭")

    # ---------- 求值 ----------

    def eval(self, expression: str, await_promise: bool = True):
        """执行 JS 并返回结果；异常包装成 ``PlaywrightBackendError``。

        ``await_promise=False`` 仅为保持签名兼容：Playwright 的
        ``page.evaluate`` 会始终等待 Promise，本骨架不提供关闭等待的开关。
        """
        self._ensure_open()
        try:
            return self.page.evaluate(expression)
        except Exception as e:
            raise PlaywrightBackendError(f"JS 执行失败: {e}") from e

    def eval_json(self, expression: str):
        """执行返回 JSON 的 JS 并解析。

        兼容两种页面写法：返回 JSON 字符串时解析；Playwright 已经把结果
        转成 dict/list 时直接返回。
        """
        value = self.eval(expression)
        if value is None:
            return None
        if isinstance(value, (dict, list, int, float, bool)):
            return value
        try:
            return json.loads(value)
        except (TypeError, ValueError) as e:
            raise PlaywrightBackendError(
                f"eval_json 结果不是合法 JSON: {str(value)[:200]}"
            ) from e

    # ---------- 命令 ----------

    def call(self, method: str, params: dict | None = None) -> dict:
        """最小 CDP 方法映射。

        只支持当前脚本确实用到的两个页面级方法；其余方法明确抛
        ``NotImplementedError``，便于后续按需补齐。
        """
        params = params or {}
        if method == "Page.navigate":
            url = params.get("url")
            if not isinstance(url, str) or not url:
                raise PlaywrightBackendError("Page.navigate 缺少 url 参数")
            self._ensure_open()
            try:
                self.page.goto(url)
            except Exception as e:
                raise PlaywrightBackendError(f"Page.navigate 失败: {e}") from e
            return {}
        if method == "Page.bringToFront":
            self._ensure_open()
            try:
                self.page.bring_to_front()
            except Exception as e:
                raise PlaywrightBackendError(f"Page.bringToFront 失败: {e}") from e
            return {}
        raise NotImplementedError(f"Playwright 后端未实现 CDP 方法：{method}")

    # ---------- 等待 ----------

    def wait_for(self, expression: str, timeout: float = 30.0,
                 poll: float = 0.4, desc: str = "") -> bool:
        """轮询直到 JS 表达式为真；返回是否成功。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.eval(expression):
                    return True
            except cdp.CDPError:
                pass
            time.sleep(poll)
        return False

    # ---------- 鼠标 ----------

    def mouse_click(self, x: float, y: float) -> None:
        self._ensure_open()
        try:
            self.page.mouse.click(x, y)
        except Exception as e:
            raise PlaywrightBackendError(f"鼠标点击失败: {e}") from e

    def mouse_move(self, x: float, y: float) -> None:
        self._ensure_open()
        try:
            self.page.mouse.move(x, y)
        except Exception as e:
            raise PlaywrightBackendError(f"鼠标移动失败: {e}") from e

    # ---------- 生命周期 ----------

    def close(self) -> None:
        """结束会话（不关闭标签页）。"""
        self.closed = True


class PlaywrightBrowser:
    """浏览器级适配器：管理标签页与 target id 映射。

    ``browser`` 是 ``chromium.connect_over_cdp()`` 返回的 Playwright Browser。
    不调用 ``browser.close()``：对 CDP 连接的浏览器来说那会真的关闭 Edge。
    """

    def __init__(self, browser, playwright=None, port: int = DEFAULT_PORT,
                 cdp_url: str | None = None):
        self.browser = browser
        self.playwright = playwright
        self.port = int(port)
        self.cdp_url = cdp_url or f"http://127.0.0.1:{self.port}"
        self.closed = False
        # 以 Playwright page 对象为 key，维持稳定、对外的 target id。
        self._ids: dict[object, str] = {}
        self._pages: dict[str, object] = {}
        self._next_id = 1

    # ---------- 内部 ----------

    def _target_id(self, page) -> str:
        tid = self._ids.get(page)
        if tid is None:
            tid = f"pw-{self._next_id}"
            self._next_id += 1
            self._ids[page] = tid
            self._pages[tid] = page
        return tid

    def _forget(self, page) -> None:
        tid = self._ids.pop(page, None)
        if tid is not None:
            self._pages.pop(tid, None)

    def _refresh(self) -> None:
        for page in list(self._ids):
            if _page_closed(page):
                self._forget(page)

    def _iter_pages(self):
        seen = set()
        try:
            contexts = list(self.browser.contexts)
        except Exception as e:
            raise PlaywrightBackendError(f"读取浏览器上下文失败: {e}") from e
        for ctx in contexts:
            try:
                pages = list(ctx.pages)
            except Exception:
                continue
            for page in pages:
                if page in seen:
                    continue
                seen.add(page)
                if _page_closed(page):
                    continue
                yield page

    def _target(self, page) -> dict:
        return {"id": self._target_id(page), "url": _page_url(page), "type": "page"}

    def _resolve_page(self, target):
        if target is None:
            raise PlaywrightBackendError("attach 需要 target")
        if hasattr(target, "evaluate") and hasattr(target, "goto"):
            return target
        tid = target.get("id") if isinstance(target, dict) else None
        if not tid:
            raise PlaywrightBackendError("attach 的 target 缺少 id")
        self._refresh()
        page = self._pages.get(tid)
        if page is None:
            # 允许传入外部拿到的 target：重新扫描一遍再查。
            for p in self._iter_pages():
                self._target_id(p)
            page = self._pages.get(tid)
        if page is None or _page_closed(page):
            raise PlaywrightBackendError(f"找不到目标标签页：{tid}")
        return page

    def _context(self):
        contexts = list(self.browser.contexts)
        if contexts:
            return contexts[0]
        return self.browser.new_context()

    # ---------- 标签页 ----------

    def pages(self, url_substr: str | None = None) -> list[dict]:
        self._refresh()
        out = []
        for page in self._iter_pages():
            url = _page_url(page)
            if url_substr and url_substr not in url:
                continue
            out.append(self._target(page))
        return out

    def find_page(self, url_substr: str) -> dict | None:
        pages = self.pages(url_substr)
        return pages[0] if pages else None

    def last_page(self, url_substr: str) -> dict | None:
        pages = self.pages(url_substr)
        return pages[-1] if pages else None

    def attach(self, target) -> PlaywrightWS:
        page = self._resolve_page(target)
        return PlaywrightWS(page, self._target(page))

    def close_target(self, target_id: str) -> None:
        page = self._pages.get(target_id)
        if page is None:
            self._refresh()
            page = self._pages.get(target_id)
        if page is None:
            return
        try:
            page.close()
        except Exception as e:
            log(f"  ! 关闭标签页失败（{target_id}）：{e}")
        finally:
            self._forget(page)

    def create_target(self, url: str = "about:blank", retries: int = 20) -> dict:
        """在现有 context 里新建标签页并导航；不会启动新浏览器。"""
        context = self._context()
        page = context.new_page()
        try:
            if url and url != "about:blank":
                page.goto(url, wait_until="domcontentloaded")
        except Exception as e:
            try:
                page.close()
            except Exception:
                pass
            raise PlaywrightBackendError(f"创建标签页后导航失败: {e}") from e
        return self._target(page)

    # ---------- 浏览器级兼容 ----------

    def extensions(self) -> list[dict]:
        """骨架不查询扩展；返回空列表让调用方走兜底路径。"""
        return []

    def ensure_extension(self, path: str) -> dict | None:
        """骨架不管理扩展：现有 Edge 里已加载的扩展会继续生效。"""
        log("  · Playwright 后端骨架暂不管理扩展（沿用浏览器里已加载的扩展）")
        return None

    def close_browser(self) -> None:
        """明确不关闭共享浏览器。"""
        log("  ! Playwright 后端不会关闭共享浏览器（避免误关正在使用的 Edge）")

    def disconnect(self) -> None:
        """断开 Playwright 连接，但不关闭浏览器。"""
        if self.closed:
            return
        self.closed = True
        pw, self.playwright = self.playwright, None
        if pw is not None:
            try:
                pw.stop()
            except Exception:
                pass

    def close(self) -> None:
        """``disconnect`` 的别名；不会关闭浏览器。"""
        self.disconnect()


def connect_playwright(cfg: dict) -> PlaywrightBrowser:
    """通过 Playwright 接管已经运行的调试 Edge。

    不启动浏览器、不新建用户档案、不重新登录；要求目标端口已经由
    ``python3 答题.py browser``（或用户自己的 Edge 启动参数）开放。
    """
    edge = cfg.get("edge") if isinstance(cfg, dict) else None
    source = edge if isinstance(edge, dict) else (cfg if isinstance(cfg, dict) else {})
    port = int(source.get("port", DEFAULT_PORT))
    cdp_url = f"http://127.0.0.1:{port}"
    sync_playwright = _load_sync_playwright()
    pw = sync_playwright().start()
    try:
        browser = pw.chromium.connect_over_cdp(cdp_url)
    except Exception as e:
        try:
            pw.stop()
        except Exception:
            pass
        raise PlaywrightBackendError(
            f"无法通过 Playwright 接管调试端口 {port}：{e}\n"
            "  请确认 Edge 已用 --remote-debugging-port 启动"
            "（可先运行 python3 答题.py browser）。"
        ) from e
    return PlaywrightBrowser(browser, playwright=pw, port=port, cdp_url=cdp_url)


# ---------- 可选工厂：默认路径仍是 cdp ----------

def backend_name() -> str:
    """读取 ``EDUAUTO_BACKEND``，未设置时返回 ``cdp``。"""
    return (os.environ.get("EDUAUTO_BACKEND") or "cdp").strip().lower()


def make_browser(cfg: dict):
    """按环境变量选择后端；默认 ``cdp.Browser``，行为与现在一致。"""
    name = backend_name()
    if name in ("", "cdp"):
        return cdp.Browser(int(cfg["edge"]["port"]))
    if name == "playwright":
        return connect_playwright(cfg)
    raise ValueError(
        f"未知的 EDUAUTO_BACKEND：{name!r}（可选：cdp / playwright）"
    )
