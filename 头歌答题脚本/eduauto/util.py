"""通用小工具：日志 / 退出 / 名称归一化。"""

import re
import sys


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str, code: int = 2) -> None:
    log(f"\n✗ {msg}")
    sys.exit(code)


def norm(s: str) -> str:
    """归一化：去掉所有空白（含全角空格）。"""
    return re.sub(r"[\s\u3000]+", "", s or "")
