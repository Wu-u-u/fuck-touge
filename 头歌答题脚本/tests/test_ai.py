#!/usr/bin/env python3
"""AI 草稿接口单测：本地假 OpenAI-compatible HTTP，不访问外网。"""
import json
import os
import sys
import io
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eduauto.ai import (AIError, cmd_ai, draft_answer, normalize_answer,  # noqa: E402
                        record_draft, save_draft)

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


seen = {}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        seen["path"] = self.path
        seen["auth"] = self.headers.get("Authorization")
        seen["body"] = json.loads(self.rfile.read(n).decode("utf-8"))
        payload = {"choices": [{"message": {"content": "A,B"}}]}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


srv = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}/v1"
cfg = {"ai": {"base_url": base, "model": "fake-model",
              "api_key_env": "TEST_AI_KEY", "timeout": 5,
              "api_key_file": "/nonexistent/ai.toml"}}

with patch.dict(os.environ, {"TEST_AI_KEY": "test-secret"}):
    out = draft_answer("第一题选什么？", cfg, kind="choice", context="多选")
check("AI 返回纯文本草稿", out == "A,B", repr(out))
check("请求路径正确", seen.get("path") == "/v1/chat/completions", str(seen.get("path")))
check("模型与 system prompt 正确",
      seen.get("body", {}).get("model") == "fake-model"
      and seen.get("body", {}).get("messages", [{}])[0].get("role") == "system",
      str(seen.get("body"))[:300])
check("Authorization 来自环境变量", seen.get("auth") == "Bearer test-secret")
check("上下文进入 user message",
      "多选" in seen.get("body", {}).get("messages", [{}, {}])[1].get("content", ""))

with patch.dict(os.environ, {}, clear=True):
    try:
        draft_answer("x", cfg)
        check("无密钥失败", False)
    except AIError as e:
        check("无密钥失败", "TEST_AI_KEY" in str(e))

# --out 只保存草稿，不写档案、不提交
from types import SimpleNamespace
import tempfile
with tempfile.TemporaryDirectory() as td:
    out = Path(td) / "draft.txt"
    with patch.dict(os.environ, {"TEST_AI_KEY": "test-secret"}):
        cmd_ai(SimpleNamespace(prompt=["题目"], kind="choice", context="", out=str(out)), cfg)
    check("--out 保存纯文本草稿", out.read_text(encoding="utf-8").strip() == "A,B")

# 无位置参数时从 stdin 读题（帮助文案的契约）
class _Stdin(io.StringIO):
    def isatty(self):
        return False

with patch.dict(os.environ, {"TEST_AI_KEY": "test-secret"}):
    with patch("sys.stdin", _Stdin("stdin 里的题目")):
        cmd_ai(SimpleNamespace(prompt=[], kind="choice", context="", out=""), cfg)
check("AI 无参数时从 stdin 读取",
      "stdin 里的题目" in seen.get("body", {}).get("messages", [{}, {}])[1].get("content", ""),
      str(seen.get("body"))[:300])

check("choice 归一化只留字母",
      normalize_answer("答案：A、C。", "choice") == "A,C")
try:
    normalize_answer("答案是 Java 风格", "choice")
    check("choice 不把 Java 当选项", False, "没有抛错")
except AIError:
    check("choice 不把 Java 当选项", True)
check("code 去掉 Markdown 围栏",
      normalize_answer("```java\nclass A {}\n```", "code") == "class A {}")
check("空代码围栏去后为空",
      normalize_answer("```\n\n```", "code") == "")

with tempfile.TemporaryDirectory() as td:
    idx = Path(td) / "index.tsv"
    draft = Path(td) / "draft.txt"
    draft.write_text("A", encoding="utf-8")
    record_draft(draft, idx)
    stored = idx.read_text(encoding="utf-8").split("\t", 1)[1].strip()
    check("草稿索引保存绝对路径",
          Path(stored).is_absolute() and Path(stored) == draft.resolve(), stored)

with tempfile.TemporaryDirectory() as td:
    target = Path(td) / "draft.txt"
    save_draft(target, "line1\nline2")
    check("草稿原子写入内容正确",
          target.read_text(encoding="utf-8") == "line1\nline2\n",
          repr(target.read_text(encoding="utf-8")))
    check("草稿写入无临时文件残留", not target.with_name(target.name + ".tmp").exists())

srv.shutdown()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
