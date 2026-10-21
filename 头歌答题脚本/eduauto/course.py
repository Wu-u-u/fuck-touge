"""课程选择：从课堂列表页选课，按浏览器当前页面识别课程。"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

import cdp
from eduauto.page import Page
from eduauto.util import die, log

COURSES_URL = "https://www.educoder.net/classrooms"
CLASSROOM_BASE = "https://www.educoder.net/classrooms"

_CLASSROOM_RE = re.compile(r"/classrooms/([A-Za-z0-9]+)(?:/|$)")
_TASK_RE = re.compile(r"/tasks/([A-Za-z0-9]+)(?:/|$)")


@dataclass
class Course:
    name: str
    code: str
    classroom: str
    answers: Path | None = None


def _slug(name: str) -> str:
    s = re.sub(r"[\\/:*?\"<>|\s]+", "-", name).strip("-")
    return s[:80] or "course"


def answers_dir(cfg: dict) -> Path:
    return Path(cfg["run"]["answers_dir"])


def answers_file(cfg: dict, name: str, code: str) -> Path:
    return answers_dir(cfg) / f"{_slug(name)}-{code}.toml"


def parse_course_url(url: str, title: str = "") -> Course | None:
    """从课程/任务 URL 解析课程；不是课程页返回 None。"""
    if not url:
        return None
    m = _CLASSROOM_RE.search(url)
    code = m.group(1) if m else None
    if code in (None, "new"):
        m = _TASK_RE.search(url)
        code = m.group(1) if m else None
    if not code or code == "new":
        return None
    name = (title or "").strip()
    if not name or name in ("头歌实践教学平台", "教学课堂"):
        name = code
    return Course(name=name, code=code,
                  classroom=f"{CLASSROOM_BASE}/{code}/shixun_homework")


def _find_answers(cfg: dict, code: str) -> Path | None:
    d = answers_dir(cfg)
    if not d.exists():
        return None
    hits = sorted(d.glob(f"*-{code}.toml"))
    return hits[0] if hits else None


def find_answers_file(cfg: dict, code: str) -> Path | None:
    return _find_answers(cfg, code)


def ensure_answers_file(cfg: dict, course: Course) -> Path:
    """第一次 cd 时创建该课程的空档案（有 header，无章节）。"""
    p = answers_file(cfg, course.name, course.code)
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_text(
            "# 头歌答题档案（课程自动生成）\n"
            f"# 课程：{course.name}（{course.code}）\n"
            "# 用 harvest 补章节骨架并采集答案；run 使用本文件。\n\n"
            "version = 1\n",
            encoding="utf-8",
        )
        log(f"  ✓ 已新建课程档案：{p}")
    course.answers = p
    return p


def _read_course_names(page: Page) -> list[str]:
    try:
        raw = page.ws.eval_json(r"""
JSON.stringify((function(){
  const vis = e => {const r=e.getBoundingClientRect();
    const s=getComputedStyle(e);
    return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';};
  const cards=[...document.querySelectorAll('[class*="list___"] a')].filter(vis);
  return cards.map(a=>{
    const n=a.querySelector('[class*="name"]');
    return (n?n.innerText:a.innerText||'').trim().split('\n')[0].trim();
  }).filter(Boolean);
})())
""") or []
    except cdp.CDPError:
        return []
    out=[]
    for x in raw:
        n=str(x).strip()
        if n and n not in out: out.append(n)
    return out


def list_courses(page: Page) -> list[str]:
    """在课堂列表页点「我的」，返回课程名（按页面顺序）。"""
    before = _read_course_names(page)
    page.click_expr(
        "[...document.querySelectorAll('span,div,li,a,button')]"
        ".find(e=>(e.innerText||'').trim()==='我的')"
    )
    names = before
    for _ in range(30):
        time.sleep(0.3)
        names = _read_course_names(page)
        # 「我的」列表与「最新/最热」不同；等列表真正切换
        if names and names != before:
            break
    return names


def choose_course(courses: list[str], target: str) -> str:
    t = (target or "").strip()
    if not t:
        die("用法：python3 答题.py cd -ls ｜ python3 答题.py cd 序号/课程名")
    if t.isdigit():
        i = int(t)
        if not (1 <= i <= len(courses)):
            die(f"课程序号超出范围：{t}（可选 1-{len(courses)}）")
        return courses[i - 1]
    hits = [c for c in courses if t in c or c in t]
    if not hits:
        die("没有匹配的课程：" + t)
    if len(hits) > 1:
        log("！课程名命中多个，请写得更具体：")
        for i, c in enumerate(hits, 1):
            log(f"  {i}. {c}")
        die("未选择课程")
    return hits[0]


def open_course_list(browser, cfg: dict, old: Page | None = None) -> Page:
    from eduauto.browser import classroom_page
    return classroom_page(browser, cfg, old=old, url=str(cfg["edge"]["courses"]))


def select_course(browser, page: Page, name: str) -> tuple[dict, Course]:
    """在课程列表页点击课程卡片，返回（课程页 target, Course）。"""
    before = {t["id"] for t in browser.pages()}
    expr = (
        "[...document.querySelectorAll('[class*=\"list___\"] a')].find(a=>"
        "((a.querySelector('[class*=\"name\"]')||a).innerText||'').trim()"
        f"==={json.dumps(name, ensure_ascii=False)})"
    )
    if not page.click_expr(expr):
        die(f"没有找到课程卡片：{name}")
    target = None
    for _ in range(50):
        time.sleep(0.3)
        for t in browser.pages():
            if t["id"] not in before and "educoder.net" in (t.get("url") or ""):
                target = t
                break
        if target:
            break
    if target is None:
        die(f"点击课程「{name}」后没有打开课程页")
    url = target.get("url") or ""
    course = parse_course_url(url, target.get("title") or name)
    if course is None:
        die(f"无法从课程页识别课程：{url}")
    if name:
        course.name = name   # 以课程列表里的标题为准，避免页面 title 是平台名
    if "/shixun_homework" not in url:
        ws = browser.attach(target)
        try:
            ws.call("Page.navigate", {"url": course.classroom})
            ws.wait_for("document.readyState === 'complete'", timeout=40)
        finally:
            try:
                ws.close()
            except Exception:
                pass
    target["url"] = course.classroom
    return target, course


def current_course(browser, cfg: dict) -> Course | None:
    """按浏览器当前页面识别课程（不写 state 记忆）。"""
    try:
        targets = list(browser.pages())   # /json 顺序：新开的课程页在前
    except cdp.CDPError:
        return None
    for t in targets:
        url = t.get("url") or ""
        if "educoder.net" not in url:
            continue
        course = parse_course_url(url, t.get("title") or "")
        if course is None:
            continue
        course.answers = _find_answers(cfg, course.code)
        return course
    return None
