#!/usr/bin/env python3
"""课程解析 / 档案路径 / 当前课程识别测试（不依赖浏览器）。"""
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eduauto.course import (Course, choose_course, current_course,  # noqa: E402
                            ensure_answers_file, answers_file, parse_course_url)

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"✓ {name}")
    else:
        failed += 1
        print(f"✗ {name} {detail}")


c = parse_course_url("https://www.educoder.net/classrooms/JODEM6CH/shixun_homework",
                     "Java程序设计-2026秋")
check("classroom URL 解析", c and c.code == "JODEM6CH" and c.name == "Java程序设计-2026秋")
check("classroom 起始页", c and c.classroom.endswith("/JODEM6CH/shixun_homework"))
t = parse_course_url("https://www.educoder.net/tasks/JODEM6CH/4155347/x", "Java")
check("task URL 解析", t and t.code == "JODEM6CH")
check("非课程页返回 None", parse_course_url("https://www.educoder.net/classrooms", "教学课堂") is None)
check("new 不是课程", parse_course_url("https://www.educoder.net/classrooms/new", "") is None)

cfg = {"run": {"answers_dir": "/tmp/opencode/course-test-answers"}}
p = answers_file(cfg, "数据结构与算法2026秋季", "ltxojfnp")
check("档案名含课程名与 code", p.name == "数据结构与算法2026秋季-ltxojfnp.toml")
check("档案名清理空格", " " not in answers_file(cfg, "A B", "x").name)

with __import__("tempfile").TemporaryDirectory() as td:
    cfg2 = {"run": {"answers_dir": str(Path(td) / "answers")}}
    c2 = Course("数据结构与算法2026秋季", "ltxojfnp", "https://x")
    fp = ensure_answers_file(cfg2, c2)
    check("首次创建空档案", fp.exists() and "version = 1" in fp.read_text(encoding="utf-8"))
    fp.write_text("# keep\nversion = 1\n[[chapters]]\nname = 'x'\n", encoding="utf-8")
    ensure_answers_file(cfg2, c2)
    check("已有档案不覆盖", "[[chapters]]" in fp.read_text(encoding="utf-8"))

check("课程序号选择", choose_course(["A", "B"], "2") == "B")
check("课程模糊选择", choose_course(["Java程序设计-2026秋", "数据结构"], "数据结构") == "数据结构")

# current_course：/json 顺序（新开的课程页在前）
with __import__("tempfile").TemporaryDirectory() as td:
    cfg3 = {"run": {"answers_dir": str(Path(td))}}
    arch = Path(td) / "Java-ABC.toml"
    arch.write_text("version = 1\n", encoding="utf-8")
    b = SimpleNamespace(pages=lambda: [
        {"id": "1", "url": "https://www.educoder.net/classrooms/ABC/shixun_homework",
         "title": "Java"},
        {"id": "2", "url": "https://www.educoder.net/classrooms", "title": "教学课堂"},
    ])
    cc = current_course(b, cfg3)
    check("当前课程取最新课程页", cc and cc.code == "ABC" and cc.answers == arch)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
