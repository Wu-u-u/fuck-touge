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
import atexit
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from eduauto.ai import record_draft, save_draft

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
        SUB_TITLE = "答题脚本 v0.9.76"
        BINDINGS = [("q", "quit", "退出")]

        CSS = """
        Screen { layout: vertical; background: #10141b; color: #dbe4f0; }
        Header { background: #182231; color: #cfe3ff; }
        Footer { background: #182231; color: #9fb0c7; }
        #body { height: 1fr; }
        #sidebar {
            width: 42; min-width: 34; padding: 1;
            background: #141b26; border-right: solid #2b3b52;
        }
        #main { width: 1fr; padding: 1 2; }
        #status {
            height: 4; padding: 1; border: round #3d6fa8;
            background: #172233; color: #d9e8ff;
        }
        #recent { height: 5; color: #8fa4bf; }
        #slot { width: 12; }
        #course { width: 1fr; }
        #ai_prompt { width: 1fr; height: 8; border: round #2b3b52; }
        #preview { height: 12; border: round #2b3b52; background: #111821; }
        #log { height: 1fr; border: round #2b3b52; background: #0e141d; }
        #actions, #ai_actions, #draft_actions { height: auto; padding: 1 0; }
        Button { width: 100%; margin: 0 0 1 0; background: #1b2a3d; color: #dbe4f0; }
        Button:hover { background: #27405c; }
        Button.-success { background: #1d4d3d; }
        Button.-error { background: #4a252c; }
        .hint { color: #8197b2; padding: 1 0 0 0; }
        .section { color: #9ec5ff; text-style: bold; padding: 1 0 0 0; }
        """

        def compose(self) -> ComposeResult:
            yield Header()
            with Horizontal(id="body"):
                with Vertical(id="sidebar"):
                    yield Static("等待脚本状态…", id="status")
                    yield Static("", id="recent")
                    yield Static("槽位", classes="hint")
                    yield Input(value="1", id="slot", placeholder="例如 1")
                    yield Static("课程（名称或列表序号）", classes="hint")
                    yield Input(id="course", placeholder="例如 4 / Java程序设计-2026秋")
                    yield Static("AI 题目 / 自主任务", classes="hint")
                    yield TextArea("", id="ai_prompt")
                    yield Static("操作", classes="section")
                    with Vertical(id="actions"):
                        yield Button("列课程", id="cd")
                        yield Button("进入课程", id="cd_target")
                        yield Button("打开浏览器", id="browser")
                        yield Button("开始刷题", id="run", variant="success")
                        yield Button("AI 限定范围", id="ai_scoped", variant="success")
                        yield Button("AI 完全自主", id="ai_autonomous", variant="success")
                        yield Button("采集答案", id="harvest")
                        yield Button("网页状态", id="webui")
                        yield Button("停止", id="stop", variant="error")
                with Vertical(id="main"):
                    yield Static("AI 预览 / 当前题面", classes="section")
                    yield TextArea("", id="preview", read_only=True)
                    with Horizontal(id="draft_actions"):
                        yield Button("AI 代码", id="ai_code")
                        yield Button("AI 选项", id="ai_choice")
                        yield Button("保存", id="save_draft")
                        yield Button("最近", id="recent_drafts")
                        yield Button("载入", id="load_recent")
                        yield Button("复制", id="copy_draft")
                        yield Button("清空", id="clear_preview")
                        yield Button("AI 日志", id="ai_log")
                    yield Static("实时日志", classes="section")
                    yield RichLog(id="log", markup=False, wrap=True)
            yield Footer()

        def on_mount(self) -> None:
            self._proc: subprocess.Popen[str] | None = None
            self._webui: subprocess.Popen[str] | None = None
            atexit.register(self._stop_webui)
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
                msg = str(d.get("message") or "").strip()
                text = f"{state}  槽位 {d.get('slot', '--')}" + (f"  {ctx}" if ctx else "")
                if msg:
                    text += "  " + msg[:100]
                logs = d.get("logs") if isinstance(d.get("logs"), list) else []
                recent = "\n".join(f"[{x.get('level', 'info')}] {x.get('text', '')[:120]}"
                                    for x in logs[-3:] if isinstance(x, dict))
            except (OSError, json.JSONDecodeError):
                recent = ""
            try:
                self.query_one("#status", Static).update(text)
                self.query_one("#recent", Static).update(recent)
            except Exception:
                pass

        def _slot(self) -> str:
            return (self.query_one("#slot", Input).value or "1").strip()

        def _clear_preview(self) -> None:
            self._last_ai = ""
            area = self.query_one("#preview", TextArea)
            try:
                area.load_text("")
            except AttributeError:
                area.text = ""
            self.query_one("#log", RichLog).write("[AI 预览已清空]")

        def _copy_draft(self) -> None:
            text = str(getattr(self, "_last_ai", "") or "").strip()
            if not text:
                self.query_one("#log", RichLog).write("没有可复制的 AI 草稿。")
                return
            try:
                self.copy_to_clipboard(text)
                self.query_one("#log", RichLog).write("[草稿已复制到剪贴板]")
            except Exception as e:
                self.query_one("#log", RichLog).write(f"[复制失败：{e}]")

        def _save_draft(self) -> None:
            text = str(getattr(self, "_last_ai", "") or "").strip()
            if not text:
                self.query_one("#log", RichLog).write("没有可保存的 AI 草稿。")
                return
            folder = HERE / "ai-drafts"
            folder.mkdir(exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            path = folder / f"ai-{stamp}-{time.time_ns() % 1_000_000:06d}.txt"
            save_draft(path, text)
            record_draft(path)
            self.query_one("#log", RichLog).write(f"[草稿已保存：{path}；未写入档案、未提交]")

        def _recent_ai_ops(self) -> None:
            path = HERE / "ai-logs" / "operations.tsv"
            try:
                lines = path.read_text(encoding="utf-8").splitlines()[-20:]
            except OSError:
                lines = []
            log = self.query_one("#log", RichLog)
            if not lines:
                log.write("还没有 AI 操作日志。")
                return
            log.write("最近 AI 操作：")
            for line in lines:
                log.write("  " + line)

        def _recent_drafts(self) -> None:
            index = HERE / "ai-drafts" / "index.tsv"
            try:
                lines = index.read_text(encoding="utf-8").splitlines()[-5:]
            except OSError:
                lines = []
            log = self.query_one("#log", RichLog)
            if not lines:
                log.write("还没有保存过 AI 草稿。")
                return
            log.write("最近草稿：")
            for line in reversed(lines):
                log.write("  " + line.replace("\t", "  "))

        def _load_latest_draft(self) -> None:
            index = HERE / "ai-drafts" / "index.tsv"
            try:
                line = index.read_text(encoding="utf-8").splitlines()[-1]
                path = Path(line.split("\t", 1)[1])
                if not path.is_absolute():
                    path = HERE / path
                text = path.read_text(encoding="utf-8")
            except (OSError, IndexError):
                self.query_one("#log", RichLog).write("没有可载入的 AI 草稿。")
                return
            self._show_preview(text)
            self.query_one("#log", RichLog).write(f"[已载入：{path}]")

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
            try:
                # 题目走 stdin，避免长题目/以 - 开头的题目被 argparse 当成参数。
                proc = subprocess.run(
                    [sys.executable, str(ENTRY), "ai", "--kind", kind],
                    cwd=str(HERE), capture_output=True, text=True, timeout=120,
                    input=prompt,
                )
                text = (proc.stdout or "").strip()
                if proc.returncode != 0:
                    text = (text + "\n" + (proc.stderr or "")).strip() or "AI 草稿生成失败"
            except subprocess.TimeoutExpired:
                text = "AI 草稿生成超时（120 秒）；请检查 API 地址/网络后重试。"
            except OSError as e:
                text = f"AI 草稿启动失败：{e}"
            self.call_from_thread(self._show_preview, text)

        def _stop_webui(self) -> None:
            if self._webui is not None and self._webui.poll() is None:
                self._webui.terminate()

        def action_quit(self) -> None:
            self._stop_webui()
            self.exit()

        def _start_webui(self) -> None:
            if self._webui is not None and self._webui.poll() is None:
                self.query_one("#log", RichLog).write("网页状态面板已在运行。")
                return
            sock = socket.socket()
            try:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            finally:
                sock.close()
            self._webui = subprocess.Popen(
                [sys.executable, str(HERE / "webui.py"), "--port", str(port)],
                cwd=str(HERE), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            self.query_one("#log", RichLog).write(
                f"[网页状态：http://127.0.0.1:{port} （只读）]"
            )

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
            elif bid == "ai_scoped":
                self.query_one("#log", RichLog).write(
                    "[AI 自动：将直接补齐当前课程空答案并自动评测；按钮即视为批准]"
                )
                self._start(["run", "-y", "--ai"])
            elif bid == "ai_autonomous":
                task = (self.query_one("#ai_prompt", TextArea).text or "").strip()
                self.query_one("#log", RichLog).write(
                    f"[AI 自主任务：{task or '处理当前课程未完成关卡'}]"
                )
                self.query_one("#log", RichLog).write(
                    "[当前版本先执行当前课程；需要换课程请在左侧课程框指定]"
                )
                self._start(["run", "-y", "--ai"])
            elif bid == "harvest":
                self._start(["harvest"])
            elif bid in ("ai_code", "ai_choice"):
                prompt = (self.query_one("#ai_prompt", TextArea).text or "").strip()
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
            elif bid == "clear_preview":
                self._clear_preview()
            elif bid == "copy_draft":
                self._copy_draft()
            elif bid == "webui":
                self._start_webui()
            elif bid == "save_draft":
                self._save_draft()
            elif bid == "ai_log":
                self._recent_ai_ops()
            elif bid == "recent_drafts":
                self._recent_drafts()
            elif bid == "load_recent":
                self._load_latest_draft()
            elif bid == "stop":
                if self._proc is not None and self._proc.poll() is None:
                    self._proc.terminate()
                    self.query_one("#log", RichLog).write("[已发送停止信号]")
                if self._webui is not None and self._webui.poll() is None:
                    self._webui.terminate()
                    self.query_one("#log", RichLog).write("[网页状态已停止]")

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
            assert app.query_one("#ai_scoped") is not None
            assert app.query_one("#ai_autonomous") is not None
            assert app.query_one("#ai_log") is not None
            assert app.query_one("#save_draft") is not None
            assert app.query_one("#copy_draft") is not None
            assert app.query_one("#clear_preview") is not None
            app._last_ai = "旧草稿"
            app._clear_preview()
            assert app._last_ai == ""
            assert app.query_one("#webui") is not None
            assert app.query_one("#recent_drafts") is not None
            assert app.query_one("#load_recent") is not None
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
