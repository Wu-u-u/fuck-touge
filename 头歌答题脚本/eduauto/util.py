"""通用小工具：日志 / 退出 / 名称归一化。"""

import re
import sys

_LOG_HOOK = None


def set_log_hook(fn) -> None:
    """安装日志旁路（状态上报用）；None 表示卸载。"""
    global _LOG_HOOK
    _LOG_HOOK = fn


def log(msg: str) -> None:
    print(msg, flush=True)
    hook = _LOG_HOOK
    if hook is not None:
        try:
            hook(str(msg))
        except Exception:
            pass


def die(msg: str, code: int = 2) -> None:
    log(f"\n✗ {msg}")
    try:
        from eduauto import status
        status.error(str(msg))
    except Exception:
        pass
    sys.exit(code)


def norm(s: str) -> str:
    """归一化：去掉所有空白（含全角空格）。"""
    return re.sub(r"[\s\u3000]+", "", s or "")


def fmt_secs(s: float) -> str:
    """秒数格式化成易读短串（用于日志里的用时统计）。"""
    s = float(s)
    return f"{s:.0f} 秒" if s < 90 else f"{s / 60:.1f} 分钟"
