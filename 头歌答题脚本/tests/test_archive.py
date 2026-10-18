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
from eduauto.archive import (Level, load_answers, write_back_answers,  # noqa: E402
                            write_scan_skeleton)

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


# 5. 卡片名与档案名不一致时也能写回（模糊匹配）
archive3 = Path(tmp) / "arch3.toml"
write_scan_skeleton(archive3, [{"name": "章节甲", "homework_id": "1",
                                "levels": [{"name": "L1"}]}])
n3 = write_back_answers(archive3, {"章节甲 - 副标题": {1: 'answer = "A"'}}, force=False)
d6 = tomllib.loads(archive3.read_text())
check("模糊章节名写回", n3 == 1 and d6["chapters"][0]["levels"][0].get("answer") == "A")

# 6. 多文件关已有答案时不得被单 answer 覆盖
archive4 = Path(tmp) / "arch4.toml"
archive4.write_text(
    '[[chapters]]\n'
    'name = "多文件章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'multi = true\n'
    '[[chapters.levels.files]]\n'
    'path = "a.java"\n'
    'answer = \'\'\'\nold\n\'\'\'\n'
    '[[chapters.levels.files]]\n'
    'path = "b.java"\n'
    'answer = ""\n'
)
n4 = write_back_answers(archive4, {"多文件章": {1: 'answer = \'\'\'\nnew\n\'\'\''}}, force=False)
d7 = tomllib.loads(archive4.read_text())
lv7 = d7["chapters"][0]["levels"][0]
check("多文件已有答案不被覆盖", n4 == 0 and len(lv7.get("files", [])) == 2
      and "old" in lv7["files"][0]["answer"] and "answer" not in lv7)

# 7. answer = [] 占位应视为空，可以自动填入
archive5 = Path(tmp) / "arch5.toml"
archive5.write_text(
    '[[chapters]]\n'
    'name = "占位章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'answer = []\n'
)
n5 = write_back_answers(archive5, {"占位章": {1: 'answer = ["A"]'}}, force=False)
d8 = tomllib.loads(archive5.read_text())
check("answer=[] 占位可填入", n5 == 1 and d8["chapters"][0]["levels"][0].get("answer") == ["A"])
check("answer [[], ['A']] 非空", not Level({"answer": [[], ["A"]]}).answer_empty())
check("answer [[]] 为空", Level({"answer": [[]]}).answer_empty())

# 8. 骨架不重复建章 + 回填 homework_id + 追加缺失关卡
archive6 = Path(tmp) / "arch6.toml"
write_scan_skeleton(archive6, [{"name": "章节乙", "homework_id": "",
                                "levels": [{"name": "L1"}, {"name": "L2"}]}])
write_scan_skeleton(archive6, [{"name": "章节乙 - 扩展", "homework_id": "999",
                                "levels": [{"name": "L1"}, {"name": "L2"}, {"name": "L3"}]}])
d9 = tomllib.loads(archive6.read_text())
check("骨架模糊匹配不重复建章", len(d9["chapters"]) == 1, str(d9["chapters"]))
check("骨架回填 homework_id", d9["chapters"][0].get("homework_id") == "999")
check("骨架追加缺失关卡", len(d9["chapters"][0]["levels"]) == 3)

# 9. 单引号章节名（合法 TOML）也能匹配写回
archive7 = Path(tmp) / "arch7.toml"
archive7.write_text(
    "[[chapters]]\n"
    "name = '单引号章'\n"
    '\n'
    "[[chapters.levels]]\n"
    'name = "L1"\n'
    'answer = ""\n'
)
n7 = write_back_answers(archive7, {"单引号章": {1: 'answer = "B"'}}, force=False)
d10 = tomllib.loads(archive7.read_text())
check("单引号章节名可写回", n7 == 1 and d10["chapters"][0]["levels"][0].get("answer") == "B")

# 10. 缺失档案 + missing_ok
check("缺失档案 missing_ok 返回空",
      load_answers(Path(tmp) / "nope.toml", missing_ok=True) == [])
check("原子写无 .tmp 残留", not list(Path(tmp).glob("*.tmp")))


# 11. 写回只替换答案区，保留 skip/type/注释/multi
archive8 = Path(tmp) / "arch8.toml"
archive8.write_text(
    '[[chapters]]\n'
    'name = "头部章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    '# 用户注释\n'
    'type = "code"\n'
    'skip = false\n'
    'multi = false\n'
    'answer = ""\n'
)
n8 = write_back_answers(archive8, {"头部章": {1: 'answer = "C"'}}, force=False)
_txt8 = archive8.read_text()
d11 = tomllib.loads(_txt8)
_lv11 = d11["chapters"][0]["levels"][0]
check("写回保留 skip/type/注释/multi",
      n8 == 1 and _lv11.get("type") == "code" and _lv11.get("skip") is False
      and _lv11.get("multi") is False and "# 用户注释" in _txt8
      and _lv11.get("answer") == "C")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
