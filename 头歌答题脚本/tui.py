#!/usr/bin/env python3
"""Fuck头歌 的轻量 Textual 控制台。

运行（推荐，不改系统 Python）：
    uv run --with textual python tui.py

也可以先安装 textual：
    python3 -m pip install --user -r requirements-tui.txt
    python3 tui.py
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTRY = HERE / "答题.py"


def _build_app():
    """构建 Textual App 类；只在此函数内导入 Textual。"""
    try:
        from textual import work
        from textual.app import App, ComposeResult
        from textual.containers import Horizontal, Vertical
        from textual.widgets import Button, Footer, Header, Input, RichLog, Static, TextArea
    except ImportError:
        print("缺少 Textual。推荐运行：")
        print("  uv run --with textual python tui.py")
        print("或：python3 -m pip install --user -r requirements-tui.txt")
        raise SystemExit(2)

    class FuckTougeTui(App):
        TITLE = "Fuck 头歌 · 控制台"
        SUB_TITLE = "答题脚本 v0.9.50"
        BINDINGS = [("q", "quit", "退出")]

        CSS = """
        Screen { layout: vertical; }
        #top { height: auto; padding: 1 2; }
        #status { height: 3; padding: 0 2; color: $text-muted; }
        #slot { width: 16; }
        #course { width: 1fr; }
        #ai_prompt { width: 1fr; }
        #preview { height: 8; margin: 0 2; border: round $accent; }
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
                yield Static("课程名或序号（可选；先「列课程」查看）", classes="hint")
                yield Input(id="course", placeholder="例如 4 / Java程序设计-2026秋")
                yield Static("AI 草稿（需要 OPENAI_API_KEY；只生成，不提交）", classes="hint")
                yield Input(id="ai_prompt", placeholder="粘贴题目描述/选项...")
                yield Static("AI 草稿预览（只读；确认不会自动提交）", classes="hint")
                yield TextArea("", id="preview", read_only=True)
                yield Static("操作", classes="hint")
            with Horizontal(id="actions"):
                yield Button("列课程", id="cd")
                yield Button("进入课程", id="cd_target")
                yield Button("打开浏览器", id="browser")
                yield Button("开始刷题", id="run", variant="success")
                yield Button("采集答案", id="harvest")
                yield Button("AI 代码", id="ai_code")
                yield Button("AI 选项", id="ai_choice")
                yield Button("确认草稿", id="confirm")
                yield Button("保存草稿", id="save_draft")
                yield Button("停止", id="stop", variant="error")
            yield RichLog(id="log", markup=False, wrap=True)
            yield Footer()

        def on_mount(self) -> None:
            self._proc: subprocess.Popen[str] | None = None
            self.query_one("#preview", TextArea).load_text("AI 草稿会显示在这里")
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

        def _save_draft(self) -> None:
            text = str(getattr(self, "_last_ai", "") or "").strip()
            if not text:
                self.query_one("#log", RichLog).write("没有可保存的 AI 草稿。")
                return
            folder = HERE / "ai-drafts"
            folder.mkdir(exist_ok=True)
            path = folder / f"ai-{time.strftime('%Y%m%d-%H%M%S')}.txt"
            path.write_text(text + "\n", encoding="utf-8")
            self.query_one("#log", RichLog).write(f"[草稿已保存：{path}；未写入档案、未提交]")

        def _show_preview(self, text: str) -> None:
            self._last_ai = text
            area = self.query_one("#preview", TextArea)
            try:
                area.load_text(text)
            except AttributeError:
                area.text = text
            self.query_one("#log", RichLog).write("[AI 草稿已放入预览，不会自动提交]")

        @work(thread=True, exclusive=True)
        def _ai_draft(self, kind: str, prompt: str) -> None:
            proc = subprocess.run(
                [sys.executable, str(ENTRY), "ai", "--kind", kind, prompt],
                cwd=str(HERE), capture_output=True, text=True,
            )
            text = (proc.stdout or "").strip()
            if proc.returncode != 0:
                text = (text + "\n" + (proc.stderr or "")).strip() or "AI 草稿生成失败"
            self.call_from_thread(self._show_preview, text)

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
            elif bid == "cd_target":
                target = (self.query_one("#course", Input).value or "").strip()
                if not target:
                    self.query_one("#log", RichLog).write("请先填写课程名或序号。")
                    return
                self._start(["cd", target])
            elif bid == "browser":
                self._start(["browser", self._slot()])
            elif bid == "run":
                self._start(["run", "-y"])
            elif bid == "harvest":
                self._start(["harvest"])
            elif bid in ("ai_code", "ai_choice"):
                prompt = (self.query_one("#ai_prompt", Input).value or "").strip()
                if not prompt:
                    self.query_one("#log", RichLog).write("请先填写 AI 题目。")
                    return
                kind = "code" if bid == "ai_code" else "choice"
                self._ai_draft(kind, prompt)
            elif bid == "confirm":
                text = str(self.query_one("#preview", TextArea).text or "").strip()
                self.query_one("#log", RichLog).write(
                    "[草稿已确认，但不会自动写入档案或提交]" if text else "[预览为空]"
                )
            elif bid == "save_draft":
                self._save_draft()
            elif bid == "stop":
                if self._proc is not None and self._proc.poll() is None:
                    self._proc.terminate()
                    self.query_one("#log", RichLog).write("[已发送停止信号]")

    return FuckTougeTui


def _run_selftest() -> None:
    try:
        import textual  # noqa: F401
    except ImportError as e:
        print(f"textual unavailable: {e}")
        raise SystemExit(2)

    async def smoke() -> None:
        app = _build_app()()
        async with app.run_test() as pilot:
            await pilot.pause()
            assert app.query_one("#log") is not None
            assert app.query_one("#ai_prompt") is not None
            assert app.query_one("#preview") is not None
            assert app.query_one("#confirm") is not None
            assert app.query_one("#save_draft") is not None
            assert app.query_one("#course") is not None
        print("tui selftest ok")

    asyncio.run(smoke())


def _run_with_textual() -> None:
    _build_app()().run()


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        _run_selftest()
    elif "--check" in sys.argv:
        try:
            import textual  # noqa: F401
        except ImportError as e:
            print(f"textual unavailable: {e}")
            raise SystemExit(2)
        print("tui ok")
    else:
        _run_with_textual()
