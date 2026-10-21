"""答案档案的纯逻辑（无浏览器依赖）：解析 / 读取 / 写回 / 排序 / scan 骨架格式。"""

import json
import os
import re
import tomllib
from pathlib import Path

from .util import die, log, norm


def _parse_name_line(line: str) -> str | None:
    """从一行 `name = ...` 解析名字（用 TOML，支持单引号/行尾注释）。"""
    try:
        data = tomllib.loads(line.strip())
    except tomllib.TOMLDecodeError:
        return None
    name = data.get("name")
    return str(name) if name is not None else None


def _value_empty(v) -> bool:
    """答案值是否为空（列表递归判断，[] / [[]] / [""] 都算空）。"""
    if isinstance(v, list):
        return all(_value_empty(x) for x in v)
    return not str(v if v is not None else "").strip()


def _raw_level_empty(raw: dict) -> bool:
    files = raw.get("files") or []
    if files:
        return all(_value_empty(f.get("answer")) for f in files if isinstance(f, dict))
    return _value_empty(raw.get("answer"))


def _chapter_spans(lines: list[str]) -> list[dict]:
    """按 [[chapters]] 切块，返回 [{start, end, name}]（end 为下一章起始）。

    每个章头都算一章：name 找不到时不丢弃该章（否则章头若隔了长注释，
    后面的排序会静默错位），只是不参与名字比较，并 log 提示。
    """
    starts = [i for i, line in enumerate(lines) if line.strip() == "[[chapters]]"]
    spans = []
    for bi, s in enumerate(starts):
        e = starts[bi + 1] if bi + 1 < len(starts) else len(lines)
        name = None
        for k in range(s + 1, e):
            if lines[k].strip().startswith("[[chapters.levels]]"):
                break
            name = _parse_name_line(lines[k])
            if name is not None:
                break
        if name is None:
            log(f"  ! 第 {s + 1} 行的章节找不到 name，该章不参与排序比较")
        spans.append({"start": s, "end": e, "name": name})
    return spans


def _chapter_names(text: str) -> list[str]:
    """解析文本里的章节名列表（用于写回前后的结构一致性校验）。"""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return []
    return [str(c.get("name") or "") for c in data.get("chapters", [])
            if isinstance(c, dict)]


def _files_paths_unique(text: str) -> bool:
    """检查每个关卡的 files path 是否唯一（防止重复块累积）。"""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return False
    for ch in data.get("chapters", []):
        for lv in ch.get("levels", []):
            paths = [str(f.get("path") or "") for f in lv.get("files", [])
                     if isinstance(f, dict)]
            if len(paths) != len(set(paths)):
                return False
    return True


def _verify_scan_result(data: dict, scanned: list[dict]) -> None:
    """校验扫描到的章节/关卡都真实出现在解析结果里。

    只比对字符串内容不够：[[chapters]] / [[chapters.levels]] 若被写进
    三引号答案，TOML 仍然能解析，但关卡其实“消失”在答案字符串里。
    这里按解析后的 chapters/levels 结构逐个核对，不一致就 die（不写盘）。
    """
    chapters = data.get("chapters", [])
    if not isinstance(chapters, list):
        die("生成档案时 chapters 不是数组，未写入原文件")
    for ch in scanned:
        raw = _find_raw_chapter(chapters, ch["name"])
        if raw is None:
            die(f"生成档案时章节「{ch['name']}」没有出现在解析结果里，未写入原文件"
                "（答案里可能含 [[chapters]] 行）")
        names = [norm(str(lv.get("name") or "")) for lv in raw.get("levels", [])
                 if isinstance(lv, dict)]
        for lv in ch["levels"]:
            n = norm(str(lv["name"]))
            if n not in names:
                die(f"生成档案时关卡「{lv['name']}」（章节「{ch['name']}」）"
                    "没有出现在解析结果里，未写入原文件（答案里可能含结构行）")
            names.remove(n)


def _find_chapter_span(spans: list[dict], name: str) -> dict | None:
    target = norm(name)
    if not target:
        return None
    for sp in spans:
        if sp["name"] is not None and norm(sp["name"]) == target:
            return sp
    for sp in spans:
        if sp["name"] is not None:
            cn = norm(sp["name"])
            if target in cn or cn in target:
                return sp
    return None


def _find_raw_chapter(chapters: list[dict], name: str) -> dict | None:
    target = norm(name)
    if not target:
        return None
    for c in chapters:
        if norm(str(c.get("name") or "")) == target:
            return c
    for c in chapters:
        cn = norm(str(c.get("name") or ""))
        if cn and (target in cn or cn in target):
            return c
    return None


def _atomic_write(path: Path, text: str) -> None:
    """先写临时文件再 os.replace，避免中途失败把档案截断。"""
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


CN_NUM = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
          "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn_to_int(s: str) -> int | None:
    """中文数字转整数，支持 一~九十九（章节名里够用了）。"""
    s = s.strip()
    if not s:
        return None
    if "十" in s:
        left, _, right = s.partition("十")
        tens = CN_NUM.get(left, 1) if left else 1
        ones = CN_NUM.get(right, 0) if right else 0
        return tens * 10 + ones
    if s in CN_NUM:
        return CN_NUM[s]
    return None


def chapter_sort_key(name: str, idx: int = 0):
    """章节排序：按名字里的中文数字（一、二、…）；没有数字的排最后（保持原顺序）。"""
    m = re.search(r"[（(]\s*([零一二两三四五六七八九十]+)\s*[）)]", name or "")
    if m:
        n = cn_to_int(m.group(1))
        if n:
            return (0, n, idx)
    return (1, 0, idx)


def sort_chapter_blocks(text: str) -> str:
    """把答案档案里的章节块按章节顺序重排（只挪块，不改块内内容）。"""
    lines = text.splitlines(keepends=True)
    spans = _chapter_spans(lines)
    if len(spans) < 2:
        return text
    header = "".join(lines[:spans[0]["start"]])
    blocks = [(sp["name"] or "", "".join(lines[sp["start"]:sp["end"]])) for sp in spans]
    ordered = sorted(enumerate(blocks), key=lambda item: chapter_sort_key(item[1][0], item[0]))
    ordered_text = header + "".join(block for _, (_, block) in ordered)
    if sorted(_chapter_names(ordered_text)) != sorted(_chapter_names(text)):
        log("  ! 章节重排可能受答案内 [[chapters]] 行影响，已跳过排序")
        return text
    return ordered_text


class Level:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.skip = bool(raw.get("skip", False))
        self.type = str(raw.get("type", "")).strip()
        self.answer = raw.get("answer", "")
        files = []
        if (isinstance(raw.get("files"), list)):
            for i, f in enumerate(raw["files"]):
                if isinstance(f, dict):
                    files.append({"path": str(f.get("path", "")).strip(),
                                  "answer": f.get("answer", "")})
                else:
                    log(f"  ! 关卡「{self.name}」的 files 第 {i + 1} 项不是表格，已忽略")
        self.files = files          # 多代码文件关卡的答案：[{path, answer}]
        _m = raw.get("multi")       # 代码关是否多文件：True/False；旧档案没有此字段 → None
        self.multi = bool(_m) if _m is not None else None

    def answer_empty(self) -> bool:
        if self.files:
            return all(_value_empty(f.get("answer")) for f in self.files)
        return _value_empty(self.answer)


class Chapter:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.homework_id = str(raw.get("homework_id", "")).strip()
        lvs = raw.get("levels", [])
        if not isinstance(lvs, list):
            die(f"答案档案格式错误：章节「{self.name}」的 levels 不是数组"
                "（TOML 里应写 [[chapters.levels]]），请手工检查。")
        for x in lvs:
            if not isinstance(x, dict):
                die(f"答案档案格式错误：章节「{self.name}」的 levels 里有不是表格的条目，请手工检查。")
        self.levels = [Level(x) for x in lvs]


def load_answers(path: Path, *, missing_ok: bool = False) -> list[Chapter]:
    if not path.exists():
        if missing_ok:
            return []
        die(f"答案档案不存在：{path}\n  先运行：python3 答题.py harvest")
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        die(f"答案档案 TOML 语法错误：{path}\n  {e}")
    except OSError as e:
        die(f"答案档案读取失败：{path}\n  {e}")
    raw_chs = data.get("chapters", [])
    if not isinstance(raw_chs, list):
        die(f"答案档案格式错误：chapters 不是数组（TOML 里应写 [[chapters]]，"
            f"现在是 {type(raw_chs).__name__}）：{path}\n  请手工检查")
    for c in raw_chs:
        if not isinstance(c, dict):
            die(f"答案档案格式错误：chapters 里有不是表格的条目：{path}\n  请手工检查")
    chapters = [Chapter(c) for c in raw_chs]
    if not chapters and not missing_ok:
        die("答案档案里没有任何 [[chapters]] 条目。")
    return chapters


def find_level(chapter: Chapter, index: int, name: str) -> Level | None:
    """按关卡序号（1 基）匹配档案条目；序号越界时退回按名字找。

    注意：同一章可能有重名关卡（八章有两个「选择题」），所以序号优先。
    """
    if 0 < index <= len(chapter.levels):
        return chapter.levels[index - 1]
    n = norm(name)
    for lv in chapter.levels:
        if lv.name and norm(lv.name) == n:
            return lv
    return None


def write_scan_skeleton(path: Path, scanned: list[dict]) -> None:
    """把扫描结果并入答案档案。

    · 文件不存在：生成完整骨架；
    · 已存在：按名字（忽略空白、允许双向包含）找章，只追加缺的关卡；
    · 已有章节缺 homework_id 时补上；
    · 写入前用 tomllib 校验，失败则保留原文件。
    """
    if not scanned:
        return

    def level_lines(lv: dict) -> list[str]:
        """生成一个关卡的档案行：name [+ multi] + answer 或文件块（scan 只写空骨架）。"""
        out = ["[[chapters.levels]]",
               f'name = {json.dumps(lv["name"], ensure_ascii=False)}']
        multi = lv.get("multi")
        paths = lv.get("paths") or []
        if multi is not None:
            out.append(f'multi = {"true" if multi else "false"}')
        if multi and paths:
            for path_ in paths:
                out.append("[[chapters.levels.files]]")
                out.append(f'path = {json.dumps(path_, ensure_ascii=False)}')
                out.append('answer = ""')
        else:
            out.append('answer = ""')
        out.append("")
        return out

    def block(ch: dict) -> str:
        out = ["[[chapters]]", f'name = {json.dumps(ch["name"], ensure_ascii=False)}']
        if ch.get("homework_id"):
            out.append(f'homework_id = {json.dumps(ch["homework_id"], ensure_ascii=False)}')
        out.append("")
        for lv in ch["levels"]:
            out.extend(level_lines(lv))
        return "\n".join(out)

    if not path.exists():
        header = (
            "# 头歌自动答题 · 标准答案档案（通用版）\n"
            "# ─────────────────────────────────────────────\n"
            "# · 这份档案只记录：章节顺序 + 每关答案，不记录任何人的答题进度。\n"
            "#   已通过的关卡由脚本运行时查详情页状态自动跳过，所以同一份档案\n"
            "#   可以发给进度不同的人使用。\n"
            "# · 代码题：answer 用三个单引号原样包住完整代码（若代码里出现三个单引号，改用三个双引号）。\n"
            "# · 选择题：answer 填选项字母；多题填列表，如 answer = [\"B\", \"A\", \"D\"]。\n"
            "# · 不想跑某关/某章：删掉对应条目，或自行加 skip = true（一般不需要）。\n"
            "# · 代码关是否为多文件：harvest 会自动写入 multi = true/false，不用手改。\n\n"
            "version = 1\n\n"
        )
        text = header + "\n".join(
            block(ch) for ch in sorted(scanned, key=lambda c: chapter_sort_key(c["name"]))
        )
    else:
        text = path.read_text(encoding="utf-8")
        try:
            existing = tomllib.loads(text)
        except tomllib.TOMLDecodeError as e:
            die(f"答案档案 TOML 语法错误：{path}\n  {e}")
        for ch in scanned:
            src = text.splitlines(keepends=True)
            spans = _chapter_spans(src)
            span = _find_chapter_span(spans, ch["name"])
            if span is None:
                text = text.rstrip() + "\n\n" + block(ch) + "\n"
                continue
            raw = _find_raw_chapter(existing.get("chapters", []), span["name"] or ch["name"])
            if raw is None:
                text = text.rstrip() + "\n\n" + block(ch) + "\n"
                continue
            # 回填 homework_id（只补空，不覆盖已有值）
            if ch.get("homework_id") and not str(raw.get("homework_id") or "").strip():
                hid_line = f'homework_id = {json.dumps(ch["homework_id"], ensure_ascii=False)}'
                # 只在章头区（第一个 [[chapters.levels]] 之前）查找/插入，
                # 避免命中关卡答案里的同名文本。
                hdr_end = span["end"]
                for k in range(span["start"] + 1, span["end"]):
                    if src[k].strip() == "[[chapters.levels]]":
                        hdr_end = k
                        break
                replaced = False
                for k in range(span["start"] + 1, hdr_end):
                    m = _HID_ASSIGN.match(src[k].rstrip("\r\n"))
                    if m is not None:
                        # 原地只换值，保留行首缩进与行尾注释
                        val = json.dumps(ch["homework_id"], ensure_ascii=False)
                        src[k] = f"{m.group(1)}{val}{m.group(3)}\n"
                        replaced = True
                        break
                    if re.match(r"^\s*homework_id\s*=", src[k]):
                        indent = src[k][:len(src[k]) - len(src[k].lstrip())]
                        src[k] = indent + hid_line + "\n"
                        replaced = True
                        break
                if not replaced:
                    for k in range(span["start"] + 1, hdr_end):
                        if re.match(r"^\s*name\s*=", src[k]):
                            if not src[k].endswith("\n"):
                                src[k] += "\n"
                            src.insert(k + 1, hid_line + "\n")
                            break
                text = "".join(src)
                src = text.splitlines(keepends=True)
                spans = _chapter_spans(src)
                span = _find_chapter_span(spans, ch["name"])
                if span is None:
                    continue
            have_names = [str(lv.get("name") or "") for lv in raw.get("levels", [])]
            scan_names = [lv["name"] for lv in ch["levels"]]
            if [norm(x) for x in have_names] != [norm(x) for x in scan_names[:len(have_names)]]:
                log(f"  ! 章节「{span['name']}」的档案条目与扫描结果顺序/名字不一致，"
                    "未自动改动，请手动核对")
                continue
            missing = ch["levels"][len(have_names):]
            if not missing:
                continue
            lines = []
            for lv in missing:
                lines.extend(level_lines(lv))
            insert = "\n".join(lines) + "\n"
            if span["end"] > 0 and not src[span["end"] - 1].endswith("\n\n"):
                insert = "\n" + insert
            src.insert(span["end"], insert)
            text = "".join(src)
    old_names = _chapter_names(text)
    text = sort_chapter_blocks(text)
    new_names = _chapter_names(text)
    if sorted(new_names) != sorted(old_names):
        die("生成档案时章节结构异常（答案里可能含 [[chapters]] 行），未写入原文件")
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        die(f"生成档案时 TOML 校验失败，未写入原文件：{e}")
    _verify_scan_result(parsed, scanned)
    _atomic_write(path, text)


# ─────────────────────────── 子命令：scan ───────────────────────────



_FILES_HDR = re.compile(r"^\[\[chapters\.levels\.files\]\]")
_KEY_ANSWER = re.compile(r"^answer\s*=")
_KEY_PATH = re.compile(r"^path\s*=")
_STRUCT_HDR = re.compile(
    r"^\s*(?:\[\[chapters\]\]|\[\[chapters\.levels\]\])(?:\s|#|$)")
_HID_ASSIGN = re.compile(
    r"^(\s*homework_id\s*=\s*)(\"(?:[^\"\\]|\\.)*\"|'[^']*'|[^\s#]+)([ \t]*(?:#.*)?)$")

# 把写回载荷/重建块包成最小合法档案，便于用 tomllib 精确核对答案
_LEVEL_WRAP = ('[[chapters]]\nname = "__wrap__"\n\n'
               '[[chapters.levels]]\nname = "__wrap__"\n')
_BLOCK_WRAP = '[[chapters]]\nname = "__wrap__"\n'


def _parse_wrapped_level(prefix: str, body: str) -> dict:
    """prefix + body 必须解析出一个带单个关卡的档案，返回该关卡表。"""
    text = prefix + body
    if not text.endswith("\n"):
        text += "\n"
    data = tomllib.loads(text)
    return data["chapters"][0]["levels"][0]


def _level_answer_shape(raw: dict) -> tuple:
    """关卡的答案形态：("files", [(path, answer)…]) 或 ("answer", 值)。

    files 为空数组时按单 answer 关卡处理（与 _raw_level_empty 的空值判断一致），
    否则 `files = []` 这种占位会被误当成多文件关卡。
    """
    files = raw.get("files")
    if isinstance(files, list) and files:
        return ("files", [(str(f.get("path") or ""), f.get("answer")) for f in files
                          if isinstance(f, dict)])
    return ("answer", raw.get("answer"))


def _payload_struct_line(payload: str) -> str | None:
    """载荷里行首出现章节/关卡表头时返回该行（用于拒绝会污染档案的载荷）。"""
    for line in payload.splitlines():
        if _STRUCT_HDR.match(line):
            return line.strip()
    return None


def _value_done(text: str) -> bool:
    """text 以 TOML value 的起点开始（可能跨多行，含换行）。

    value 已完整结束（闭合后本行只剩注释/空白）时返回 True；
    字符串/数组未闭合，或闭合后同行还有别的内容时返回 False。
    assignments/archive 只用到字符串和数组，但这里按 TOML 常见形态扫描以策万全。
    """
    n = len(text)
    i = 0
    stack: list[str] = []          # "[", "{", "'", '"', "'''", '"""'

    def closed_entire_line(k: int) -> bool:
        # 闭合之后，本行要只剩注释/空白才算这个 value 结束
        while k < n and text[k] in " \t":
            k += 1
        return k >= n or text[k] in "#\r\n"

    def skip_multiline(k: int, quote: str) -> int | None:
        """跳过以 quote 收尾的多行字符串，返回结束引号之后的下标。

        TOML 允许用 4/5 个引号收尾（多出的 1/2 个引号属于内容），
        所以不能直接 find("'''")；基本字符串里的 \\\" 也要跳过，
        否则会把转义引号误当成结束符。
        """
        if quote == "'''":
            while k < n:
                if text[k] != "'":
                    k += 1
                    continue
                run = k
                while run < n and text[run] == "'":
                    run += 1
                if run - k >= 3:
                    return run          # 连同 4/5 引号收尾一起吃掉
                k = run
            return None
        while k < n:
            c = text[k]
            if c == "\\":
                k += 2                 # 转义字符（含 \""" 里的第一个引号）
                continue
            if c != '"':
                k += 1
                continue
            run = k
            while run < n and text[run] == '"':
                run += 1
            if run - k >= 3:
                return run
            k = run
        return None

    while i < n:
        top = stack[-1] if stack else ""
        if top in ("'''", '"""'):
            j = skip_multiline(i, top)
            if j is None:
                return False
            i = j
            stack.pop()
            if not stack and closed_entire_line(i):
                return True
            continue
        if top == "'":
            j = text.find("'", i)
            if j < 0:
                return False
            i = j + 1
            stack.pop()
            if not stack and closed_entire_line(i):
                return True
            continue
        if top == '"':
            j = i
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            if j >= n:
                return False
            i = j + 1
            stack.pop()
            if not stack and closed_entire_line(i):
                return True
            continue
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        if c == "#":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c in ("'", '"'):
            if text[i:i + 3] in ("'''", '"""'):
                stack.append(text[i:i + 3])
                i += 3
                continue
            stack.append(c)
            i += 1
            continue
        if c == "[":
            stack.append("[")
            i += 1
            continue
        if c == "{":
            stack.append("{")
            i += 1
            continue
        if c == "]":
            if stack and stack[-1] == "[":
                stack.pop()
                i += 1
                if not stack and closed_entire_line(i):
                    return True
                continue
            return False   # 括号不配对（TOML 不合法）
        if c == "}":
            if stack and stack[-1] == "{":
                stack.pop()
                i += 1
                if not stack and closed_entire_line(i):
                    return True
                continue
            return False
        if c == "," and stack:
            i += 1
            continue
        j0 = i
        while i < n and text[i] not in ",\n#]}\t \"'":
            i += 1
        if not stack and closed_entire_line(i):
            return True
        if i == j0:
            i += 1           # 顶层零散字符（不合法 TOML），强制前进避免死循环
        continue
    return False


def _find_value_end(lines: list[str], i: int, limit: int) -> int:
    """lines[i] 是 `key = value` 行，返回 value（含行尾注释）占到哪一行（含）。

    未在 [i, limit) 内闭合时返回 -1（无法安全定位，调用方应放弃写回该块）。
    """
    eq = lines[i].find("=")
    buf = lines[i][eq + 1:]
    j = i
    while j + 1 < limit and not _value_done(buf):
        j += 1
        buf += lines[j]
    return j if _value_done(buf) else -1


def _scan_answer_zone(lines: list[str], lstart: int, lend: int) -> tuple[int | None, int]:
    """在关卡块 [lstart, lend) 内精确定位答案区 [zone_start, zone_end)。

    · 答案区 = 第一个 answer/files 行起，最后一个答案值（单行/跨行数组/
      三引号字符串/连续的 [[chapters.levels.files]] 块及其间注释）的结束；
    · 答案区之后的 skip/type/注释等行原样保留（由调用方移到新 payload 之前）；
    · 块里没有答案区时 zone_start=None；
    · answer 值没闭合 / 出现其他表头时 raise ValueError（无法安全判断）。
    """
    k = lstart + 1
    while k < lend:
        s = lines[k].strip()
        if _FILES_HDR.match(s) or _KEY_ANSWER.match(s):
            break
        if s.startswith("["):
            # [chapters.levels.files] 之类的子表头出现在 answer 之前：
            # 再往后写 answer 会落进子表里，直接拒绝。
            raise ValueError(f"答案区之前出现了表头「{s}」")
        k += 1
    if k >= lend:
        return None, lend          # 块里没有答案区（老一点的档案可能只有名字）
    i = k
    while i < lend:
        s = lines[i].strip()
        if _FILES_HDR.match(s):
            i += 1
            continue
        if s == "" or s.startswith("#"):
            nxt = i
            while nxt < lend and (lines[nxt].strip() == ""
                                  or lines[nxt].strip().startswith("#")):
                nxt += 1
            ns = lines[nxt].strip() if nxt < lend else ""
            if (_FILES_HDR.match(ns) or _KEY_PATH.match(ns) or _KEY_ANSWER.match(ns)):
                i = nxt            # files 块内部的注释/空行属于答案区，一并替换
                continue
            return k, i            # 答案区之后的注释/空行开始是“保留尾部”
        if _KEY_ANSWER.match(s) or _KEY_PATH.match(s):
            vend = _find_value_end(lines, i, lend)
            if vend < 0:
                raise ValueError("answer 的值没有闭合（跨行字符串/数组写坏了）")
            i = vend + 1
            continue
        if s.startswith("["):
            raise ValueError(f"答案区里出现了其他表头「{s}」")
        return k, i                # 其他键（skip/type/…）：答案区到此结束
    return k, lend


def write_back_answers(path: Path, changes: dict[str, dict[int, object]], force: bool) -> int:
    """把采集结果写回答案档案：按章节块、按关卡序号替换 answer / files。

    · 默认只填空答案（多文件关按“所有文件是否都有答案”判断），force=True 才覆盖；
    · 只替换目标关卡的答案区（单行/跨行数组/三引号字符串/[[chapters.levels.files]]
      块都精确定位），name/skip/type/multi 等字段与注释原样保留—— answer 之后
      的 skip/type/注释会移到新答案之前，绝不会被删掉；
    · 关卡块结构无法安全判断（answer 未闭合 / 答案区混入其他表头）时直接 die，
      提示手工处理，绝不静默删；
    · 写入前用 tomllib 校验，成功落盘后才打印“已写回”；返回写回的关卡数。
    """
    if not path.exists():
        die(f"答案档案不存在：{path}\n  先运行：python3 答题.py harvest")
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    old_names = _chapter_names(text)

    # 1) 扫描出行级结构：章节块 / 关卡块
    chapters: list[dict] = []
    cur_ch: dict | None = None
    cur_lv: dict | None = None

    def close_level(end: int) -> None:
        nonlocal cur_lv
        if cur_lv is not None:
            cur_lv["end"] = end
            if cur_ch is not None:
                cur_ch["levels"].append(cur_lv)
            cur_lv = None

    def close_chapter(end: int) -> None:
        nonlocal cur_ch
        close_level(end)
        if cur_ch is not None:
            cur_ch["end"] = end
            chapters.append(cur_ch)
            cur_ch = None

    for i, line in enumerate(lines):
        s = line.strip()
        if s == "[[chapters]]":
            close_chapter(i)
            cur_ch = {"start": i, "levels": [], "name": None}
        elif s == "[[chapters.levels]]":
            close_level(i)
            cur_lv = {"start": i, "name": None}
        else:
            m = re.match(r"\s*name\s*=", line)
            if m:
                nm = _parse_name_line(line)
                if nm is not None:
                    if cur_lv is not None and cur_lv["name"] is None:
                        cur_lv["name"] = nm
                    elif cur_ch is not None and cur_ch["name"] is None:
                        cur_ch["name"] = nm
    close_chapter(len(lines))

    # 2) 变更 key 与档案章节名对齐（卡片名可能只是档案名的超集/子集）
    remaining = dict(changes)
    matched: list[tuple[dict, dict]] = []
    for ch in chapters:
        cname = ch.get("name") or ""
        key = next((k for k in remaining if norm(k) == norm(cname)), None)
        if key is None:
            for k in remaining:
                kn, cn = norm(k), norm(cname)
                if kn and cn and (kn in cn or cn in kn):
                    key = k
                    break
        if key is not None:
            matched.append((ch, remaining.pop(key)))
    for key in remaining:
        log(f"  ! 档案里没有章节「{key}」，答案未写回")
    if not matched:
        return 0

    # 3) 收集编辑（从后往前改，避免行号漂移）
    edits: list[tuple[int, int, list[str], str]] = []
    for ch in matched:
        want = ch[1]
        cname = ch[0].get("name") or ""
        for idx, ans in sorted(want.items(), reverse=True):
            extra_multi = None
            payload_name = ""
            payload = ans
            if isinstance(ans, dict):
                extra_multi = ans.get("multi")
                payload_name = str(ans.get("name") or "")
                payload = str(ans.get("answer", ""))
            payload = str(payload)
            if not payload.strip():
                log(f"  ! 「{cname}」第{idx}关答案为空，跳过")
                continue
            struct_line = _payload_struct_line(payload)
            if struct_line is not None:
                die("答案载荷里出现了章节/关卡表头，已停止写回（避免毒化档案）：\n"
                    f"  章节「{cname}」第{idx}关：{struct_line}")
            if not (1 <= idx <= len(ch[0]["levels"])):
                log(f"  ! 章节「{cname}」没有第 {idx} 关，跳过")
                continue
            level = ch[0]["levels"][idx - 1]
            arch_name = str(level.get("name") or "")
            if payload_name and arch_name and norm(payload_name) != norm(arch_name):
                log(f"  ! 章节「{cname}」第{idx}关名字不一致"
                    f"（平台「{payload_name}」/档案「{arch_name}」），可能顺序变了，已跳过")
                continue
            lstart, lend = level["start"], level["end"]
            block_text = "".join(lines[lstart:lend])
            try:
                parsed = tomllib.loads('[[chapters]]\nname = "x"\n' + block_text)
                raw_lv = parsed["chapters"][0]["levels"][0]
            except tomllib.TOMLDecodeError:
                log(f"  ! 「{level['name']}」的档案块无法解析，跳过（请手动检查）")
                continue
            if not force and not _raw_level_empty(raw_lv):
                log(f"  ! 「{level['name']}」已有答案，未覆盖（-f 可强制覆盖）")
                continue
            # 头部 = 第一个 answer/files 行之前的内容，原样保留；
            # 答案区 = 从那行起到最后一个答案值结束（跨行数组/三引号字符串/
            # 多个 [[chapters.levels.files]] 块都要覆盖到）；
            # 答案区之后的 skip/type/注释等行保留下来，移到新 payload 之前。
            try:
                zone_start, zone_end = _scan_answer_zone(lines, lstart, lend)
            except ValueError as e:
                die("答案档案结构无法安全判断，已停止写回，请手工修改：\n"
                    f"  章节「{cname}」关卡「{arch_name or f'第{idx}关'}」"
                    f"（第 {lstart + 1} 行起）：{e}")
            if zone_start is None:
                header = list(lines[lstart + 1:lend])   # 块里没有答案区：整体当头部
                tail = []
            else:
                header = list(lines[lstart + 1:zone_start])
                tail = list(lines[zone_end:lend])
            # 尾部两端的多余空行去掉，避免块内堆叠
            while tail and not tail[-1].strip():
                tail.pop()
            while tail and not tail[0].strip():
                tail.pop(0)
            if extra_multi is not None:
                new_multi = f"multi = {'true' if extra_multi else 'false'}\n"
                replaced = False
                for lst in (header, tail):
                    for k, line in enumerate(lst):
                        if re.match(r"^\s*multi\s*=", line):
                            lst[k] = new_multi
                            replaced = True
                            break
                    if replaced:
                        break
                if not replaced:
                    pos = 0
                    for k, line in enumerate(header):
                        if re.match(r"^\s*name\s*=", line):
                            pos = k + 1
                            break
                    # 插入点前一行若是 EOF 无换行的最后一行，先补换行，
                    # 否则 multi 会和它粘在同一行。
                    if pos > 0 and not header[pos - 1].endswith("\n"):
                        header[pos - 1] += "\n"
                    header.insert(pos, new_multi)
            payload_lines = payload.splitlines(keepends=True)
            if payload_lines and not payload_lines[-1].endswith("\n"):
                payload_lines[-1] += "\n"
            # EOF 无换行时，直接拼 payload 会粘到上一行（注释/字段）里：
            # 三个拼接位置的末行都补上换行，保证 payload 从新行开始。
            if lines[lstart] and not lines[lstart].endswith("\n"):
                lines[lstart] += "\n"
            if header and not header[-1].endswith("\n"):
                header[-1] += "\n"
            if tail and not tail[-1].endswith("\n"):
                tail[-1] += "\n"
            new_block = [lines[lstart]] + header + tail + payload_lines + ["\n"]
            # 写盘前重新解析：载荷与重建后的关卡 answer/files 必须一致，
            # 防止换行/表头/结构行把答案写进别的地方。
            payload_text = "".join(payload_lines)
            try:
                expected_lv = _parse_wrapped_level(_LEVEL_WRAP, payload_text)
                actual_lv = _parse_wrapped_level(_BLOCK_WRAP, "".join(new_block))
            except tomllib.TOMLDecodeError as e:
                die(f"写回载荷或重建后的关卡无法解析，未改动原文件：{e}")
            if "answer" not in expected_lv and "files" not in expected_lv:
                die("写回载荷里没有 answer/files，未改动原文件")
            if _level_answer_shape(actual_lv) != _level_answer_shape(expected_lv):
                die("写回后关卡答案与载荷不一致，未改动原文件（请手工核对）：\n"
                    f"  章节「{cname}」关卡「{arch_name or f'第{idx}关'}」")
            edits.append((lstart, lend, new_block, str(level["name"] or f"第{idx}关")))

    if not edits:
        return 0
    for lstart, lend, new_block, _ in sorted(edits, key=lambda e: e[0], reverse=True):
        lines[lstart:lend] = new_block
    new_text = sort_chapter_blocks("".join(lines))
    try:
        tomllib.loads(new_text)
    except tomllib.TOMLDecodeError as e:
        die(f"写回答案时 TOML 校验失败，未改动原文件：{e}")
    if sorted(_chapter_names(new_text)) != sorted(old_names):
        die("写回后章节结构发生变化（可能是答案里含有 [[chapters]] 行），未改动原文件")
    if not _files_paths_unique(new_text):
        die("写回后多文件关卡的 path 出现重复，未改动原文件")
    _atomic_write(path, new_text)
    for _, _, _, name in sorted(edits, key=lambda e: e[0]):
        log(f"  ✓ 已写回：「{name}」")
    return len(edits)
