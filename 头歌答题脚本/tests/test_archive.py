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

# 12. 答案区之后的 skip/type/注释：写回后仍存在（移到新 payload 之前，绝不删除）
archive9 = Path(tmp) / "arch9.toml"
archive9.write_text(
    '[[chapters]]\n'
    'name = "尾部字段章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'answer = ""\n'
    'skip = false\n'
    'type = "code"\n'
    '# L1 备注\n'
)
n9 = write_back_answers(archive9, {"尾部字段章": {1: {"answer": 'answer = "X"', "multi": False}}}, force=False)
_txt9 = archive9.read_text()
_lv9 = tomllib.loads(_txt9)["chapters"][0]["levels"][0]
check("写回保留 answer 之后的 skip/type/注释",
      n9 == 1 and _lv9.get("skip") is False and _lv9.get("type") == "code"
      and _lv9.get("multi") is False and _lv9.get("answer") == "X"
      and "# L1 备注" in _txt9)

# 13. 文件末尾（最后一个关卡之后）的注释：写回后仍存在
archive10 = Path(tmp) / "arch10.toml"
archive10.write_text(
    '[[chapters]]\n'
    'name = "尾注章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'answer = []\n'
    '\n'
    '# 文件末尾说明注释\n'
)
n10 = write_back_answers(archive10, {"尾注章": {1: 'answer = ["A", "B"]'}}, force=False)
_txt10 = archive10.read_text()
check("文件末尾注释保留",
      n10 == 1 and tomllib.loads(_txt10)["chapters"][0]["levels"][0].get("answer") == ["A", "B"]
      and "# 文件末尾说明注释" in _txt10)

# 14. 多文件块 + 尾部注释：两个 files 块整体替换、尾部注释不死
archive11 = Path(tmp) / "arch11.toml"
archive11.write_text(
    '[[chapters]]\n'
    'name = "多文件注释章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'multi = true\n'
    '[[chapters.levels.files]]\n'
    'path = "a.java"\n'
    "answer = '''\nolda\n'''\n"
    '[[chapters.levels.files]]\n'
    'path = "b.java"\n'
    "answer = '''\noldb\n'''\n"
    '\n'
    '# 两份文件的答案都要保留\n'
)
payload11 = ("[[chapters.levels.files]]\npath = \"a.java\"\nanswer = '''\nna\n'''\n"
             "[[chapters.levels.files]]\npath = \"b.java\"\nanswer = '''\nnb\n'''")
n11 = write_back_answers(archive11, {"多文件注释章": {1: {"answer": payload11, "multi": True}}}, force=True)
_txt11 = archive11.read_text()
_d11 = tomllib.loads(_txt11)
_f11 = _d11["chapters"][0]["levels"][0]["files"]
check("多文件块+尾部注释写回",
      n11 == 1 and len(_f11) == 2 and "na" in _f11[0]["answer"] and "nb" in _f11[1]["answer"]
      and "# 两份文件的答案都要保留" in _txt11 and "olda" not in _txt11 and "oldb" not in _txt11)

# 15. 章头隔着长注释也能认出章节，sort_chapter_blocks 顺序正确
from eduauto.archive import sort_chapter_blocks          # noqa: E402
from eduauto.archive import _chapter_spans as _spans15   # noqa: E402
_long = "".join(f"# 章头注释第 {i} 行\n" for i in range(1, 15))
_text15 = (
    '# 顶部说明\n'
    '[[chapters]]\n' + _long + 'name = "第二章（二）"\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'answer = ""\n'
    '\n'
    '[[chapters]]\nname = "第一章（一）"\n'
    '[[chapters.levels]]\n'
    'name = "L1"\n'
    'answer = ""\n'
)
_sorted15 = sort_chapter_blocks(_text15)
_sp15 = [sp["name"] for sp in _spans15(_sorted15.splitlines(keepends=True))]
check("章头长注释 + 排序正确",
      _sorted15.index("第一章") < _sorted15.index("第二章") and _sp15 == ["第一章（一）", "第二章（二）"],
      str(_sp15))

# 16. chapters 不是 list：友好 die → SystemExit(2)
_bad = Path(tmp) / "arch_bad.toml"
_bad.write_text('chapters = "oops"\n')
try:
    load_answers(_bad)
    check("chapters=非数组 die", False, "没有触发 SystemExit")
except SystemExit as e:
    check("chapters=非数组 die", isinstance(getattr(e, "code", None), int) and e.code == 2,
          f"code={getattr(e, 'code', None)}")

# 17. 骨架前缀仅空白差异（norm 相等）也能追补
archive12 = Path(tmp) / "arch12.toml"
archive12.write_text(
    '[[chapters]]\n'
    'name = "空白章"\n'
    '\n'
    '[[chapters.levels]]\n'
    'name = "关  卡1"\n'
    'answer = ""\n'
)
write_scan_skeleton(archive12, [{"name": "空白章", "levels": [
    {"name": "关卡1", "multi": False}, {"name": "关卡2"},
]}])
_d12 = tomllib.loads(archive12.read_text())
check("骨架前缀空白差异仍追补", len(_d12["chapters"]) == 1 and len(_d12["chapters"][0]["levels"]) == 2,
      str(_d12["chapters"]))

# 18. 关卡块里混入无法安全判断的表头：die（code 2）且原文件一字不动
archive13 = Path(tmp) / "arch13.toml"
_src13 = ('[[chapters]]\n'
          'name = "表头混杂章"\n'
          '\n'
          '[[chapters.levels]]\n'
          'name = "L1"\n'
          'answer = "x"\n'
          '[other.table]\n'
          'answer = "y"\n'
          '\n'
          '# 末尾注释\n')
archive13.write_text(_src13)
try:
    write_back_answers(archive13, {"表头混杂章": {1: {"answer": 'answer = "Z"', "multi": None}}},
                       force=True)
    check("混入表头 die 不静默删", False, "没有触发 SystemExit")
except SystemExit as e:
    check("混入表头 die 不静默删", getattr(e, "code", None) == 2
          and archive13.read_text() == _src13, f"code={getattr(e, 'code', None)}")

# 19. answer 值未闭合（三引号没关）：整块跳过不写，原文件不丢内容
archive14 = Path(tmp) / "arch14.toml"
_src14 = ('[[chapters]]\nname = "未闭合章"\n\n[[chapters.levels]]\nname = "L1"\n'
          "answer = '''\nnever closed\n")
archive14.write_text(_src14)
n14 = write_back_answers(archive14, {"未闭合章": {1: {"answer": 'answer = "Z"', "multi": None}}},
                         force=True)
check("answer 未闭合整块跳过", n14 == 0 and archive14.read_text() == _src14, f"n={n14}")

# 20. 文件末尾没有换行：payload 不能粘到上一行（注释/字段）里
archive15 = Path(tmp) / "arch15.toml"
_src15 = ('[[chapters]]\nname = "EOF尾注章"\n\n[[chapters.levels]]\nname = "L1"\n'
          'answer = "old"\n# 末尾注释没有换行')
archive15.write_text(_src15)
n15 = write_back_answers(archive15, {"EOF尾注章": {1: 'answer = "NEW"'}}, force=True)
_txt15 = archive15.read_text()
_d15 = tomllib.loads(_txt15)
check("EOF 无换行：payload 不粘注释",
      n15 == 1 and _d15["chapters"][0]["levels"][0].get("answer") == "NEW"
      and "# 末尾注释没有换行" in _txt15 and '\nanswer = "NEW"' in _txt15,
      repr(_txt15))

# 20b. 关卡头/name 行是文件最后一行且没有换行：payload 仍从新行开始
archive16 = Path(tmp) / "arch16.toml"
archive16.write_text('[[chapters]]\nname = "EOF头章"\n\n[[chapters.levels]]\nname = "L1"')
n16 = write_back_answers(
    archive16, {"EOF头章": {1: {"answer": 'answer = "NEW"', "multi": False}}}, force=True)
_d16 = tomllib.loads(archive16.read_text())
check("EOF 无换行：关卡头后写回",
      n16 == 1 and _d16["chapters"][0]["levels"][0].get("answer") == "NEW"
      and _d16["chapters"][0]["levels"][0].get("multi") is False,
      repr(archive16.read_text()))

# 21. 已有答案里含 [[chapters]]：scan 追补关卡会毒化答案，必须 die 且不写
archive17 = Path(tmp) / "arch17.toml"
_src17 = ('[[chapters]]\nname = "结构行章"\nhomework_id = "1"\n\n'
          '[[chapters.levels]]\nname = "L1"\n'
          "answer = '''\ncode\n[[chapters]]\ntext\n'''\n\n"
          '[[chapters.levels]]\nname = "L2"\nanswer = ""\n')
archive17.write_text(_src17)
try:
    write_scan_skeleton(archive17, [{
        "name": "结构行章", "homework_id": "1",
        "levels": [{"name": "L1"}, {"name": "L2"}, {"name": "L3"}],
    }])
    check("scan 答案含 [[chapters]] 时 die", False, "没有触发 SystemExit")
except SystemExit as e:
    check("scan 答案含 [[chapters]] 时 die",
          getattr(e, "code", None) == 2 and archive17.read_text() == _src17,
          f"code={getattr(e, 'code', None)}")

# 22. 章节乱序的档案：合法排序不能被结构守卫误拒
archive18 = Path(tmp) / "arch18.toml"
archive18.write_text(
    '[[chapters]]\nname = "第一章（一）"\n\n[[chapters.levels]]\nname = "L1"\nanswer = ""\n\n'
    '[[chapters]]\nname = "项目实战"\n\n[[chapters.levels]]\nname = "P1"\nanswer = ""\n\n'
    '[[chapters]]\nname = "第二章（二）"\n\n[[chapters.levels]]\nname = "L2"\nanswer = ""\n'
)
n18 = write_back_answers(archive18, {"第一章（一）": {1: 'answer = "A"'}}, force=False)
_d18 = tomllib.loads(archive18.read_text())
_names18 = [c.get("name") for c in _d18["chapters"]]
check("乱序章节写回不被误拒",
      n18 == 1 and _names18 == ["第一章（一）", "第二章（二）", "项目实战"]
      and _d18["chapters"][0]["levels"][0].get("answer") == "A", str(_names18))

# 23. homework_id = "" 占位：原地替换，不能插入重复键
archive19 = Path(tmp) / "arch19.toml"
archive19.write_text(
    '[[chapters]]\nname = "空HID章"\nhomework_id = ""  # 保留注释\n\n'
    '[[chapters.levels]]\nname = "L1"\nanswer = ""\n'
)
write_scan_skeleton(archive19, [{"name": "空HID章", "homework_id": "999",
                                 "levels": [{"name": "L1"}, {"name": "L2"}]}])
_txt19 = archive19.read_text()
_d19 = tomllib.loads(_txt19)
check("homework_id 空占位原地回填",
      _d19["chapters"][0].get("homework_id") == "999"
      and _txt19.count("homework_id") == 1 and "# 保留注释" in _txt19
      and len(_d19["chapters"][0]["levels"]) == 2, _txt19)

# 23b. 没有 homework_id 行且 name 行是 EOF（无换行）：插入后仍是合法 TOML
archive20 = Path(tmp) / "arch20.toml"
archive20.write_text('[[chapters]]\nname = "EOF-HID章"')
write_scan_skeleton(archive20, [{"name": "EOF-HID章", "homework_id": "9",
                                 "levels": [{"name": "L1"}]}])
_d20 = tomllib.loads(archive20.read_text())
check("homework_id 插入前补换行",
      _d20["chapters"][0].get("homework_id") == "9", repr(archive20.read_text()))

# 24. answer 之前出现 [chapters.levels.files] 子表头：die 不写
archive21 = Path(tmp) / "arch21.toml"
_src21 = ('[[chapters]]\nname = "子表头章"\n\n[[chapters.levels]]\nname = "L1"\n'
          '[chapters.levels.files]\nanswer = ""\n')
archive21.write_text(_src21)
try:
    write_back_answers(archive21, {"子表头章": {1: 'answer = "A"'}}, force=False)
    check("answer 前子表头 die", False, "没有触发 SystemExit")
except SystemExit as e:
    check("answer 前子表头 die",
          getattr(e, "code", None) == 2 and archive21.read_text() == _src21,
          f"code={getattr(e, 'code', None)}")

# 25. payload 行首含章节/关卡表头：直接 die，不毒化后续写回
archive22 = Path(tmp) / "arch22.toml"
_src22 = ('[[chapters]]\nname = "载荷结构章"\n\n[[chapters.levels]]\nname = "L1"\nanswer = ""\n\n'
          '[[chapters.levels]]\nname = "L2"\nanswer = ""\n')
archive22.write_text(_src22)
_payloads = [
    "answer = '''\n[[chapters]]\nname = \"不是章\"\n'''",
    "answer = '''\n[[chapters.levels]]\nname = \"假关卡\"\n'''",
]
for _pl in _payloads:
    try:
        write_back_answers(archive22, {"载荷结构章": {1: _pl}}, force=True)
        check("payload 含结构行 die", False, "没有触发 SystemExit")
    except SystemExit as e:
        check("payload 含结构行 die",
              getattr(e, "code", None) == 2 and archive22.read_text() == _src22,
              f"code={getattr(e, 'code', None)}")

# 26. 4/5 引号收尾的多行字面量：是合法 TOML，不能被当成“未闭合”
for _n, _val in (("4 引号", "'''x = 'abc''''"), ("5 引号", "'''x = 'abc'''''")):
    _p = Path(tmp) / f"arch23_{_n[:1]}.toml"
    _p.write_text('[[chapters]]\nname = "引号章"\n\n[[chapters.levels]]\nname = "L1"\n'
                  f"answer = {_val}\n")
    _cnt = write_back_answers(_p, {"引号章": {1: 'answer = "B"'}}, force=True)
    check(f"多行字面量 {_n} 收尾可写回",
          _cnt == 1
          and tomllib.loads(_p.read_text())["chapters"][0]["levels"][0].get("answer") == "B")

# 26b. """ 内的 \""" 是内容，不是结束符
archive24 = Path(tmp) / "arch24.toml"
archive24.write_text('[[chapters]]\nname = "转义引号章"\n\n[[chapters.levels]]\nname = "L1"\n'
                     'answer = """a\\"""\ncode\n"""\n')
n24 = write_back_answers(archive24, {"转义引号章": {1: 'answer = "B"'}}, force=True)
check('""" 内 \\""" 不误判',
      n24 == 1
      and tomllib.loads(archive24.read_text())["chapters"][0]["levels"][0].get("answer") == "B")

# 27. 载荷被 answer 之后的表头截走：解析对比必须发现并 die
archive25 = Path(tmp) / "arch25.toml"
_src25 = ('[[chapters]]\nname = "尾表头章"\n\n[[chapters.levels]]\nname = "L1"\n'
          'answer = ""\nskip = false\n[other.table]\nx = 1\n')
archive25.write_text(_src25)
try:
    write_back_answers(archive25, {"尾表头章": {1: 'answer = "A"'}}, force=False)
    check("载荷落入尾表头 die", False, "没有触发 SystemExit")
except SystemExit as e:
    check("载荷落入尾表头 die",
          getattr(e, "code", None) == 2 and archive25.read_text() == _src25,
          f"code={getattr(e, 'code', None)}")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
