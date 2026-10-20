#!/usr/bin/env python3
"""工具函数与模块拆分后的冒烟测试（不依赖浏览器）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contextlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import tempfile  # noqa: E402

import eduauto.config as config  # noqa: E402
from eduauto.answers import answer_to_toml  # noqa: E402
from eduauto.archive import Chapter  # noqa: E402
from eduauto.code import answer_choice, choice_letters  # noqa: E402
from eduauto.config import (apply_current_profile, load_config,  # noqa: E402
                            load_state, setup_slot)
from eduauto.flows import _book_lookup, resolve_chapter_args  # noqa: E402
from eduauto.util import fmt_secs  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("✓", name)
    else:
        failed += 1
        print("✗", name, detail)


check("fmt_secs 65 秒", fmt_secs(65) == "65 秒", fmt_secs(65))
check("fmt_secs 90 秒 → 1.5 分钟", fmt_secs(90) == "1.5 分钟", fmt_secs(90))

ch = Chapter({"name": "Java面向对象（二）", "levels": []})
check("_book_lookup 精确匹配", _book_lookup([ch], "Java面向对象（二）") is ch)
check("_book_lookup 卡片名含档案名",
      _book_lookup([ch], "Java面向对象（二） - 封装、继承和多态") is ch)
check("_book_lookup 档案名含卡片名",
      _book_lookup([Chapter({"name": "人工智能通识", "levels": []}), ch], "人工智能通识(需做)")
      is not None)
check("_book_lookup 找不到返回 None", _book_lookup([ch], "完全不存在的章节") is None)


# 配置里的相对答案路径按配置文件所在目录解析
_cfgdir = Path(tempfile.mkdtemp())
_cfgfile = _cfgdir / "c.toml"
_cfgfile.write_text('[run]\nanswers = "rel.toml"\n', encoding="utf-8")
_cfg = load_config(_cfgfile)
check("answers 相对配置目录", _cfg["run"]["answers"] == str(_cfgdir / "rel.toml"),
      _cfg["run"]["answers"])

# 章节匹配忽略空白
_ch = Chapter({"name": "Java语言基础（五） - 循环结构基础", "levels": []})
_r = resolve_chapter_args([_ch], ["Java语言基础（五）-循环结构基础"], strict=False)
check("resolve 匹配忽略空白", len(_r) == 1 and _r[0] is _ch)

try:
    resolve_chapter_args([_ch], ["完全不存在的章节"], strict=True)
    _strict_ok = False
except SystemExit as e:
    _strict_ok = (e.code == 2)
check("resolve strict 未命中退出 2", _strict_ok)

# TOML 字面量清洗
_out = answer_to_toml("code", "a\r\nb")
check("answer_to_toml 统一 CRLF", "\r" not in _out and "a\nb" in _out)
try:
    answer_to_toml("code", "a\x0bb")
    _ctrl_ok = False
except RuntimeError:
    _ctrl_ok = True
check("answer_to_toml 拒绝控制字符", _ctrl_ok)


# ── 选择题答案校验 ──────────────────────────────────────────────
def _choice_raises(value) -> bool:
    try:
        choice_letters(value)
        return False
    except ValueError:
        return True


check("choice_letters 空串拒绝", _choice_raises(""))
check("choice_letters 纯空白拒绝", _choice_raises("   "))
check("choice_letters 多字符拒绝", _choice_raises("AB"))
check("choice_letters 非 A-Z 拒绝", _choice_raises("1"))
check("choice_letters 中文拒绝", _choice_raises("甲"))
check("choice_letters 空列表拒绝", _choice_raises([]))
check("choice_letters 空项拒绝", _choice_raises("A,,B"))
check("choice_letters 列表空项拒绝", _choice_raises(["A", ""]))
check("choice_letters 多选空组拒绝", _choice_raises([["A"], []]))
check("choice_letters 单字母", choice_letters("a") == ["A"])
check("choice_letters 逗号分隔", choice_letters("A,B") == ["A", "B"])
check("choice_letters 中文逗号分隔", choice_letters("A，b") == ["A", "B"])
check("choice_letters 多选嵌套", choice_letters([["a", "B"], "c"]) == [["A", "B"], ["C"]])


class _NoPage:
    """answer_choice 的输入校验必须在碰页面之前完成。"""
    ws = None


def _answer_choice_raises(items) -> bool:
    try:
        answer_choice(_NoPage(), items)
        return False
    except ValueError:
        return True
    except AttributeError:
        return False


check("answer_choice 空串拒绝", _answer_choice_raises(""))
check("answer_choice 多字符拒绝", _answer_choice_raises(["AB"]))
check("answer_choice 非 A-Z 拒绝", _answer_choice_raises(["1"]))


class _OneOptionPage:
    """页面只有 1 组选项，用来验证题数错位时拒绝作答。"""
    class ws:  # noqa: N801
        @staticmethod
        def eval(expr):
            return 1


def _answer_choice_runtime(items) -> bool:
    try:
        answer_choice(_OneOptionPage(), items)
        return False
    except RuntimeError:
        return True


check("answer_choice 选项组数不符拒绝", _answer_choice_runtime(["A", "B"]))


# ── 配置边界 ────────────────────────────────────────────────────
def _cfg_rejected(text: str) -> bool:
    d = Path(tempfile.mkdtemp())
    f = d / "c.toml"
    f.write_text(text, encoding="utf-8")
    try:
        with contextlib.redirect_stdout(io.StringIO()):   # 隐藏 die() 的提示
            load_config(f)
        return False
    except SystemExit:
        return True


check("port 拒绝 bool", _cfg_rejected("[edge]\nport = true\n"))
check("port 拒绝 0", _cfg_rejected("[edge]\nport = 0\n"))
check("port 拒绝 70000", _cfg_rejected("[edge]\nport = 70000\n"))
check("port 拒绝 nan", _cfg_rejected("[edge]\nport = nan\n"))
check("port 拒绝 inf", _cfg_rejected("[edge]\nport = inf\n"))
check("port 拒绝小数", _cfg_rejected("[edge]\nport = 9222.5\n"))
check("port 接受 9222", not _cfg_rejected("[edge]\nport = 9222\n"))

for _key in ("eval_timeout", "level_timeout"):
    check(f"{_key} 拒绝 bool", _cfg_rejected(f"[run]\n{_key} = true\n"))
    check(f"{_key} 拒绝 nan", _cfg_rejected(f"[run]\n{_key} = nan\n"))
    check(f"{_key} 拒绝 inf", _cfg_rejected(f"[run]\n{_key} = inf\n"))
    check(f"{_key} 拒绝 0", _cfg_rejected(f"[run]\n{_key} = 0\n"))
    check(f"{_key} 拒绝负数", _cfg_rejected(f"[run]\n{_key} = -1\n"))

_valid = load_config(_cfgdir / "c.toml")
check("合法超时转为 float", isinstance(_valid["run"]["eval_timeout"], float)
      and _valid["run"]["eval_timeout"] == 180.0)


# ── state.json 健壮性（monkeypatch STATE_FILE） ─────────────────
_state_dir = Path(tempfile.mkdtemp())
_old_state_file = config.STATE_FILE
config.STATE_FILE = _state_dir / "state.json"
try:
    config.STATE_FILE.write_bytes(b"\xff\xfe\x00bad")
    _st = load_state()
    check("state 编码错误隔离",
          _st == {} and config.STATE_FILE.with_name("state.json.bad").exists()
          and not config.STATE_FILE.exists())

    config.STATE_FILE.write_text(json.dumps({
        "slots": {"1": "/p1", "2": 3, "3": "", "4": "   "},
        "names": {},
    }), encoding="utf-8")
    _st = load_state()
    check("slots 只保留非空字符串",
          _st["slots"] == {"1": "/p1"} and config.STATE_FILE.exists(), str(_st))

    config.STATE_FILE.write_text(json.dumps({"slots": []}), encoding="utf-8")
    _st = load_state()
    check("slots 容器类型错误隔离",
          _st == {} and not config.STATE_FILE.exists()
          and config.STATE_FILE.with_name("state.json.bad").exists())

    # browser 1 必须用 config 里的原始档案，而不是 apply_current_profile 后的当前槽
    _d = Path(tempfile.mkdtemp())
    _prof_default = str(_d / "profile-default")
    _prof_slot2 = str(_d / "profile-2")
    _f = _d / "c.toml"
    _f.write_text(f"[edge]\nprofile = {json.dumps(_prof_default)}\n", encoding="utf-8")
    config.STATE_FILE.write_text(json.dumps({
        "current": "2", "slots": {"2": _prof_slot2}, "names": {},
    }), encoding="utf-8")
    _cfg = load_config(_f)
    check("load_config 保存 default_profile",
          _cfg["edge"]["default_profile"] == _prof_default)
    _cur = apply_current_profile(_cfg)
    check("apply_current_profile 切到当前槽",
          _cur == "2" and _cfg["edge"]["profile"] == _prof_slot2)
    _slot, _prof, _ = setup_slot(_cfg, "1")
    check("browser 1 使用默认档案",
          _slot == "1" and _prof == _prof_default, f"{_slot} {_prof}")
    check("browser 1 记住默认档案",
          load_state()["slots"].get("1") == _prof_default
          and load_state().get("current") == "1")
finally:
    config.STATE_FILE = _old_state_file


print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
