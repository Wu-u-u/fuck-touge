"""配置读取与档案槽位状态（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

from pathlib import Path
import json
import math
import os
import re
import time
import tomllib

from eduauto.util import die, log

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
    cfg_path = path.expanduser()
    if cfg_path.exists():
        try:
            with open(cfg_path, "rb") as f:
                user = tomllib.load(f)
        except tomllib.TOMLDecodeError as e:
            die(f"配置文件 TOML 语法错误：{cfg_path}\n  {e}")
        except OSError as e:
            die(f"配置文件读取失败：{cfg_path}\n  {e}")
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
            else:
                cfg[section] = values
        run = cfg.get("run")
        if isinstance(run, dict):
            ans = run.get("answers")
            if isinstance(ans, str) and ans and not Path(ans).expanduser().is_absolute():
                run["answers"] = str(cfg_path.resolve().parent / ans)
    if not isinstance(cfg.get("edge"), dict) or not isinstance(cfg.get("run"), dict):
        die("配置文件格式错误：edge / run 必须是 TOML 表。")
    raw_port = cfg["edge"].get("port", 9222)
    if isinstance(raw_port, bool):
        die(f"配置文件格式错误：edge.port 必须是整数（当前 {raw_port!r}）。")
    if isinstance(raw_port, float) and (
            not math.isfinite(raw_port) or not raw_port.is_integer()):
        die(f"配置文件格式错误：edge.port 必须是整数（当前 {raw_port!r}）。")
    try:
        port = int(raw_port)
    except (TypeError, ValueError, OverflowError):
        die(f"配置文件格式错误：edge.port 必须是整数（当前 {raw_port!r}）。")
    if not 1 <= port <= 65535:
        die(f"配置文件格式错误：edge.port 必须在 1-65535 之间（当前 {raw_port!r}）。")
    cfg["edge"]["port"] = port
    if not isinstance(cfg["run"].get("answers"), str) or not cfg["run"]["answers"].strip():
        die("配置文件格式错误：run.answers 必须是非空路径字符串。")
    for key in ("eval_timeout", "level_timeout"):
        raw = cfg["run"].get(key)
        if isinstance(raw, bool):
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        if not math.isfinite(value) or value <= 0:
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        cfg["run"][key] = value
    # apply_current_profile() 会把 edge.profile 改成当前槽的路径，browser 1
    # 需要原始 config 档案作为「1 号槽」的默认值，先在这里留一份。
    cfg["edge"]["default_profile"] = cfg["edge"]["profile"]
    return cfg


def _quarantine_state(reason: str) -> dict:
    bad = STATE_FILE.with_name(STATE_FILE.name + ".bad")
    try:
        STATE_FILE.replace(bad)
        note = f"已备份为 {bad.name}"
    except OSError:
        note = "备份失败"
    log(f"  ! state.json 无法使用（{reason}），{note}，本次使用空状态")
    return {}


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except UnicodeDecodeError as e:
        return _quarantine_state(f"编码错误：{e}")
    except json.JSONDecodeError as e:
        return _quarantine_state(f"JSON 语法错误：{e}")
    except OSError as e:
        return _quarantine_state(f"读取失败：{e}")
    if not isinstance(data, dict):
        return _quarantine_state("顶层不是对象")
    for key in ("slots", "names"):
        value = data.get(key)
        if value is None:
            data[key] = {}
        elif not isinstance(value, dict):
            return _quarantine_state(f"{key} 不是对象")
    slots = {}
    for key, value in data["slots"].items():
        if isinstance(key, str) and key and isinstance(value, str) and value.strip():
            slots[key] = value
        else:
            log(f"  ! state.json 的 slots 项无效，已忽略：{key!r}: {value!r}")
    data["slots"] = slots
    return data


def save_state(state: dict) -> None:
    tmp = STATE_FILE.with_name(STATE_FILE.name + ".tmp")
    try:
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, STATE_FILE)
    except OSError as e:
        log(f"  ! 槽位状态写入失败：{e}")
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def apply_current_profile(cfg: dict) -> str:
    """把「当前记住的档案槽」应用进配置，返回槽位名（没有则空串）。"""
    state = load_state()
    cur = state.get("current")
    slots = state.get("slots", {})
    if isinstance(cur, str) and cur and slots.get(cur):
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
        prof = os.path.expanduser(
            cfg["edge"].get("default_profile") or cfg["edge"]["profile"])
        slots["1"] = prof
        state["current"] = "1"
        save_state(state)
        return "1", prof, "（首次使用：当前 config 档案已记为槽 1）"

    if arg == "new":
        prof = str(PROFILE_BASE / f"guest-{time.strftime('%Y%m%d-%H%M%S')}")
        slots["new"] = prof
        state["current"] = "new"
        state.pop("running", None)
        state.pop("running_profile", None)
        save_state(state)
        return "new", prof, "（全新档案；下次 browser new 又是一个全新的）"

    m = re.fullmatch(r"([1-9][0-9]?)new", arg)
    if m:
        n = m.group(1)
        old = slots.get(n)
        prof = str(PROFILE_BASE / f"slot{n}-{time.strftime('%Y%m%d-%H%M%S')}")
        slots[n] = prof
        state["current"] = n
        state.pop("running", None)
        state.pop("running_profile", None)
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
        # apply_current_profile() 可能已把 edge.profile 改成别的槽，1 号槽必须用
        # load_config() 保存下来的原始 config 档案。
        prof = os.path.expanduser(
            cfg["edge"].get("default_profile") or cfg["edge"]["profile"])
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
