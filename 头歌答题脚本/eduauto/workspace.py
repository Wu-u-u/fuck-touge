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


# 课堂卡片的双向匹配：档案名常常比卡片标题长（如档案「Java面向对象（二） - 封装、
# 继承和多态」vs 卡片「Java面向对象（二）」），只做 cardText.includes(target)
# 永远找不到。这里同时接受 target.includes(卡片标题行)，并按最长命中行打分，
# 避免短标题误命中别的卡片。
_CARD_MATCH_JS = r"""
  const norm = s => (s||'').replace(/[\s\u3000]+/g,'');
  const NOISE = /^(开始学习|查看作品|已截止|继续学习|提交中|未开始|已完成)$/;
  const titleLines = c => (c.innerText||'').split('\n')
      .map(s => s.trim())
      .filter(s => s && !NOISE.test(s) && !/^\d+\s*\/\s*\d+$/.test(s));
  const matchScore = (c, target) => {
    if (norm(c.innerText).includes(target)) return 100000 + target.length;
    let best = 0;
    for (const line of titleLines(c)) {
      const n = norm(line);
      if (n.length >= 2 && target.includes(n)) best = Math.max(best, n.length);
    }
    return best;
  };
  const findCard = target => {
    let best = null, bestScore = 0, ties = 0;
    for (const c of document.querySelectorAll('[class*="listItem"]')) {
      const s = matchScore(c, target);
      if (s > bestScore) { best = c; bestScore = s; ties = 1; }
      else if (s === bestScore && s > 0) { ties++; }
    }
    return {card: best, score: bestScore, ties};
  };
"""


def card_pos_js(name: str) -> str:
    return r"""
(function(){
__CARD_MATCH__
  const target = norm(__NAME__);
  const found = findCard(target);
  const card = found.card;
  if (!card) return JSON.stringify({ok:false, reason:'card-not-found'});
  if (found.ties > 1) return JSON.stringify({ok:false, reason:'ambiguous', ties:found.ties});
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
""".replace("__CARD_MATCH__", _CARD_MATCH_JS).replace(
        "__NAME__", json.dumps(name, ensure_ascii=False))


class ChapterEnterError(RuntimeError):
    """进入章节失败（没找到可点的动作按钮，或点击后没有新标签页）。"""


def wait_cards(page: Page, timeout: float = 10) -> bool:
    """等课堂章节卡片渲染出来（SPA 异步；新开的课堂页常常先空白）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if page.ws.eval("document.querySelectorAll('[class*=\"listItem\"]').length > 0"):
                return True
        except cdp.CDPError:
            break
        time.sleep(0.25)
    return False


def enter_chapter(browser: cdp.Browser, classroom: Page, chapter_name: str,
                  timeout: float = 20, on_fail: str = "die") -> tuple[dict, cdp.WS]:
    """在课堂页点某章的「开始学习」，返回（新标签页 target, 其会话）。

    课堂列表刷新时有 ant-spin 遮罩会挡住点击，这里会等遮罩消失并校验落点，失败自动重试。
    """
    if not wait_cards(classroom, 10):
        log("  ! 课堂卡片 10 秒内没有渲染出来，仍尝试查找…")
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


def rewind_to_first(page: Page, timeout: float = 60) -> tuple[dict, bool]:
    """不断点「上一关」，直到第 1 关（或没有上一关）。

    返回 (状态, 是否确实回到第 1 关)。回退失败（停在中间关卡）时第二项为 False，
    调用方必须据此决定停止或报错，不能当成正常从中间开始。
    """
    st = page.wait_level(timeout=timeout)
    for _ in range(20):
        if (st.get("index") or 0) <= 1 or not st.get("hasPrev"):
            break
        old = st.get("index")
        st = _click_toolbar_and_wait(page, "上一关", old)
        if st.get("index") == old:
            break
    return st, st.get("index") == 1


def advance_level(page: Page, old_index: int, timeout: float = 60) -> dict:
    """点工具栏「下一关」，等待关卡变化（带重试）。"""
    return _click_toolbar_and_wait(page, "下一关", old_index)


def status_of(page: Page, text: str) -> str | None:
    """从页面文本里抓某关的通过状态（详情页表格用）。"""
    return None


def card_progress_js(name: str) -> str:
    """按名字片段找课堂卡片，返回 {done, total, name}（name 为卡片完整标题）。

    与 card_pos_js 保持一致：命中多张同分卡片（ambiguous）时不猜，
    返回 {done: 0, total: 0, name: ''} 并带 reason，调用方提示用户。"""
    return r"""
JSON.stringify((function(){
__CARD_MATCH__
  const found = findCard(norm(__NAME__));
  if (!found.card) return {done: 0, total: 0, name: '', reason: 'card-not-found'};
  if (found.ties > 1) return {done: 0, total: 0, name: '',
                              reason: 'ambiguous', ties: found.ties};
  const card = found.card;
  const m = (card.innerText||'').match(/(\d+)\s*\/\s*(\d+)/);
  const t = (card.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  return {done: m ? +m[1] : 0, total: m ? +m[2] : 0, name: t[1] || ''};
})())
""".replace("__CARD_MATCH__", _CARD_MATCH_JS).replace(
        "__NAME__", json.dumps(name, ensure_ascii=False))


def scrape_status(browser: cdp.Browser, classroom: Page, detail_url: str,
                  expect: int | None = None) -> list[dict]:
    """打开章节详情页，按顺序返回 [{'name','full','score','status'}, ...]。"""
    classroom.ws.call("Page.navigate", {"url": detail_url})
    # 复用标签页时，导航提交前旧表格仍是有效 DOM：先等 URL 真正切到目标详情页。
    # 必须吃 wait_for 的返回值——落地失败时旧表格很可能就是别的章节的，
    # 继续读只会拿到脏数据（v0.9.15 修复：原来只等不等结果）。
    m = re.search(r"/shixun_homework/(\d+)/detail", detail_url)
    if m:
        landed = classroom.ws.wait_for(
            f"location.href.includes('/shixun_homework/{m.group(1)}/detail')"
            " && document.readyState === 'complete'",
            timeout=20,
        )
        if not landed:
            log("  ! 详情页没有落地（URL 没在 20 秒内切到目标详情页），"
                "不读表格以免拿到别的章节的旧数据")
            return []
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
            state = classroom.ws.eval_json(r"""
JSON.stringify((() => {
  const spin = !!document.querySelector('.ant-spin-spinning');
  const rows = [...document.querySelectorAll('.ant-table-row')];
  const ready = rows.length > 0 && rows.every(tr => {
    const td = tr.querySelectorAll('td');
    return td.length >= 5 && (td[4].innerText || '').trim().length > 0;
  });
  return {spin, n: rows.length, ready};
})())
""") or {}
        except cdp.CDPError:
            state = {"spin": False, "n": last, "ready": False}
        if not isinstance(state, dict):
            state = {}
        if state.get("spin"):
            time.sleep(0.4)
            continue
        n = int(state.get("n") or 0)
        ready = bool(state.get("ready"))
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
