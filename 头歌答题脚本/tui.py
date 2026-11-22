#!/usr/bin/env python3
"""Fuck头歌 的轻量 Textual 控制台。

运行（推荐，不改系统 Python）：
    uv run --with textual python tui.py

也可以先安装 textual：
    python3 -m pip install --user -r requirements-tui.txt
    python3 tui.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = HERE / "答题.py"


def _run_with_textual() -> None:
    try:
        from textual import work
        from textual.app import App, ComposeResult
        from textual.containers import Horizontal, Vertical
        from textual.widgets import Button, Footer, Header, Input, RichLog, Static
    except ImportError:
        print("缺少 Textual。推荐运行：")
        print("  uv run --with textual python tui.py")
        print("或：python3 -m pip install --user -r requirements-tui.txt")
        raise SystemExit(2)

    class FuckTougeTui(App):
        TITLE = "Fuck 头歌 · 控制台"
        SUB_TITLE = "答题脚本 v0.9.41"
        BINDINGS = [("q", "quit", "退出")]

        CSS = """
        Screen { layout: vertical; }
        #top { height: auto; padding: 1 2; }
        #status { height: 3; padding: 0 2; color: $text-muted; }
        #slot { width: 16; }
        #actions { height: auto; padding: 0 2; }
        #log { height: 1fr; margin: 1 2; border: round $accent; }
        .hint { color: $text-muted; }
        """

        def compose(self) -> ComposeResult:
            yield Header()
            with Vertical(id="top"):
                yield Static("等待脚本状态…", id="status")
                yield Static("账号槽位（只使用你在输入框里指定的槽位）", classes="hint")
                yield Input(value="1", id="slot", placeholder="槽位，例如 1")
                yield Static("操作", classes="hint")
            with Horizontal(id="actions"):
                yield Button("列课程", id="cd")
                yield Button("打开浏览器", id="browser")
                yield Button("开始刷题", id="run", variant="success")
                yield Button("采集答案", id="harvest")
                yield Button("停止", id="stop", variant="error")
            yield RichLog(id="log", markup=False, wrap=True)
            yield Footer()

        def on_mount(self) -> None:
            self._proc: subprocess.Popen[str] | None = None
            self.query_one("#log", RichLog).write("Fuck 头歌 TUI 已启动。")
            self.set_interval(1, self._refresh_status)
            self._refresh_status()
            self.query_one("#log", RichLog).write(
                "先点「列课程」，或直接点「开始刷题」。运行日志会显示在这里。"
            )

        def _refresh_status(self) -> None:
            path = HERE / "state.status.json"
            text = "等待脚本状态…"
            try:
                d = json.loads(path.read_text(encoding="utf-8"))
                state = {"running": "运行中", "waiting": "等待中", "stopped": "已停止", "error": "错误"}.get(d.get("state"), d.get("state") or "?")
                ctx = " · ".join(x for x in (d.get("course"), d.get("chapter"), d.get("level")) if x)
                text = f"{state}  槽位 {d.get('slot', '--')}" + (f"  {ctx}" if ctx else "")
            except (OSError, json.JSONDecodeError):
                pass
            try:
                self.query_one("#status", Static).update(text)
            except Exception:
                pass

        def _slot(self) -> str:
            return (self.query_one("#slot", Input).value or "1").strip()

        def _start(self, args: list[str]) -> None:
            if self._proc is not None and self._proc.poll() is None:
                self.query_one("#log", RichLog).write("已有任务在运行，先点「停止」或等结束。")
                return
            log = self.query_one("#log", RichLog)
            log.write(f"$ python3 答题.py {' '.join(args)}")
            self._proc = subprocess.Popen(
                [sys.executable, str(ENTRY), *args],
                cwd=str(HERE),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            self._read_log(self._proc)

        @work(thread=True, exclusive=True)
        def _read_log(self, proc: subprocess.Popen[str]) -> None:
            log = self.query_one("#log", RichLog)
            if proc.stdout is not None:
                for line in proc.stdout:
                    self.call_from_thread(log.write, line.rstrip())
            rc = proc.wait()
            self.call_from_thread(log.write, f"[进程结束，退出码 {rc}]")
            self._proc = None

        def on_button_pressed(self, event: Button.Pressed) -> None:
            bid = event.button.id
            if bid == "cd":
                self._start(["cd"])
            elif bid == "browser":
                self._start(["browser", self._slot()])
            elif bid == "run":
                self._start(["run", "-y"])
            elif bid == "harvest":
                self._start(["harvest"])
            elif bid == "stop":
                if self._proc is not None and self._proc.poll() is None:
                    self._proc.terminate()
                    self.query_one("#log", RichLog).write("[已发送停止信号]")

    FuckTougeTui().run()


if __name__ == "__main__":
    if "--check" in sys.argv:
        try:
            import textual  # noqa: F401
        except ImportError as e:
            print(f"textual unavailable: {e}")
            raise SystemExit(2)
        print("tui ok")
    else:
        _run_with_textual()
