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
    """按 [[chapters]] 切块，返回 [{start, end, name}]（end 为下一章起始）。"""
    starts = [
        i for i, line in enumerate(lines)
        if line.strip() == "[[chapters]]"
        and any(re.match(r"^\s*name\s*=", lines[j])
                for j in range(i + 1, min(i + 8, len(lines))))
    ]
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
        spans.append({"start": s, "end": e, "name": name})
    return spans


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
    return header + "".join(block for _, (_, block) in ordered)


class Level:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.skip = bool(raw.get("skip", False))
        self.type = str(raw.get("type", "")).strip()
        self.answer = raw.get("answer", "")
        files = []
        for f in raw.get("files") or []:
            if isinstance(f, dict):
                files.append({"path": str(f.get("path", "")).strip(),
                              "answer": f.get("answer", "")})
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
        self.levels = [Level(x) for x in raw.get("levels", [])]


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
    chapters = [Chapter(c) for c in data.get("chapters", [])]
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
                for k in range(span["start"] + 1, span["end"]):
                    if re.match(r"^\s*name\s*=", src[k]):
                        src.insert(k + 1,
                                   f'homework_id = {json.dumps(ch["homework_id"], ensure_ascii=False)}\n')
                        break
                text = "".join(src)
                src = text.splitlines(keepends=True)
                spans = _chapter_spans(src)
                span = _find_chapter_span(spans, ch["name"])
                if span is None:
                    continue
            have_names = [str(lv.get("name") or "") for lv in raw.get("levels", [])]
            scan_names = [lv["name"] for lv in ch["levels"]]
            if have_names != scan_names[:len(have_names)]:
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
    text = sort_chapter_blocks(text)
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        die(f"生成档案时 TOML 校验失败，未写入原文件：{e}")
    _atomic_write(path, text)


# ─────────────────────────── 子命令：scan ───────────────────────────



def write_back_answers(path: Path, changes: dict[str, dict[int, object]], force: bool) -> int:
    """把采集结果写回答案档案：按章节块、按关卡序号替换 answer / files。

    · 默认只填空答案（多文件关按“所有文件是否都有答案”判断），force=True 才覆盖；
    · 只替换目标关卡的答案区，name/skip/type/multi 等头部字段与注释原样保留；
    · 写入前用 tomllib 校验，成功落盘后才打印“已写回”；返回写回的关卡数。
    """
    if not path.exists():
        die(f"答案档案不存在：{path}\n  先运行：python3 答题.py harvest")
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)

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
            # 头部 = 第一个 answer/files 行之前的内容，原样保留
            header_end = lend
            for k in range(lstart + 1, lend):
                s = lines[k].strip()
                if re.match(r"^answer\s*=", s) or s == "[[chapters.levels.files]]":
                    header_end = k
                    break
            header = list(lines[lstart + 1:header_end])
            if extra_multi is not None:
                new_multi = f"multi = {'true' if extra_multi else 'false'}\n"
                replaced = False
                for k, line in enumerate(header):
                    if re.match(r"^\s*multi\s*=", line):
                        header[k] = new_multi
                        replaced = True
                        break
                if not replaced:
                    pos = 0
                    for k, line in enumerate(header):
                        if re.match(r"^\s*name\s*=", line):
                            pos = k + 1
                            break
                    header.insert(pos, new_multi)
            payload_lines = payload.splitlines(keepends=True)
            if payload_lines and not payload_lines[-1].endswith("\n"):
                payload_lines[-1] += "\n"
            new_block = [lines[lstart]] + header + payload_lines + ["\n"]
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
    _atomic_write(path, new_text)
    for _, _, _, name in sorted(edits, key=lambda e: e[0]):
        log(f"  ✓ 已写回：「{name}」")
    return len(edits)
