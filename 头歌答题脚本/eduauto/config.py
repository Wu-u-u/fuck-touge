"""配置读取与档案槽位状态（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import json
import math

try:
    import fcntl
except ImportError:  # Windows 等没有 fcntl：退化为无锁
    fcntl = None
import os
import re
import time
import tomllib
import uuid

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
        "courses": "https://www.educoder.net/classrooms",
    },
    "run": {
        "answers_dir": str(HERE / "answers"),
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
            adir = run.get("answers_dir")
            if isinstance(adir, str) and adir and not Path(adir).expanduser().is_absolute():
                run["answers_dir"] = str(cfg_path.resolve().parent / adir)
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
    if not isinstance(cfg["run"].get("answers_dir"), str) or not cfg["run"]["answers_dir"].strip():
        die("配置文件格式错误：run.answers_dir 必须是非空路径字符串。")
    for key in ("eval_timeout", "level_timeout"):
        raw = cfg["run"].get(key)
        if isinstance(raw, bool):
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        try:
            value = float(raw)
        except (TypeError, ValueError, OverflowError):
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        if not math.isfinite(value) or value <= 0:
            die(f"配置文件格式错误：run.{key} 必须是大于 0 的有限数字（当前 {raw!r}）。")
        cfg["run"][key] = value
    # edge 的路径/URL 三项必须是字符串；profile/extension 若是相对路径，
    # 按配置文件所在目录解析（和使用中的 run.answers 同一规则）。
    for key in ("profile", "extension", "courses"):
        value = cfg["edge"].get(key)
        if not isinstance(value, str) or not value.strip():
            die(f"配置文件格式错误：edge.{key} 必须是非空字符串（当前 {value!r}）。")
    base = cfg_path.resolve().parent
    for key in ("profile", "extension"):
        value = cfg["edge"][key]
        if not os.path.isabs(os.path.expanduser(value)):
            cfg["edge"][key] = str(base / value)
    # 源码仓库默认指向 Fuck头歌/ 根目录；v2.5.0 起构建产物在 dist/。
    # release zip 的 Fuck头歌/ 根目录本身有 manifest，保持原路径。
    ext_path = Path(os.path.expanduser(cfg["edge"]["extension"]))
    if not (ext_path / "manifest.json").exists():
        dist = ext_path / "dist"
        if (dist / "manifest.json").exists():
            cfg["edge"]["extension"] = str(dist)
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


def _load_state_checked() -> dict | None:
    if not STATE_FILE.exists():
        return {}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except UnicodeDecodeError as e:
        return _quarantine_state(f"编码错误：{e}")
    except json.JSONDecodeError as e:
        return _quarantine_state(f"JSON 语法错误：{e}")
    except OSError as e:
        # 瞬时读取失败（权限/并发替换间隙）不要隔离整份 state；
        # 返回 None 让写路径拒绝覆盖，避免用空状态把槽位记忆清空。
        log(f"  ! state.json 读取失败（{e}），本次不读状态，原文件保留")
        return None
    if not isinstance(data, dict):
        return _quarantine_state("顶层不是对象")
    # running 记录「正在运行的浏览器是哪个槽位名」，是字符串不是对象；
    # 类型/值不对只删字段，绝不能按 dict 重置（否则 browser -ls 的「运行中」会失联）。
    for key in ("slots", "names"):
        value = data.get(key)
        if value is None:
            data[key] = {}
        elif not isinstance(value, dict):
            log(f"  ! state.json 的 {key} 不是对象，已重置该字段")
            data[key] = {}
    running = data.get("running")
    if running is not None and (not isinstance(running, str) or not running.strip()):
        log(f"  ! state.json 的 running 不是槽位名字符串，已忽略：{running!r}")
        data.pop("running", None)
    for field in ("slots", "names"):
        clean = {}
        for key, value in data[field].items():
            if isinstance(key, str) and key and isinstance(value, str) and value.strip():
                clean[key] = value
            else:
                log(f"  ! state.json 的 {field} 项无效，已忽略：{key!r}: {value!r}")
        data[field] = clean
    cur = data.get("current")
    if cur is not None and (not isinstance(cur, str) or not cur):
        log(f"  ! state.json 的 current 无效，已忽略：{cur!r}")
        data.pop("current", None)
    return data


def load_state() -> dict:
    """只读入口：读失败时返回空状态（写路径请用 _load_state_checked 拒绝覆盖）。"""
    data = _load_state_checked()
    return data if data is not None else {}


def save_state(state: dict) -> None:
    tmp = STATE_FILE.with_name(f"{STATE_FILE.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
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


@contextmanager
def state_lock():
    """state.json 的跨进程读-改-写锁（同一进程可重入外部调用）。"""
    if fcntl is None:
        yield
        return
    lock_path = STATE_FILE.with_name(STATE_FILE.name + ".lock")
    try:
        f = open(lock_path, "a+")
    except OSError as e:
        log(f"  ! state 锁文件打不开（{e}），本次不加锁继续")
        yield
        return
    locked = False
    try:
        deadline = time.time() + 5
        while True:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except OSError:
                if time.time() >= deadline:
                    log("  ! state 锁等待超时，本次不加锁继续")
                    break
                time.sleep(0.05)
        yield
    finally:
        if locked:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        f.close()


def update_state(**updates) -> None:
    """加锁读取-合并-原子写回（只改传入的字段，不覆盖别的进程更新）。"""
    with state_lock():
        state = _load_state_checked()
        if state is None:
            log("  ! state.json 读取失败，跳过本次状态更新（不覆盖原文件）")
            return
        state.update(updates)
        save_state(state)


def _setup_slot_locked(cfg: dict, arg: str | None) -> tuple[str, str, str]:
    """解析 browser 的槽位参数并记住，返回 (槽位名, 档案路径, 备注)。

      browser 1       记住并切到 1 号档案（1 号默认就是 config 里的档案）
      browser 2~99    记住并切到对应档案；新槽会新建一个干净档案（需登录一次）
      browser new     每次都开一个全新档案（本次记住为 new，下次再全新）
      browser 1new    清除 1 号的记忆，换成全新档案（旧档案不删）
    """
    state = _load_state_checked()
    if state is None:
        die("state.json 读取失败，无法切换档案槽；请检查文件权限/磁盘后重试。")
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


def setup_slot(cfg: dict, arg: str | None) -> tuple[str, str, str]:
    with state_lock():
        return _setup_slot_locked(cfg, arg)


def remember_name(slot: str, name: str) -> None:
    """把账号名记进 state.json 的 names 映射（供 browser -ls 显示）。"""
    if not slot or not name:
        return
    with state_lock():
        state = _load_state_checked()
        if state is None:
            return
        names = state.setdefault("names", {})
        if names.get(slot) != name:
            names[slot] = name
            save_state(state)
