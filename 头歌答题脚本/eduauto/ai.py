"""可选的 AI 答案草稿接口（OpenAI-compatible）。

只生成草稿，不直接写入答案档案、不自动提交；供 TUI/未来界面调用。
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from dataclasses import dataclass

from eduauto.util import die, log


class AIError(RuntimeError):
    pass


@dataclass
class AIConfig:
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    api_key_env: str = "OPENAI_API_KEY"
    timeout: float = 60.0


def from_config(cfg: dict) -> AIConfig:
    raw = cfg.get("ai") if isinstance(cfg.get("ai"), dict) else {}
    return AIConfig(
        base_url=str(raw.get("base_url") or AIConfig.base_url).rstrip("/"),
        model=str(raw.get("model") or AIConfig.model),
        api_key_env=str(raw.get("api_key_env") or AIConfig.api_key_env),
        timeout=float(raw.get("timeout") or AIConfig.timeout),
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
        letters = sorted(set(re.findall(r"[A-Za-z]", text)))
        if not letters:
            raise AIError("AI 没有返回选项字母")
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
    api_key = os.environ.get(ac.api_key_env, "").strip()
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
    return normalize_answer(str(text), kind)


def cmd_ai(args, cfg: dict) -> None:
    prompt = " ".join(getattr(args, "prompt", []) or []).strip()
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
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
        log(f"  ✓ 草稿已保存：{path}（未写入档案、未提交）")
    print(text)
