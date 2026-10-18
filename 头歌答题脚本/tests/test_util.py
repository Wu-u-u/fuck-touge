#!/usr/bin/env python3
"""工具函数与模块拆分后的冒烟测试（不依赖浏览器）。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eduauto.archive import Chapter  # noqa: E402
from eduauto.flows import _book_lookup  # noqa: E402
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

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
