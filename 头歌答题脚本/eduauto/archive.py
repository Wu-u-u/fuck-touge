"""答案档案的纯逻辑（无浏览器依赖）：解析 / 读取 / 写回 / 排序 / scan 骨架格式。"""

import json
import re
import tomllib
from pathlib import Path

from .util import die, log, norm


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
    starts = [i for i, l in enumerate(lines) if l.strip() == "[[chapters]]"]
    if len(starts) < 2:
        return text
    header = "".join(lines[:starts[0]])
    blocks = []
    for bi, s in enumerate(starts):
        e = starts[bi + 1] if bi + 1 < len(starts) else len(lines)
        name = None
        for k in range(s, e):
            m = re.match(r"\s*name\s*=\s*(.*)", lines[k])
            if m:
                try:
                    name = json.loads(m.group(1))
                except Exception:
                    name = None
                break
        blocks.append((name or "", "".join(lines[s:e])))
    ordered = sorted(enumerate(blocks), key=lambda t: chapter_sort_key(t[1][0], t[0]))
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
            return all(not str(f.get("answer") or "").strip() for f in self.files)
        if isinstance(self.answer, list):
            return not self.answer or all(not str(x).strip() for x in self.answer)
        return not str(self.answer or "").strip()


class Chapter:
    def __init__(self, raw: dict):
        self.name = str(raw.get("name", "")).strip()
        self.homework_id = str(raw.get("homework_id", "")).strip()
        self.levels = [Level(x) for x in raw.get("levels", [])]


def load_answers(path: Path) -> list[Chapter]:
    if not path.exists():
        die(f"答案档案不存在：{path}\n  先运行：python3 答题.py scan -a")
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        die(f"答案档案 TOML 语法错误：{path}\n  {e}")
    chapters = [Chapter(c) for c in data.get("chapters", [])]
    if not chapters:
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
    · 已存在：只追加缺的章节/关卡，绝不改写用户已填内容；
    · 写入前用 tomllib 校验，失败则保留原文件。
    """
    def level_lines(lv: dict) -> list[str]:
        """生成一个关卡的档案行：name [+ multi] + answer 或文件块（scan 只写空骨架）。"""
        lines = ["[[chapters.levels]]",
                 f'name = {json.dumps(lv["name"], ensure_ascii=False)}']
        multi = lv.get("multi")
        paths = lv.get("paths") or []
        if multi is not None:
            lines.append(f'multi = {"true" if multi else "false"}')
        if multi and paths:
            for p in paths:
                lines.append("[[chapters.levels.files]]")
                lines.append(f'path = {json.dumps(p, ensure_ascii=False)}')
                lines.append('answer = ""')
        else:
            lines.append('answer = ""')
        lines.append("")
        return lines

    def block(ch: dict) -> str:
        lines = ["[[chapters]]", f'name = {json.dumps(ch["name"], ensure_ascii=False)}']
        if ch.get("homework_id"):
            lines.append(f'homework_id = {json.dumps(ch["homework_id"], ensure_ascii=False)}')
        lines.append("")
        for lv in ch["levels"]:
            lines.extend(level_lines(lv))
        return "\n".join(lines)

    if not path.exists():
        header = (
            "# 头歌自动答题 · 标准答案档案（通用版）\n"
            "# ─────────────────────────────────────────────\n"
            "# · 这份档案只记录：章节顺序 + 每关答案，不记录任何人的答题进度。\n"
            "#   已通过的关卡由脚本运行时查详情页状态自动跳过，所以同一份档案\n"
            "#   可以发给进度不同的人使用。\n"
            "# · 代码题：answer 用三个单引号原样包住完整代码（若代码里出现 '''，改用三个双引号）。\n"
            "# · 选择题：answer 填选项字母；多题填列表，如 answer = [\"B\", \"A\", \"D\"]。\n"
            "# · 不想跑某关/某章：删掉对应条目，或自行加 skip = true（一般不需要）。\n"
            "# · 代码关是否为多文件：scan/harvest 会自动写入 multi = true/false，不用手改。\n\n"
            "version = 1\n\n"
        )
        text = header + "\n".join(
            block(ch) for ch in sorted(scanned, key=lambda c: chapter_sort_key(c["name"]))
        )
    else:
        text = path.read_text(encoding="utf-8")
        existing = tomllib.loads(text)
        exists_ch = {c.get("name"): c for c in existing.get("chapters", [])}
        additions = []
        for ch in scanned:
            if ch["name"] not in exists_ch:
                additions.append(block(ch))
                continue
            have_names = [lv.get("name") for lv in exists_ch[ch["name"]].get("levels", [])]
            scan_names = [lv["name"] for lv in ch["levels"]]
            # 按顺序对齐：已有条目必须是扫描结果的前缀，多出来的尾巴才补写
            if have_names != scan_names[:len(have_names)]:
                log(f"  ! 章节「{ch['name']}」的档案条目与扫描结果顺序/名字不一致，"
                    "未自动改动，请手动核对")
                continue
            missing = ch["levels"][len(have_names):]
            if missing:
                lines = []
                for lv in missing:
                    lines.extend(level_lines(lv))
                # 插到该章块的末尾（下一个 [[chapters]] 之前）
                src = text.splitlines(keepends=True)
                ch_start = None
                for i, line in enumerate(src):
                    if line.strip() == "[[chapters]]":
                        # 往后找 name 行
                        for j in range(i + 1, min(i + 8, len(src))):
                            m = re.match(r'\s*name\s*=\s*(.*)', src[j])
                            if m:
                                try:
                                    if json.loads(m.group(1)) == ch["name"]:
                                        ch_start = i
                                except Exception:
                                    pass
                                break
                        if ch_start is not None:
                            break
                if ch_start is None:
                    additions.append(block({"name": ch["name"],
                                            "homework_id": ch.get("homework_id"),
                                            "levels": missing}))
                else:
                    end = len(src)
                    for k in range(ch_start + 1, len(src)):
                        if src[k].strip() == "[[chapters]]":
                            end = k
                            break
                    insert = "\n".join(lines)
                    if end > 0 and not src[end - 1].endswith("\n\n"):
                        insert = "\n" + insert
                    src.insert(end, insert)
                    text = "".join(src)
        if additions:
            text = text.rstrip() + "\n\n" + "\n".join(additions) + "\n"
    text = sort_chapter_blocks(text)      # 章节按顺序排好，看着舒服
    # 校验后落盘
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        die(f"生成档案时 TOML 校验失败，未写入原文件：{e}")
    path.write_text(text, encoding="utf-8")


# ─────────────────────────── 子命令：scan ───────────────────────────



def write_back_answers(path: Path, changes: dict[str, dict[int, str]], force: bool) -> None:
    """把采集结果写回答案档案：按章节块、按关卡顺序精确替换 answer。

    · 默认只填空答案，已有答案不动；force=True 才覆盖；
    · 只动对应关卡块的行，文件其它内容（注释、格式）原样保留；
    · 写入前用 tomllib 校验，失败则不动原文件。
    """
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
            m = re.match(r"\s*name\s*=\s*(.*)", line)
            if m:
                try:
                    nm = json.loads(m.group(1))
                except Exception:
                    nm = None
                if nm is not None:
                    if cur_lv is not None and cur_lv["name"] is None:
                        cur_lv["name"] = nm
                    elif cur_ch is not None and cur_ch["name"] is None:
                        cur_ch["name"] = nm
    close_chapter(len(lines))

    # 2) 收集要替换的编辑（从后往前改，避免行号漂移）
    edits = []   # (level_start, level_end, new_block_lines, name)
    for ch in chapters:
        want = changes.get(ch.get("name") or "")
        if not want:
            continue
        for idx, ans in sorted(want.items(), reverse=True):
            extra_multi = None          # 支持 {"answer":…, "multi": bool} 载荷（顺带写单/多文件标记）
            if isinstance(ans, dict):
                extra_multi = ans.get("multi")
                ans = str(ans.get("answer", ""))
            if not (1 <= idx <= len(ch["levels"])):
                log(f"  ! 章节「{ch.get('name')}」没有第 {idx} 关，跳过")
                continue
            level = ch["levels"][idx - 1]
            lstart, lend = level["start"], level["end"]
            block = "".join(lines[lstart:lend])
            try:
                parsed = tomllib.loads('[[chapters]]\nname = "x"\n' + block)
                existing = parsed["chapters"][0]["levels"][0].get("answer", "")
            except tomllib.TOMLDecodeError:
                existing = ""
            is_empty = not str(existing).strip()
            if not is_empty and not force:
                log(f"  ! 「{level['name']}」已有答案，未覆盖（--force 可强制覆盖）")
                continue
            # 重建块：header + name + [skip] + [multi] + answer
            name_line = None
            has_skip = False
            multi_line = None
            for k in range(lstart + 1, lend):
                s = lines[k].strip()
                if s.startswith("skip"):
                    has_skip = True
                if s.startswith("multi") and multi_line is None:
                    multi_line = s + "\n"
                if s.startswith("name =") and name_line is None:
                    name_line = k
            new_block = ["[[chapters.levels]]\n"]
            if name_line is not None:
                new_block.append(lines[name_line])
            if has_skip:
                new_block.append("skip = true\n")
            if extra_multi is not None:
                new_block.append(f"multi = {'true' if extra_multi else 'false'}\n")
            elif multi_line is not None:
                new_block.append(multi_line)
            new_block.append(ans if ans.endswith("\n") else ans + "\n")
            new_block.append("\n")
            edits.append((lstart, lend, new_block, level["name"]))

    if not edits:
        return
    # 3) 从后往前替换
    for lstart, lend, new_block, name in sorted(edits, key=lambda e: e[0], reverse=True):
        lines[lstart:lend] = new_block
        log(f"  ✓ 已写回：「{name}」")

    new_text = "".join(lines)
    new_text = sort_chapter_blocks(new_text)      # 章节按顺序排好
    try:
        tomllib.loads(new_text)
    except tomllib.TOMLDecodeError as e:
        die(f"写回答案时 TOML 校验失败，未改动原文件：{e}")
    path.write_text(new_text, encoding="utf-8")


