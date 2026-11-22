"""答题脚本状态上报：通过页面桥写入 Fuck头歌 popup。

不直接连扩展：脚本把 status/log postMessage 到当前 educoder 页面，
由 Fuck头歌 的 bridge.ts 写入 chrome.storage.local。浏览器窗口和焦点
行为不变。
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import cdp

SCRIPT_SOURCE = "fuck-touge-script"
HEARTBEAT_SEC = 2.0
MAX_LOGS = 25
STATE_FILE = Path(__file__).resolve().parent.parent / "state.status.json"


class StatusPublisher:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._browser = None
        self._slot = "1"
        self._state = "waiting"
        self._course = ""
        self._chapter = ""
        self._level = ""
        self._message = ""
        self._logs: list[dict[str, Any]] = []
        self._history: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._rust: subprocess.Popen[str] | None = None

    def attach(self, browser, slot: str | None = None) -> None:
        """绑定浏览器并启动心跳；重复调用会切换槽位并重启线程。"""
        try:
            from eduauto.util import set_log_hook
            set_log_hook(self.log)
        except Exception:
            pass
        self._stop_rust()
        with self._lock:
            self._browser = browser
            if slot:
                self._slot = str(slot)
            self._state = "waiting"
            self._message = "等待命令"
            self._stop.set()
            old = self._thread
        if old and old.is_alive() and old is not threading.current_thread():
            old.join(timeout=1.0)
        with self._lock:
            self._stop = threading.Event()
            t = threading.Thread(target=self._heartbeat, name="ft-status", daemon=True)
            self._thread = t
        t.start()
        self._start_rust()
        self.flush()

    def set_state(self, state: str, message: str = "") -> None:
        with self._lock:
            self._state = state
            if message:
                self._message = message

    def set_context(self, *, course: str | None = None, chapter: str | None = None,
                    level: str | None = None) -> None:
        with self._lock:
            if course is not None:
                self._course = course
            if chapter is not None:
                self._chapter = chapter
            if level is not None:
                self._level = level

    def log(self, msg: str) -> None:
        text = str(msg or "").strip()
        if not text:
            return
        level = "error" if text.startswith("✗") or "错误" in text else (
            "warn" if text.startswith(("!", "！")) or "失败" in text else "info")
        with self._lock:
            self._message = text[:200]
            self._logs.append({
                "at": int(time.time() * 1000),
                "level": level,
                "slot": self._slot,
                "course": self._course,
                "chapter": self._chapter,
                "levelName": self._level,
                "text": text[:300],
            })
            self._logs = self._logs[-MAX_LOGS:]
            self._history.append(self._logs[-1])
            self._history = self._history[-MAX_LOGS:]

    def error(self, msg: str) -> None:
        self.log(f"✗ {msg}")
        self.set_state("error", str(msg)[:200])
        self.flush()

    def finish(self) -> None:
        with self._lock:
            if self._state == "error":
                self._stop.set()
                return
        self.set_state("stopped", self._message or "已停止")
        self.flush()
        with self._lock:
            self._stop.set()
        self._stop_rust()
        try:
            from eduauto.util import set_log_hook
            set_log_hook(None)
        except Exception:
            pass

    def flush(self) -> None:
        with self._lock:
            browser = self._browser
            payload = {
                "version": 1,
                "updatedAt": int(time.time() * 1000),
                "state": self._state,
                "slot": self._slot,
                "course": self._course,
                "chapter": self._chapter,
                "level": self._level,
                "message": self._message,
                "logs": list(self._logs),
            }
            self._logs.clear()
        self._write_file(payload)
        if browser is None:
            return
        try:
            target = next((p for p in browser.pages()
                           if "educoder.net" in (p.get("url") or "")), None)
            if not target:
                return
            ws = browser.attach(target)
            try:
                expr = "window.postMessage(" + json.dumps({
                    "source": SCRIPT_SOURCE, "type": "status", "payload": payload,
                }, ensure_ascii=False) + ", '*')"
                ws.eval(expr)
            finally:
                ws.close()
        except (cdp.CDPError, OSError, AttributeError):
            pass

    def _start_rust(self) -> None:
        """可选的局部 Rust 试点：ftstatus 原子写状态快照；失败自动回退 Python。"""
        if os.environ.get("EDUAUTO_RUST_STATUS") != "1":
            return
        path = Path(__file__).resolve().parent.parent.parent / "rust/ftstatus/target/release/ftstatus"
        if not path.is_file():
            return
        try:
            self._rust = subprocess.Popen(
                [str(path), str(STATE_FILE)],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except OSError:
            self._rust = None

    def _stop_rust(self) -> None:
        if self._rust is None:
            return
        try:
            self._rust.stdin.close()
            self._rust.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            self._rust.kill()
        self._rust = None

    def _write_file(self, payload: dict) -> None:
        """给 TUI/调试用的本地状态快照；不影响浏览器桥。"""
        rust = self._rust
        if rust is not None and rust.poll() is None:
            try:
                rust.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                rust.stdin.flush()
                return
            except (OSError, ValueError):
                self._rust = None
        try:
            tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            os.replace(tmp, STATE_FILE)
        except OSError:
            pass

    def _heartbeat(self) -> None:
        while not self._stop.wait(HEARTBEAT_SEC):
            self.flush()


_PUB = StatusPublisher()


def get() -> StatusPublisher:
    return _PUB


def attach(browser, slot: str | None = None) -> None:
    _PUB.attach(browser, slot)


def set_state(state: str, message: str = "") -> None:
    _PUB.set_state(state, message)


def set_context(**kwargs) -> None:
    _PUB.set_context(**kwargs)


def log(msg: str) -> None:
    _PUB.log(msg)


def error(msg: str) -> None:
    _PUB.error(msg)


def finish() -> None:
    _PUB.finish()
