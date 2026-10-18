#!/usr/bin/env python3
"""答案档案相关单元测试（Level 解析 / scan 骨架 / write_back 载荷）。

不依赖浏览器，可在 CI 或任意 Python 3.11+ 环境运行：
    python 头歌答题脚本/tests/test_archive.py
"""
import sys
import tempfile
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eduauto.archive import Level, write_back_answers, write_scan_skeleton  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("✓", name)
    else:
        failed += 1
        print("✗", name, detail)


# 1. Level 解析
lv = Level({"name": "A", "answer": "x", "multi": False})
check("Level multi=False", lv.multi is False)
lv2 = Level({"name": "B", "answer": "x"})
check("Level multi 缺省=None", lv2.multi is None)
lv3 = Level({"name": "C", "multi": True, "files": [{"path": "a.java", "answer": "y"}]})
check("Level multi=True + files", lv3.multi is True and len(lv3.files) == 1)

# 2. write_scan_skeleton（新文件）
tmp = tempfile.mkdtemp()
p = Path(tmp) / "ans.toml"
scanned = [{
    "name": "测试章", "homework_id": "123",
    "levels": [
        {"name": "关卡1", "multi": False},
        {"name": "关卡2", "multi": True, "paths": ["src/A.java", "src/B.java"]},
        {"name": "关卡3"},
    ],
}]
write_scan_skeleton(p, scanned)
data = tomllib.loads(p.read_text())
lvls = data["chapters"][0]["levels"]
check("骨架 3 关", len(lvls) == 3)
check("L1 multi=False + answer 空", lvls[0]["multi"] is False and lvls[0].get("answer") == "")
check("L2 multi=True + 2 文件", lvls[1]["multi"] is True and len(lvls[1].get("files", [])) == 2 and lvls[1]["files"][0]["path"] == "src/A.java")
check("L3 无 multi + answer 空", "multi" not in lvls[2] and lvls[2].get("answer") == "")

# 2b. 追补缺口
scanned2 = [{
    "name": "测试章", "homework_id": "123",
    "levels": [
        {"name": "关卡1", "multi": False},
        {"name": "关卡2", "multi": True, "paths": ["src/A.java", "src/B.java"]},
        {"name": "关卡3"},
        {"name": "关卡4", "multi": False},
    ],
}]
write_scan_skeleton(p, scanned2)
data2 = tomllib.loads(p.read_text())
check("追补 L4", len(data2["chapters"][0]["levels"]) == 4 and data2["chapters"][0]["levels"][3]["multi"] is False)

# 3. write_back_answers dict 载荷
archive = Path(tmp) / "arch.toml"
archive.write_text(
    '[[chapters]]\n'
    'name = "测试章"\n'
    'homework_id = "123"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "关卡1"\n'
    'answer = ""\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "关卡2"\n'
    'answer = ""\n'
)
changes = {"测试章": {1: {"answer": "answer = '''\nprint(1)\n'''", "multi": False}}}
write_back_answers(archive, changes, force=False)
d3 = tomllib.loads(archive.read_text())
l1 = d3["chapters"][0]["levels"][0]
check("write_back L1 multi=False + 答案", l1.get("multi") is False and "print(1)" in l1.get("answer", ""))

changes2 = {"测试章": {2: {"answer": "[[chapters.levels.files]]\npath = \"a.java\"\nanswer = '''\nx\n'''", "multi": True}}}
write_back_answers(archive, changes2, force=True)
d4 = tomllib.loads(archive.read_text())
l2 = d4["chapters"][0]["levels"][1]
check("write_back L2 multi=True + files", l2.get("multi") is True and l2.get("files", [{}])[0].get("path") == "a.java")
check("write_back L1 原样保留", d4["chapters"][0]["levels"][0].get("multi") is False and "print(1)" in l1.get("answer", ""))

# 4. 保留已有 multi 行（str 载荷走 existing multi_line 分支）
archive2 = Path(tmp) / "arch2.toml"
archive2.write_text(
    '[[chapters]]\n'
    'name = "测试章2"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "关卡1"\n'
    'multi = false\n'
    'answer = ""\n'
)
write_back_answers(archive2, {"测试章2": {1: "answer = '''\ncode2\n'''"}}, force=False)
d5 = tomllib.loads(archive2.read_text())
l5 = d5["chapters"][0]["levels"][0]
check("str 载荷保留 multi 行", l5.get("multi") is False and "code2" in l5.get("answer", ""))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
