"""章节进入、关卡导航与进度状态读取（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

import json
import re
import time

import cdp
from eduauto.page import Page
from eduauto.util import die, log, norm

LEVEL_RE = re.compile(r"第(\d+)关\s*[：:]\s*([^\n]{1,60})")


PASS_STATUS = {"已通过", "已提交"}


def card_pos_js(name: str) -> str:
    return r"""
(function(){
  const norm = s => (s||'').replace(/[\s\u3000]+/g,'');
  const target = norm(__NAME__);
  const cards = [...document.querySelectorAll('[class*="listItem"]')];
  const card = cards.find(c => norm(c.innerText).includes(target));
  if (!card) return JSON.stringify({ok:false, reason:'card-not-found'});
  card.scrollIntoView({block:'center'});
  const cands = [...card.querySelectorAll('*')].filter(el => norm(el.innerText) === '开始学习');
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // 窗口窄时按钮可能被挤出视口：取"元素与视口的交集"中心点来点
    const x1 = Math.max(r.left, 0), x2 = Math.min(r.right, innerWidth);
    const y1 = Math.max(r.top, 0), y2 = Math.min(r.bottom, innerHeight);
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const at = document.elementFromPoint(x, y);
    const hit = !!(at && at.closest && at.closest('[class*="actionIcon"]'));
    return JSON.stringify({ok:true, x, y, hit});
  }
  return JSON.stringify({ok:false, reason:'start-button-not-found',
                         text: (card.innerText||'').replace(/\n+/g,' | ').slice(0,120)});
})()
""".replace("__NAME__", json.dumps(name, ensure_ascii=False))


class ChapterEnterError(RuntimeError):
    """进入章节失败（没找到可点的动作按钮，或点击后没有新标签页）。"""


def enter_chapter(browser: cdp.Browser, classroom: Page, chapter_name: str,
                  timeout: float = 20, on_fail: str = "die") -> tuple[dict, cdp.WS]:
    """在课堂页点某章的「开始学习」，返回（新标签页 target, 其会话）。

    课堂列表刷新时有 ant-spin 遮罩会挡住点击，这里会等遮罩消失并校验落点，失败自动重试。
    """
    before = {t["id"] for t in browser.pages()}
    last_reason = ""
    for attempt in range(4):
        # 等加载遮罩消失
        for _ in range(30):
            try:
                if not classroom.ws.eval(
                    "!!document.querySelector('.ant-spin-spinning')"
                ):
                    break
            except cdp.CDPError:
                break
            time.sleep(0.5)
        try:
            data = json.loads(classroom.ws.eval(card_pos_js(chapter_name)) or "{}")
        except cdp.CDPError:
            data = {}
        if not data.get("ok"):
            last_reason = data.get("reason", "未知")
            if data.get("text"):
                last_reason += "：" + data["text"]
            time.sleep(0.5)
            continue
        if not data.get("hit"):
            last_reason = "按钮被加载遮罩挡住"
            time.sleep(0.5)
            continue
        classroom.ws.mouse_click(data["x"], data["y"])
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.3)
            for t in browser.pages():
                if t["id"] not in before:
                    u = t.get("url", "")
                    if "/tasks/" in u or re.search(r"/shixun_homework/\d+", u):
                        ws = browser.attach(t)
                        return t, ws
        last_reason = "点击后没有等到新标签页"
    if on_fail == "raise":
        raise ChapterEnterError(last_reason)
    die(f"找不到章节「{chapter_name}」的「开始学习」按钮（{last_reason}）。\n"
        "  请确认浏览器停在课堂-实训作业列表页，且该章状态为“提交中”。")


def close_extra_tabs(browser: cdp.Browser, keep_ids: set[str]) -> None:
    for t in browser.pages():
        if "/tasks/" in t.get("url", "") and t["id"] not in keep_ids:
            browser.close_target(t["id"])


def wait_index_change(page: Page, old_index: int, timeout: float = 60) -> dict:
    """等待关卡序号变化（用于上一关/下一关/评测后跳转）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            st = page.state()
        except cdp.CDPError:
            continue
        if st.get("index") and st.get("index") != old_index:
            return page.wait_level(want_index=st.get("index"), timeout=timeout)
    return page.state()


def _click_toolbar_and_wait(page: Page, label: str, old_index: int,
                            attempts: int = 3, per: float = 20) -> dict:
    """点工具栏按钮并等待关卡变化；页面刚加载时点击可能不生效，自动重试。"""
    st = page.state()
    for i in range(attempts):
        if page.click_toolbar(label):
            st = wait_index_change(page, old_index, timeout=per)
            if st.get("index") != old_index:
                return st
        time.sleep(1)
        st = page.wait_level(want_index=old_index, timeout=10)
    return st


def rewind_to_first(page: Page, timeout: float = 60) -> dict:
    """不断点「上一关」，直到第 1 关（或没有上一关）。"""
    st = page.wait_level(timeout=timeout)
    for _ in range(20):
        if st.get("index", 0) <= 1 or not st.get("hasPrev"):
            return st
        old = st.get("index")
        st = _click_toolbar_and_wait(page, "上一关", old)
        if st.get("index") == old:
            break
    return st


def advance_level(page: Page, old_index: int, timeout: float = 60) -> dict:
    """点工具栏「下一关」，等待关卡变化（带重试）。"""
    return _click_toolbar_and_wait(page, "下一关", old_index)


def status_of(page: Page, text: str) -> str | None:
    """从页面文本里抓某关的通过状态（详情页表格用）。"""
    return None


def card_progress_js(name: str) -> str:
    """按名字片段找课堂卡片，返回 {done, total, name}（name 为卡片完整标题）。"""
    return r"""
JSON.stringify((function(){
  const norm = s => (s||'').replace(/[\s\u3000]+/g,'');
  const card = [...document.querySelectorAll('[class*="listItem"]')]
      .find(c => norm(c.innerText).includes(norm(__NAME__)));
  if (!card) return {done: 0, total: 0, name: ''};
  const m = (card.innerText||'').match(/(\d+)\s*\/\s*(\d+)/);
  const t = (card.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  return {done: m ? +m[1] : 0, total: m ? +m[2] : 0, name: t[1] || ''};
})())
""".replace("__NAME__", json.dumps(name, ensure_ascii=False))


def scrape_status(browser: cdp.Browser, classroom: Page, detail_url: str,
                  expect: int | None = None) -> list[dict]:
    """打开章节详情页，按顺序返回 [{'name','full','score','status'}, ...]。"""
    classroom.ws.call("Page.navigate", {"url": detail_url})
    ok = classroom.ws.wait_for(
        "!!document.querySelector('.ant-table-row')", timeout=45
    )
    if not ok:
        log("  ! 详情页表格未加载，跳过状态检查")
        return []
    last, stable = -1, 0
    t0 = time.time()
    deadline = t0 + (40 if expect else 30)
    while time.time() < deadline:
        try:
            if classroom.ws.eval("!!document.querySelector('.ant-spin-spinning')"):
                time.sleep(0.4)
                continue
            n = classroom.ws.eval("document.querySelectorAll('.ant-table-row').length")
            ready = bool(n) and bool(classroom.ws.eval(
                "[...document.querySelectorAll('.ant-table-row')].every(tr => {"
                "  const td = tr.querySelectorAll('td');"
                "  return td.length >= 5 && (td[4].innerText || '').trim().length > 0;})"
            ))
        except cdp.CDPError:
            n, ready = last, False
        if n:
            if n == last:
                stable += 1
            else:
                stable = 0
            last = n
            if expect and n >= expect and ready:
                break
            # 表格分批渲染：行数稳定还不够，要等状态列有字（否则会读出空状态）
            if not expect and ready and stable >= 3 and time.time() - t0 >= 3:
                break
        time.sleep(0.6)
    rows = classroom.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.ant-table-row')].map(tr => {
  const tds = [...tr.querySelectorAll('td')];
  return {name: (tds[1]?.innerText || '').replace(/\s+/g,' ').trim(),
          full: (tds[2]?.innerText || '').trim(),
          score: (tds[3]?.innerText || '').trim(),
          status: (tds[4]?.innerText || '').trim()};
}).filter(r => r.name))
""") or []
    if expect and len(rows) < expect:
        log(f"  ! 详情页只读到 {len(rows)} 行（课堂卡片显示共 {expect} 关），可能有遗漏")
    return rows


def _num(s) -> float | None:
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


def is_passed_row(row: dict | None) -> bool:
    """这一关是否真正拿到满分。

    · 「已通过」= 满分；
    · 选择题/测试题显示「已提交」，可能是部分得分——必须比对 得分>=分值。
    """
    if not row:
        return False
    status = (row.get("status") or "").strip()
    if status == "已通过":
        return True
    if status == "已提交":
        full, score = _num(row.get("full")), _num(row.get("score"))
        return full is not None and score is not None and full > 0 and score >= full - 0.005
    return False


def row_at(rows: list[dict], index: int, name: str = "") -> dict | None:
    """按关卡序号取详情行；序号越界时退回按名字找。"""
    if 0 < index <= len(rows):
        return rows[index - 1]
    for r in rows:
        if norm(r.get("name", "")) == norm(name):
            return r
    return None
