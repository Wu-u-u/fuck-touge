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
USER_BASE = "https://www.educoder.net"
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


def course_name_from_answers(path: Path | None, code: str) -> str:
    """从档案文件反推课程原名（优先读 header，旧档案退回文件名）。"""
    if path is None:
        return ""
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:2000]
        m = re.search(r"^#\s*课程：(.+?)（" + re.escape(code) + r"）", head, re.M)
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    stem = path.stem
    suffix = f"-{code}"
    return stem[:-len(suffix)] if stem.endswith(suffix) else stem


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


def _account_login(page: Page) -> str:
    """从登录态 localStorage 取用户 login（不是显示昵称）。"""
    try:
        login = str(page.ws.eval(
            "(()=>{try{const u=JSON.parse(localStorage.getItem('userInfo')||'null');"
            "return (u&&u.login)||''}catch(e){return ''}})()"
        ) or "")
    except Exception:
        return ""
    return login if re.fullmatch(r"[A-Za-z0-9_-]+", login) else ""


def _user_classrooms_ready(page: Page) -> bool:
    try:
        return bool(page.ws.eval(
            "(()=>{const t=(document.body&&document.body.innerText)||'';"
            "return t.includes('个人主页') || t.includes('我的教学课堂');})()"
        ))
    except Exception:
        return False


def _user_classrooms_empty(page: Page) -> bool:
    try:
        return bool(page.ws.eval(
            "(()=>{const t=(document.body&&document.body.innerText)||'';"
            "return /暂无|还没有.*课堂|没有.*课堂|暂无数据/.test(t);})()"
        ))
    except Exception:
        return False


def _user_classrooms_forbidden(page: Page) -> bool:
    try:
        return bool(page.ws.eval(
            "(()=>{const t=(document.body&&document.body.innerText)||'';"
            "return t.includes('403') || t.includes('无权限') || t.includes('没有权限');})()"
        ))
    except Exception:
        return False


def _active_course_tab(page: Page) -> str:
    try:
        return str(page.ws.eval(
            "(()=>{const tabs=document.querySelector('[class*=\"tabs___\"]');"
            "if(!tabs) return '';"
            "const a=[...tabs.querySelectorAll('[class*=\"active\"]')]"
            ".find(e=>(e.innerText||'').trim());"
            "return a ? (a.innerText||'').trim() : '';})()"
        ) or "")
    except Exception:
        return ""


def _mine_tab_active(page: Page) -> bool:
    return _active_course_tab(page) == "我的"


def list_courses(page: Page) -> list[str]:
    """在课堂列表页点「我的」，返回我的课程名（按页面顺序）。

    课程列表页也会以**后台标签页**打开；后台页收不到真实鼠标点击，
    旧实现于是把「最新」的 16 门公开课当成「我的」返回。这里先切前台，
    再以「我的」标签的 active 状态确认切换成功；不能确认就返回空列表，
    不再把全量课程静默当成个人课程。
    """
    try:
        page.ws.call("Page.bringToFront")   # 后台标签收不到真实点击，直接切前台
        time.sleep(0.3)
    except Exception:
        pass

    # 优先走个人主页：/users/<login>/classrooms 是平台自己的“我的课堂”页，
    # 不依赖「最新/最热/我的」标签切换，也不会把公开课列表当成个人课程。
    login = _account_login(page)
    if login:
        personal_url = f"{USER_BASE}/users/{login}/classrooms"
        try:
            current_url = str(page.ws.eval("location.href") or "")
            if not current_url.startswith(personal_url):
                page.ws.call("Page.navigate", {"url": personal_url})
                page.ws.wait_for("document.readyState !== 'loading'", timeout=40)
            for _ in range(50):
                if _user_classrooms_forbidden(page):
                    break
                if _user_classrooms_ready(page):
                    names = _read_course_names(page)
                    if names or _user_classrooms_empty(page):
                        return names
                time.sleep(0.3)
        except Exception:
            pass
        # 个人页不可用（例如个别账号 403）时回到公开列表，再走「我的」标签兜底。
        try:
            page.ws.call("Page.navigate", {"url": COURSES_URL})
            page.ws.wait_for("document.readyState !== 'loading'", timeout=40)
        except Exception:
            pass

    before = _read_course_names(page)
    was_mine = _mine_tab_active(page)
    expr = ("[...document.querySelectorAll('span,div,li,a,button')]"
            ".find(e=>(e.innerText||'').trim()==='我的')")
    if not was_mine:
        page.click_expr(expr)

    names = before
    for i in range(50):
        time.sleep(0.3)
        names = _read_course_names(page)
        active = _active_course_tab(page)
        if active == "我的":
            # 已经是「我的」直接返回；从「最新/最热」切过来时，必须等
            # 旧列表真正被替换，不能把切换瞬间的 16 门公开课当成个人课程。
            if was_mine or (names and names != before):
                return names
        # 某些页面版本没有 active class，但列表确实已切换
        if not was_mine and names and before and names != before:
            return names
        if i in (8, 18, 30):
            page.click_expr(expr)
    log("  ! 未能确认切到「我的」课程列表；请确认页面已登录后重试")
    return []


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


def _login_from_open_pages(browser) -> str:
    """从已打开的 educoder 页面读 login；用于直接打开个人课堂页，避免先闪一下 /classrooms。"""
    try:
        pages = browser.pages()
    except Exception:
        return ""
    for t in pages:
        if "educoder.net" not in (t.get("url") or ""):
            continue
        try:
            ws = browser.attach(t)
            try:
                login = _account_login(Page(ws, t))
            finally:
                ws.close()
        except Exception:
            continue
        if login:
            return login
    return ""


def open_course_list(browser, cfg: dict, old: Page | None = None) -> Page:
    from eduauto.browser import classroom_page
    # 已登录的页面里能读到 login 时直接开个人课堂页；这样 cd/browser
    # 不会先显示一下公开课程列表，也不依赖「我的」标签。
    login = _login_from_open_pages(browser)
    url = (f"{USER_BASE}/users/{login}/classrooms"
           if login else str(cfg["edge"]["courses"]))
    return classroom_page(browser, cfg, old=old, url=url)


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
            ws.wait_for("document.readyState !== 'loading'", timeout=40)
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
        # 任务页标题是章节名，课程页标题偶尔还是平台名；档案 header
        # 保存了 cd 时的课程原名，优先用它做批量运行的课程匹配。
        saved_name = course_name_from_answers(course.answers, course.code)
        if saved_name:
            course.name = saved_name
        return course
    return None
