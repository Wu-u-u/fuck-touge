"""配置读取与档案槽位状态（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

from pathlib import Path
import json
import os
import re
import time
import tomllib

from eduauto.util import log

HERE = Path(__file__).resolve().parent.parent  # 脚本目录（eduauto 的上一级）


STATE_FILE = HERE / "state.json"                      # 档案槽位记忆


PROFILE_BASE = Path("~/.config/educoder-auto").expanduser()   # 脚本自建档案的存放目录


SLOT_RE = re.compile(r"^(new|[1-9][0-9]?|[1-9][0-9]?new)$")   # 1-99 / new / 1new


DEFAULT_CONFIG = {
    "edge": {
        "binary": "/usr/bin/microsoft-edge-stable",
        "profile": "~/.config/microsoft-edge-debug",
        "port": 9222,
        "extension": str(HERE.parent / "Fuck头歌"),
        "classroom": "https://www.educoder.net/classrooms/JODEM6CH/shixun_homework",
    },
    "run": {
        "answers": str(HERE / "answers.toml"),
        "eval_timeout": 180,      # 单次评测最长等待（秒）
        "level_timeout": 60,      # 页面加载/跳转最长等待（秒）
    },
}


def load_config(path: Path) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))     # 深拷贝默认值
    if path.exists():
        with open(path, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
            else:
                cfg[section] = values
    return cfg


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict) -> None:
    try:
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as e:
        log(f"  ! 槽位状态写入失败：{e}")


def apply_current_profile(cfg: dict) -> str:
    """把「当前记住的档案槽」应用进配置，返回槽位名（没有则空串）。"""
    state = load_state()
    cur = state.get("current")
    slots = state.get("slots", {})
    if cur and slots.get(cur):
        cfg["edge"]["profile"] = slots[cur]
        return cur
    return ""


def setup_slot(cfg: dict, arg: str | None) -> tuple[str, str, str]:
    """解析 browser 的槽位参数并记住，返回 (槽位名, 档案路径, 备注)。

      browser 1       记住并切到 1 号档案（1 号默认就是 config 里的档案）
      browser 2~99    记住并切到对应档案；新槽会新建一个干净档案（需登录一次）
      browser new     每次都开一个全新档案（本次记住为 new，下次再全新）
      browser 1new    清除 1 号的记忆，换成全新档案（旧档案不删）
    """
    state = load_state()
    slots = state.setdefault("slots", {})

    if arg is None:
        cur = state.get("current")
        if cur and slots.get(cur):
            return cur, slots[cur], ""
        prof = os.path.expanduser(cfg["edge"]["profile"])
        slots["1"] = prof
        state["current"] = "1"
        save_state(state)
        return "1", prof, "（首次使用：当前 config 档案已记为槽 1）"

    if arg == "new":
        prof = str(PROFILE_BASE / f"guest-{time.strftime('%Y%m%d-%H%M%S')}")
        slots["new"] = prof
        state["current"] = "new"
        save_state(state)
        return "new", prof, "（全新档案；下次 browser new 又是一个全新的）"

    m = re.fullmatch(r"([1-9][0-9]?)new", arg)
    if m:
        n = m.group(1)
        old = slots.get(n)
        prof = str(PROFILE_BASE / f"slot{n}-{time.strftime('%Y%m%d-%H%M%S')}")
        slots[n] = prof
        state["current"] = n
        save_state(state)
        note = f"（已清除槽 {n} 的记忆，改用全新档案"
        if old:
            note += f"；旧档案未删除，在 {old}"
        note += "）"
        return n, prof, note

    n = arg
    if n in slots:
        state["current"] = n
        save_state(state)
        return n, slots[n], ""
    if n == "1":
        prof = os.path.expanduser(cfg["edge"]["profile"])
        note = "（当前 config 档案已记为槽 1）"
    else:
        prof = str(PROFILE_BASE / f"slot{n}")
        note = "（新槽位：干净档案，需要登录一次）"
    os.makedirs(prof, exist_ok=True)
    slots[n] = prof
    state["current"] = n
    save_state(state)
    return n, prof, note


def remember_name(slot: str, name: str) -> None:
    """把账号名记进 state.json 的 names 映射（供 browser -ls 显示）。"""
    if not slot or not name:
        return
    state = load_state()
    names = state.setdefault("names", {})
    if names.get(slot) != name:
        names[slot] = name
        save_state(state)
