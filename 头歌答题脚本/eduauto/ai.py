"""可选的 AI 答案草稿接口（OpenAI-compatible）。

只生成草稿，不直接写入答案档案、不自动提交；供 TUI/未来界面调用。
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from dataclasses import dataclass

from eduauto.util import die, log


class AIError(RuntimeError):
    pass


@dataclass
class AIConfig:
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-chat"
    api_key_env: str = "OPENAI_API_KEY"
    api_key_file: str = "~/.config/educoder-auto/ai.toml"
    api_key: str = ""
    timeout: float = 60.0


def from_config(cfg: dict) -> AIConfig:
    raw = cfg.get("ai") if isinstance(cfg.get("ai"), dict) else {}
    local = {}
    key_file = Path(str(raw.get("api_key_file") or AIConfig.api_key_file)).expanduser()
    if key_file.is_file():
        try:
            with open(key_file, "rb") as f:
                data = tomllib.load(f)
            local = data.get("ai") if isinstance(data.get("ai"), dict) else {}
        except (OSError, tomllib.TOMLDecodeError):
            local = {}
    return AIConfig(
        base_url=str(raw.get("base_url") or local.get("base_url") or AIConfig.base_url).rstrip("/"),
        model=str(raw.get("model") or local.get("model") or AIConfig.model),
        api_key_env=str(raw.get("api_key_env") or local.get("api_key_env") or AIConfig.api_key_env),
        api_key_file=str(key_file),
        api_key=str(local.get("api_key") or raw.get("api_key") or ""),
        timeout=float(raw.get("timeout") or local.get("timeout") or AIConfig.timeout),
    )


def _system_prompt(kind: str) -> str:
    if kind == "choice":
        return (
            "你是一个头歌选择题答题助手。只输出最终选项字母，多个选项用英文逗号分隔；"
            "不要解释，不要 Markdown，不要输出题号。"
        )
    return (
        "你是一个头歌代码题答题助手。只输出可直接粘贴的完整代码，"
        "不要 Markdown 代码围栏，不要解释。"
    )


def normalize_answer(text: str, kind: str) -> str:
    """把模型输出收敛成可粘贴格式：choice 只留字母，code 去围栏。"""
    text = str(text or "").strip()
    if kind == "choice":
        compact = text.strip()
        if re.fullmatch(r"[A-Za-z]{1,8}", compact):
            letters = [c.upper() for c in compact]
        else:
            # 只认独立的 A/B/C 字母，避免把 Java、JSON 里的字母当选项
            letters = [c.upper() for c in re.findall(
                r"(?<![A-Za-z])([A-Za-z])(?![A-Za-z])", text)]
        letters = sorted(set(letters))
        if not letters:
            raise AIError("AI 没有返回独立选项字母")
        return ",".join(letters)
    match = re.match(r"^```[^\n]*\n(.*?)\n```\s*$", text, re.S)
    if match:
        return match.group(1).strip()
    return text


def draft_answer(prompt: str, cfg: dict, *, kind: str = "code",
                 context: str = "") -> str:
    """调用 OpenAI-compatible /chat/completions，返回纯文本草稿。"""
    if not str(prompt or "").strip():
        raise AIError("题目为空")
    ac = from_config(cfg)
    api_key = str(ac.api_key or "").strip() or os.environ.get(ac.api_key_env, "").strip()
    if not api_key:
        raise AIError(f"未设置 {ac.api_key_env}；只生成草稿，不读取配置文件里的密钥")
    messages = [{"role": "system", "content": _system_prompt(kind)}]
    user = str(prompt).strip()
    if context.strip():
        user = f"{user}\n\n补充上下文：\n{context.strip()}"
    messages.append({"role": "user", "content": user})
    body = json.dumps({
        "model": ac.model,
        "messages": messages,
        "temperature": 0.2,
    }, ensure_ascii=False).encode()
    req = urllib.request.Request(
        ac.base_url + "/chat/completions",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=ac.timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AIError(f"AI 请求失败：{e}") from e
    except json.JSONDecodeError as e:
        raise AIError(f"AI 返回不是 JSON：{e}") from e
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise AIError("AI 返回缺少 choices[0].message.content") from e
    if not str(text or "").strip():
        raise AIError("AI 返回空内容")
    result = normalize_answer(str(text), kind)
    if not str(result or "").strip():
        raise AIError("AI 返回空内容")
    return result


DRAFT_INDEX = Path(__file__).resolve().parent.parent / "ai-drafts" / "index.tsv"


def save_draft(path: Path, text: str) -> None:
    """原子写草稿，避免中途失败留下半截文件。"""
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp",
                                    dir=str(target.parent))
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(str(text).rstrip() + "\n")
        os.replace(tmp, target)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


AI_LOG = Path(__file__).resolve().parent.parent / "ai-logs" / "operations.tsv"


def record_operation(op: str, detail: str = "", status: str = "ok") -> None:
    """记录 AI 操作摘要；不记录密钥。"""
    try:
        AI_LOG.parent.mkdir(parents=True, exist_ok=True)
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{op}\t{status}\t{detail[:500]}\n"
        with AI_LOG.open("a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def record_draft(path: Path, index: Path | None = None) -> None:
    """把 CLI/TUI 保存的草稿登记到最近草稿索引；只写本地索引。"""
    target = index or DRAFT_INDEX
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        absolute = Path(path).expanduser().resolve()
        with target.open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{absolute}\n")
    except OSError:
        pass


def cmd_ai(args, cfg: dict) -> None:
    prompt = " ".join(getattr(args, "prompt", []) or []).strip()
    if not prompt:
        try:
            import sys
            if not sys.stdin.isatty():
                prompt = sys.stdin.read().strip()
        except OSError:
            prompt = ""
    if not prompt:
        die("用法：python3 答题.py ai \"题目...\" ｜ 或从 stdin 输入")
    log(f"  AI 模型：{from_config(cfg).model}（仅生成草稿，不会自动提交）")
    try:
        text = draft_answer(prompt, cfg, kind=args.kind, context=args.context)
    except AIError as e:
        die(str(e))
    out = str(getattr(args, "out", "") or "").strip()
    if out:
        path = Path(out).expanduser()
        save_draft(path, text)
        record_draft(path)
        log(f"  ✓ 草稿已保存：{path}（已登记最近草稿；未写入档案、未提交）")
    print(text)
