"""浏览器后端统一接口（D5）。

答题脚本只依赖一个很小的浏览器/页面会话调用面：

  · ``BrowserLike``：枚举/查找/新建/关闭标签页，并 ``attach`` 出会话；
  · ``PageSessionLike``：求值、等待、鼠标、按键与关闭会话。

``cdp.Browser`` / ``cdp.WS``（默认后端）与
``pw_backend.PlaywrightBrowser`` / ``pw_backend.PlaywrightWS``（可选后端）
都在结构上满足这两个 Protocol；业务代码只按 Protocol 编程，不再关心
底层是手写 CDP 还是 Playwright。

后端选择只看环境变量 ``EDUAUTO_BACKEND``：

  · 未设置 / 空值 / ``cdp`` → 默认 ``cdp``，行为与旧版完全一致；
  · 显式 ``playwright`` → 使用 Playwright 接管已运行的调试 Edge；
  · 其他未知值 → 本模块只如实返回，调用方按默认 ``cdp`` 处理并提示。

本模块不导入 ``cdp`` 或 ``playwright``，避免可选依赖影响默认路径。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Protocol, runtime_checkable

DEFAULT_BACKEND = "cdp"
PLAYWRIGHT_BACKEND = "playwright"
SUPPORTED_BACKENDS = (DEFAULT_BACKEND, PLAYWRIGHT_BACKEND)


@runtime_checkable
class PageSessionLike(Protocol):
    """页面会话的最小调用面（``cdp.WS`` / ``PlaywrightWS``）。"""

    def eval(self, expression: str, await_promise: bool = True):
        """执行 JS 并返回结果。"""
        ...

    def eval_json(self, expression: str):
        """执行返回 JSON 的 JS 并解析为 Python 对象。"""
        ...

    def call(self, method: str, params: dict | None = None) -> dict:
        """发送一条底层命令（CDP 方法名或适配器映射）。"""
        ...

    def wait_for(self, expression: str, timeout: float = 30.0,
                 poll: float = 0.4, desc: str = "") -> bool:
        """轮询 JS 表达式直到为真，返回是否成功。"""
        ...

    def mouse_move(self, x: float, y: float) -> None:
        """移动鼠标到视口坐标。"""
        ...

    def mouse_click(self, x: float, y: float) -> None:
        """在视口坐标处点击。"""
        ...

    def close(self) -> None:
        """结束会话（不关闭标签页）。"""
        ...


@runtime_checkable
class BrowserLike(Protocol):
    """浏览器级最小调用面（``cdp.Browser`` / ``PlaywrightBrowser``）。"""

    def pages(self, url_substr: str | None = None) -> list[dict]:
        """列出标签页（可选的 URL 子串过滤）。"""
        ...

    def find_page(self, url_substr: str) -> dict | None:
        """返回第一个 URL 匹配的标签页。"""
        ...

    def last_page(self, url_substr: str) -> dict | None:
        """返回最后一个 URL 匹配的标签页。"""
        ...

    def create_target(self, url: str = "about:blank", retries: int = 20) -> dict:
        """新建并导航一个标签页，返回其 target 信息。"""
        ...

    def attach(self, target: dict) -> PageSessionLike:
        """连接某个标签页，返回页面会话。"""
        ...

    def close_target(self, target_id: str) -> None:
        """关闭指定标签页（不存在时静默忽略）。"""
        ...


def backend_name(environ: Mapping[str, str] | None = None) -> str:
    """读取 ``EDUAUTO_BACKEND``；未设置/空值返回默认 ``cdp``。

    ``environ`` 可注入（测试用）；默认读进程环境变量。
    """
    source = os.environ if environ is None else environ
    raw = source.get("EDUAUTO_BACKEND")
    if raw is None:
        return DEFAULT_BACKEND
    name = str(raw).strip().lower()
    return name or DEFAULT_BACKEND


def is_playwright(environ: Mapping[str, str] | None = None) -> bool:
    """是否显式选择了 Playwright 后端（只有精确值 ``playwright`` 才算）。"""
    return backend_name(environ) == PLAYWRIGHT_BACKEND


def unknown_backend(environ: Mapping[str, str] | None = None) -> str | None:
    """返回未知的后端名；合法或未设置时返回 ``None``。"""
    name = backend_name(environ)
    return None if name in SUPPORTED_BACKENDS else name
