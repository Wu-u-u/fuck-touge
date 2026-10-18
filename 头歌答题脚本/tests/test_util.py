#!/usr/bin/env python3
"""工具函数与模块拆分后的冒烟测试（不依赖浏览器）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile  # noqa: E402

from eduauto.answers import answer_to_toml  # noqa: E402
from eduauto.archive import Chapter  # noqa: E402
from eduauto.config import load_config  # noqa: E402
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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
