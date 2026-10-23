"""harvest/run 命令流程与档案状态输出（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

from pathlib import Path
import json
import re
import sys
import time

import cdp
from eduauto.page import Page
from eduauto.archive import Chapter, find_level, load_answers, write_back_answers, write_scan_skeleton
from eduauto.util import die, fmt_secs, log, norm
from eduauto.answers import answer_to_toml, read_saved_answer, read_test_result, wait_outcome
from eduauto.browser import classroom_page, ensure_browser, ensure_login
from eduauto.course import (choose_course, current_course, ensure_answers_file,
                            find_answers_file, list_courses, open_course_list, select_course)
from eduauto.code import answer_choice, choice_letters, close_file_menu, list_code_files, set_code, write_files
from eduauto.workspace import ChapterEnterError, advance_level, card_progress_js, enter_chapter, is_passed_row, rewind_to_first, row_at, scrape_status, wait_index_change

def _book_matches(chapters, name: str) -> list:
    """返回与卡片名匹配的档案章节：完全相等优先，其次双向子串。"""
    n = norm(name)
    exact = [c for c in chapters if norm(c.name) == n]
    if exact:
        return exact
    return [c for c in chapters if n and (n in norm(c.name) or norm(c.name) in n)]


def _book_lookup(chapters, name: str):
    """唯一匹配时返回章节；0 个或多个模糊命中都返回 None（多命中不猜）。"""
    hits = _book_matches(chapters, name)
    return hits[0] if len(hits) == 1 else None


def list_classroom_cards(page: Page) -> list[dict]:
    """读课堂页的章节卡片（名称 / 是否可进入 / 进度 / 是否已截止）。"""
    # 卡片异步渲染：先等列表出现（最多 30 秒），避免读到空列表
    for _ in range(60):
        try:
            if page.ws.eval("document.querySelectorAll('[class*=\"listItem\"]').length") > 0:
                break
        except cdp.CDPError:
            pass
        time.sleep(0.5)
    cards = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('[class*="listItem"]')].map(c => {
  const t = (c.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const hasStart = [...c.querySelectorAll('*')].some(el => (el.innerText||'').trim() === '开始学习');
  const prog = (c.innerText||'').match(/(\d+)\s*\/\s*(\d+)/);
  const raw = c.innerText || '';
  const closed = raw.includes('已截止') || (raw.includes('查看作品') && !hasStart);
  // 卡片标题前可能有多个状态标签（提交中 / 已开启补交 / 补交中），
  // 不能固定取 t[1]；优先读标题节点，读不到再退回状态标签之后的首行。
  const nameEl = c.querySelector('[class*="name___"]');
  const name = ((nameEl && nameEl.innerText) || t[1] || '').trim();
  return {name, hasStart, closed,
          done: prog ? +prog[1] : 0, total: prog ? +prog[2] : 0};
}).filter(c => c.name))
""") or []
    if not cards:
        log("  ! 课堂页没有读到章节卡片（页面可能还没加载完，稍后重试）")
    return cards


def harvest_levels(page: Page, passed: set, ch: "Chapter | None", force: bool,
                   collected: "dict | None" = None) -> dict:
    """在章节页里走一遍关卡，采集 passed 集合里关卡的答案。

    collected 可传外部 dict（cmd_harvest 这样用）：本章中途 die 退出时，
    已采到的答案仍在那个 dict 里，外层还能写回档案，不再随异常丢掉。
    """
    if collected is None:
        collected = {}
    st, reached_first = rewind_to_first(page)
    if not reached_first:
        idx = st.get("index")
        log(f"  ! 无法回到第 1 关（当前停在第{idx or '?'}关），停止采集本章，"
            "已采结果保留")
        return collected
    guard = 0
    while guard < 50:
        guard += 1
        idx = st.get("index")
        if not idx:
            log("  ! 页面状态读取失败，停止采集本章")
            break
        if idx in passed:
            lv = find_level(ch, idx, st.get("name") or "") if ch is not None else None
            if not force and lv is not None and not lv.answer_empty():
                log(f"  · 第{idx}关「{st.get('name')}」已有答案，跳过采集（-f 可强制重采）")
            else:
                kind, value, note = read_saved_answer(page, st)
                if kind:
                    try:
                        multi_flag = False if kind == "code" else (True if kind == "files" else None)
                        collected[idx] = {"answer": answer_to_toml(kind, value),
                                          "multi": multi_flag,
                                          "name": st.get("name") or ""}
                        log(f"  ✓ 第{idx}关「{st.get('name')}」：{note}")
                    except RuntimeError as e:
                        log(f"  ! 第{idx}关采集失败：{e}")
                else:
                    log(f"  ! 第{idx}关没采到答案：{note}")
        if not st.get("hasNext"):
            break
        st = advance_level(page, idx)
        if st.get("index") == idx:
            die(f"第{idx}关采集后无法进入下一关（可能被弹窗/遮罩挡住），已暂停。")
    return collected


def _write_skeleton(answers_path: Path, name: str, hid: str, rows: list[dict],
                    collected: "dict | None" = None) -> bool:
    """写入骨架；返回档案文件是否真的变化（用来避免虚报“已补骨架”）。"""
    before = answers_path.read_bytes() if answers_path.exists() else None
    levels = []
    for i, r in enumerate(rows, 1):
        lv: dict = {"name": r["name"]}
        c = (collected or {}).get(i)
        if c and isinstance(c, dict) and c.get("multi") is not None:
            lv["multi"] = c["multi"]
        levels.append(lv)
    write_scan_skeleton(answers_path, [{"name": name, "homework_id": hid, "levels": levels}])
    after = answers_path.read_bytes() if answers_path.exists() else None
    return before != after



def _reload_chapter(answers_path: Path, name: str) -> "Chapter | None":
    """补骨架后重新加载章节，避免内存里的旧 levels 漏掉新增关卡。"""
    for c in load_answers(answers_path, missing_ok=True):
        if norm(c.name) == norm(name):
            return c
    return None


def _open_levels_from_detail(browser: cdp.Browser, target: dict, page: Page):
    """进入章节若落在详情页，点「查看实战/继续挑战/进入实训」进关卡。

    返回 (target, page, ok)；成功进入时 target/page 已切换到关卡标签页。
    按钮可能异步渲染，先等它出现；点击后既接受新标签页，也接受当前页跳转。
    """
    if "/detail" not in (target["url"] or ""):
        return target, page, True
    # 补交/已提交章节的详情页常以**后台标签页**打开；后台标签页收不到
    # 真实鼠标点击，「查看实战」会一动不动。先切到前台再点。
    try:
        if page.ws.eval("document.visibilityState") != "visible":
            page.ws.call("Page.bringToFront")
            time.sleep(0.4)
    except cdp.CDPError:
        pass
    before = {p["id"] for p in browser.pages()}
    clicked = False
    deadline = time.time() + 15
    while time.time() < deadline and not clicked:
        for btn_text in ("查看实战", "继续挑战", "进入实训"):
            if page.click_expr(
                "[...document.querySelectorAll('a,button')].find("
                f"e=>(e.innerText||'').trim()==={json.dumps(btn_text)})"
            ):
                clicked = True
                break
        if not clicked:
            time.sleep(0.5)
    if not clicked:
        return target, page, False
    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(0.4)
        cur = next((p for p in browser.pages() if p["id"] == target["id"]), None)
        if cur and "/tasks/" in (cur.get("url") or ""):
            return cur, Page(browser.attach(cur), cur), True
        nxt = [p for p in browser.pages()
               if p["id"] not in before and "/tasks/" in (p.get("url") or "")]
        if nxt:
            browser.close_target(target["id"])
            target = nxt[0]
            return target, Page(browser.attach(target), target), True
    return target, page, False


def _match_card(cards: list[dict], name: str) -> dict | None:
    """在课堂卡片里唯一匹配一个章节名（完全相等优先，其次双向子串）。"""
    n = norm(name)
    exact = [c for c in cards if norm(str(c.get("name") or "")) == n]
    fuzzy = [c for c in cards
             if n and (n in norm(str(c.get("name") or ""))
                       or norm(str(c.get("name") or "")) in n)]
    hits = exact or fuzzy
    return hits[0] if len(hits) == 1 else None


def _rows_match_levels(rows: list[dict], ch: Chapter) -> bool:
    """详情表前缀是否与档案一致（防止复用标签页时读到上一章旧表）。

    允许 rows 比档案多（平台新增了关卡，后续走补骨架）；rows 比档案短
    或前 len(ch.levels) 个名字不一致则视为旧表/异常，拒绝。
    """
    if len(rows) < len(ch.levels):
        return False
    for row, lv in zip(rows, ch.levels):
        if norm(str(row.get("name") or "")) != norm(lv.name):
            return False
    return True


def cmd_harvest(args, cfg: dict) -> None:
    """扫描 + 采集（v0.9.12 合并 scan）。

    · 不带章节参数：自动发现课堂里的全部章节；
    · 已截止章节（只有「查看作品」）：只提示，不建骨架、不采集；
    · 档案里没有的章节：先补骨架；有已满分关卡再逐关采集；
    · 档案里已有、且已满分关卡的答案都齐了：整章跳过（-f 强制重采）。
    """
    browser = ensure_browser(cfg)
    course = current_course(browser, cfg)
    if course is None:
        die("没有当前课程：先 python3 答题.py cd -ls，再 python3 答题.py cd 序号/课程名")
    answers_path = course.answers or find_answers_file(cfg, course.code)
    if answers_path is None:
        die(f"课程「{course.name}」还没有答案档案：先 python3 答题.py cd {course.name}")
    cfg["run"]["answers"] = str(answers_path)   # 内部错误提示复用
    chapters = load_answers(answers_path, missing_ok=True)
    todo: list[Chapter] | None = None
    if args.chapter:
        todo = resolve_chapter_args(chapters, args.chapter, strict=False)
    classroom = classroom_page(browser, cfg, url=course.classroom)
    ensure_login(browser, classroom.ws)

    if args.chapter:
        targets = [{"name": ch.name, "ch": ch, "card": None} for ch in (todo or [])]
        covered = {norm(t["name"]) for t in targets}

        def _in_archive(pat: str) -> bool:
            pn = norm(pat)
            return any(pn and (pn in norm(c.name) or norm(c.name) in pn) for c in chapters)

        unmatched = [pat for pat in args.chapter if not _in_archive(pat)]
        if unmatched:
            classroom = classroom_page(browser, cfg, old=classroom, url=course.classroom)
            for card in list_classroom_cards(classroom):
                cn = norm(card["name"])
                if cn in covered:
                    continue
                hits = _book_matches(chapters, card["name"])
                if len(hits) > 1:
                    log(f"  ! 卡片「{card['name']}」匹配到多个档案章节，跳过")
                    continue
                if hits:
                    continue
                if any(norm(x) in norm(card["name"]) or norm(card["name"]) in norm(x)
                       for x in unmatched):
                    targets.append({"name": card["name"], "ch": None, "card": card})
                    covered.add(cn)
        if not targets:
            die("答案档案和课堂里都找不到指定章节。")
    else:
        classroom = classroom_page(browser, cfg, old=classroom, url=course.classroom)
        targets = []
        for c in list_classroom_cards(classroom):
            hits = _book_matches(chapters, c["name"])
            if len(hits) > 1:
                log(f"  ! 卡片「{c['name']}」匹配到 {len(hits)} 个档案章节，"
                    "无法确定对应关系，跳过（请把档案章节名区分清楚）")
                continue
            targets.append({"name": c["name"], "ch": hits[0] if hits else None, "card": c})

    all_changes: dict = {}
    for t in targets:
        name, ch, card = t["name"], t["ch"], t["card"]
        key = ch.name if ch is not None else name
        # 进章节用课堂卡片上的标题（档案名可能比卡片标题长，点不到「开始学习」）；
        # 写回档案仍用 key（档案章节名）。
        entry_name = (card or {}).get("name") or name
        log(f"\n→ 章节：{name}")
        if card and card.get("closed"):
            log("  ! 已截止（只能查看作品）——跳过，不建骨架、不采集")
            continue

        # 新章节：先进入拿 homework_id
        target = None
        page = None
        if ch is None or not ch.homework_id:
            classroom = classroom_page(browser, cfg, old=classroom, url=course.classroom)
            try:
                target, ws = enter_chapter(browser, classroom, entry_name, on_fail="raise")
            except ChapterEnterError as e:
                log(f"  ! 无法进入本章（{e}）——已截止/不可进，跳过（不建骨架）")
                continue
            page = Page(ws, target)
            m = re.search(r"/tasks/[^/]+/(\d+)/", target["url"] or "") or re.search(r"/shixun_homework/(\d+)/detail", target["url"] or "")
            if not m:
                browser.close_target(target["id"])
                log("  ! 无法从任务页解析 homework_id，跳过")
                continue
            hid = m.group(1)
        else:
            hid = ch.homework_id

        # 详情表格：这章有哪些关、哪些已满分
        classroom = classroom_page(browser, cfg, old=classroom, url=course.classroom)
        if card is None:
            # 显式指定档案章节时，先等卡片渲染出来并唯一匹配，避免课堂进度读成 0
            card = _match_card(list_classroom_cards(classroom), name)
            if card and card.get("closed"):
                log("  ! 已截止（只能查看作品）——跳过，不建骨架、不采集")
                continue
        if card is not None:
            prog = {"done": card.get("done", 0), "total": card.get("total", 0),
                    "name": card.get("name", "")}
        else:
            prog = classroom.ws.eval_json(card_progress_js(name)) or {}
        if prog.get("reason"):
            log(f"  ! 未能唯一定位课堂卡片（{prog['reason']}），课堂进度读数不可靠，"
                "以下以详情页实读为准")
        expect = prog.get("total") or (card or {}).get("total")
        rows = scrape_status(browser, classroom,
                             course.classroom + f"/{hid}/detail?tabs=1",
                             expect=expect)
        if not rows:
            if target:
                browser.close_target(target["id"])
            log("  ! 详情页没有读到关卡列表，跳过")
            continue
        if ch is not None and not _rows_match_levels(rows, ch):
            if target:
                browser.close_target(target["id"])
            log("  ! 详情表关卡名与档案不一致（可能读到了上一章的旧表），跳过本章")
            continue
        if expect and len(rows) < expect:
            # 表格截断（加载慢/分页没拉全）：按残表建骨架/采集会静默丢关卡
            if target:
                browser.close_target(target["id"])
            log(f"  ! 详情页只读到 {len(rows)} 行（课堂卡片显示共 {expect} 关），"
                "表格可能没加载完，跳过本章（不建骨架、不采集），稍后重试")
            continue
        passed = {i for i, r in enumerate(rows, 1) if is_passed_row(r)}

        # 骨架先行：新章节先落盘（采集中途失败也不会丢关卡结构）
        if ch is None:
            if _write_skeleton(answers_path, key, hid, rows):
                log("  ✓ 已补骨架")
            else:
                log("  · 档案里已有本章骨架，未重复写入")
        elif len(ch.levels) != len(rows):
            if _write_skeleton(answers_path, key, hid, rows):
                log("  · 档案关卡数与平台不一致，已补骨架")
                ch = _reload_chapter(answers_path, key) or ch
            else:
                log("  · 档案关卡数与平台不一致，未能自动改动，请手动核对")
        if ch is not None and not ch.homework_id:
            if _write_skeleton(answers_path, key, hid, rows):
                log("  · 已补写 homework_id")
                ch = _reload_chapter(answers_path, key) or ch

        if not passed:
            log("  → 没有已满分的关卡，跳过")
            if target:
                browser.close_target(target["id"])
            continue

        if ch is not None and not args.force:
            complete = all(
                (lv := find_level(ch, i, "")) is not None and not lv.answer_empty()
                for i in passed
            )
            if complete:
                log("  → 已满分关卡的答案都已齐，整章跳过（-f 可强制重采）")
                if target:
                    browser.close_target(target["id"])
                continue

        log(f"  已满分关卡：{sorted(passed)}")

        # 进入章节（新章节已在里面了）
        if target is None:
            classroom = classroom_page(browser, cfg, old=classroom, url=course.classroom)
            try:
                target, ws = enter_chapter(browser, classroom, entry_name, on_fail="raise")
            except ChapterEnterError as e:
                log(f"  ! 无法进入本章（{e}）——已截止的章节只有「查看作品」，跳过")
                continue
            page = Page(ws, target)

        target, page, entered = _open_levels_from_detail(browser, target, page)
        if not entered:
            browser.close_target(target["id"])
            log("  ! 详情页上没找到进入关卡的按钮，跳过本章")
            continue

        collected: dict = {}
        aborted: "SystemExit | None" = None
        try:
            harvest_levels(page, passed, ch, args.force, collected)
        except SystemExit as e:
            aborted = e            # 中止也要保留已采的回答案，先写回再 re-raise
        except (RuntimeError, cdp.CDPError) as e:
            aborted = SystemExit(2)
            log(f"  ! 采集中止：{e}")
        except KeyboardInterrupt:
            aborted = SystemExit(2)
            log("  ! 用户中断（Ctrl+C），先写回已采答案…")
        finally:
            try:
                browser.close_target(target["id"])
            except Exception:
                pass

        if collected:
            written = write_back_answers(answers_path, {key: collected}, force=args.force)
            if written:
                log(f"  ✓ 已写回答案档案：{key} {written} 关")
                all_changes[key] = collected
            else:
                log("  ! 采到答案但档案没有可写回的关卡，请检查章节/关卡是否对齐")
        if aborted is not None:
            if collected:
                log(f"  ! 采集中止：已把中止前采到的 {len(collected)} 关答案写回档案，"
                    "没有丢；继续跑到这里为止")
            raise aborted

    total = {n: len(v) for n, v in all_changes.items() if v}
    if total:
        log("\n✓ 采集完成：" + "、".join(f"{n} {c} 关" for n, c in total.items()) + "（已按章即时写回）")
    else:
        log("\n本轮没有采集到可写回的答案。")


def cmd_scan_retired() -> None:
    log("scan 已并入 harvest（v0.9.12）：")
    log("  python3 答题.py harvest [章节...] [-f]")
    log("  ——自动补骨架；有已满分关卡就采集答案；已截止章节只提示、跳过。")
    sys.exit(0)


def process_chapter(browser: cdp.Browser, classroom: Page, cfg: dict,
                    ch: Chapter, status: list[dict],
                    stats: "dict | None" = None) -> dict:
    """跑完一章。返回统计 {done, skipped, failed}。

    stats 可传外部汇总里已就位的 dict（cmd_run 这样用）：本章中途 die 退出时，
    已累计的作答/跳过数会留在那个 dict 里随之带回，不再丢失。

    注意：正常结束才关掉本章标签页；中途失败（die）保留页面给用户排查。
    """
    if stats is None:
        stats = {"done": 0, "skipped": 0, "failed": 0}
    try:
        target, ws = enter_chapter(browser, classroom, ch.name, on_fail="raise")
    except ChapterEnterError as e:
        # 整章没跑起来：按失败 1 关计（记成 skipped 会把「关数」单位用错）
        log(f"  ! 无法进入本章（{e}），跳过")
        stats["failed"] += 1
        return stats
    page = Page(ws)
    ok = False
    try:
        target, page, entered = _open_levels_from_detail(browser, target, page)
        if not entered:
            stats["failed"] += 1
            log("  ! 详情页上没找到进入关卡的按钮，跳过本章")
            browser.close_target(target["id"])
            return stats
        st, reached_first = rewind_to_first(page)
        if not st.get("index"):
            die(f"章节「{ch.name}」进入后未能读到关卡信息。")
        if not reached_first:
            die(f"章节「{ch.name}」无法回到第 1 关（当前停在第{st.get('index')}关），"
                "前面关卡会被跳过，已暂停。\n"
                "  请手动点「上一关」回到第 1 关，或先 harvest 后再运行。")
        log(f"  从第{st.get('index')}关开始：{st.get('name')}")
        guard = 0
        while guard < 50:
            guard += 1
            t_level = time.time()
            cur = st.get("index") or None
            st = page.wait_level(want_index=cur, timeout=30)
            idx, lname = st.get("index"), st.get("name")
            if not idx:
                die(f"章节「{ch.name}」页面状态读取失败。")
            lv = find_level(ch, idx, lname)
            row = row_at(status, idx, lname)
            row_status = (row or {}).get("status", "")
            if lv is None:
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」不在答案档案里。请先 harvest 补全档案。")
            need_skip = lv.skip or is_passed_row(row)
            log(f"  第{idx}关 {lname}："
                f"{'跳过（' + (row_status or '档案标记') + '）' if need_skip else '作答'}")
            if need_skip:
                stats["skipped"] += 1
                if not st.get("hasNext"):
                    log("  → 已是最后一关，本章结束")
                    break
                st = advance_level(page, idx)
                if st.get("index") == idx:
                    die(f"第{idx}关跳过时无法跳到下一关，已暂停。")
                continue

            # 作答
            if st.get("hasEditor") and lv.multi is False and not lv.files:
                # 档案已标明单文件：不碰「代码文件」下拉，直接整文件覆盖（快）
                code = str(lv.answer or "")
                if not code.strip():
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」的 answer 是空的，已暂停。\n"
                        f"  请填写：{cfg['run']['answers']}")
                try:
                    set_code(page, code)
                except RuntimeError as e:
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」写入代码失败，已暂停：{e}")
            elif st.get("hasEditor"):
                paths, _ = list_code_files(page)
                if len(paths) > 1:
                    log(f"    检测到 {len(paths)} 个代码文件：" + "、".join(paths))
                    if not lv.files:
                        close_file_menu(page)
                        snippet = "\n".join(
                            "    [[chapters.levels.files]]\n"
                            f"    path = {json.dumps(p, ensure_ascii=False)}\n"
                            "    answer = '''…'''"
                            for p in paths)
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」有多个代码文件，档案里还没有对应的 files 条目。\n"
                            f"  可运行 harvest 采集（已满分时），或参照下面的格式补全：\n{snippet}\n"
                            f"  档案：{cfg['run']['answers']}")
                    missing = [f.get("path") for f in lv.files
                               if not str(f.get("answer") or "").strip()]
                    if missing:
                        close_file_menu(page)
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」还有代码文件没填答案："
                            + "、".join(missing) + f"\n  请填写：{cfg['run']['answers']}")
                    try:
                        write_files(page, paths, lv.files)
                    except RuntimeError as e:
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」写入代码失败，已暂停：{e}")
                else:
                    close_file_menu(page)
                    code = str(lv.answer or "")
                    if not code.strip() and len(lv.files) == 1:
                        code = str(lv.files[0].get("answer") or "")
                    if not code.strip():
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」的 answer 是空的，已暂停。\n"
                            f"  请填写：{cfg['run']['answers']}")
                    try:
                        set_code(page, code)
                    except RuntimeError as e:
                        stats["failed"] += 1
                        die(f"第{idx}关「{lname}」写入代码失败，已暂停：{e}")
            elif st.get("choiceCount", 0) > 0:
                if lv.answer_empty():
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」的 answer 是空的，已暂停。\n"
                        f"  请填写：{cfg['run']['answers']}")
                try:
                    answer_choice(page, choice_letters(lv.answer))
                except (ValueError, RuntimeError) as e:
                    stats["failed"] += 1
                    die(f"第{idx}关「{lname}」选项勾选失败，已暂停：{e}")
            else:
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」既没有编辑器也没有选择题，无法作答，已暂停。")

            fail0 = st.get("failMsgs", 0)
            ctx = {"index0": idx, "url0": st.get("url"), "fail0": fail0,
                   "is_last": not st.get("hasNext"),
                   "test_result0": (read_test_result(page) or {}).get("text")}
            log("    点「评测」…")
            if not page.click_eval():
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」点评测后未检测到响应（可能仍在冷却或被遮挡），已暂停。")
            outcome = wait_outcome(page, ctx, float(cfg["run"]["eval_timeout"]))
            log(f"    结果：{outcome['kind']}（{outcome['detail']}）")
            if outcome["kind"] == "fail":
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」评测未通过，已暂停。\n"
                    f"  请查看浏览器里的错误详情，或修改答案档案后重新运行。")
            if outcome["kind"] == "timeout":
                stats["failed"] += 1
                die(f"第{idx}关「{lname}」等待评测结果超时，已暂停。")
            if outcome["kind"] == "submitted":
                # 选择题答案由用户确认正确；平台只显示「提交成功」面板，
                # 不查详情页分数，直接进入下一关（避免白等详情表/60 秒跳转轮询）。
                log("    ✓ 提交成功（选择题答案已确认，直接继续）")
                outcome["kind"] = "last" if outcome.get("last") else "next"
                outcome["submitted_panel"] = True
            stats["done"] += 1
            if outcome["kind"] == "last":
                log("  → 本章最后一关已通过，本章结束"
                    f"（本关用时 {time.time() - t_level:.1f} 秒）")
                break
            # next：等待进入下一关；提交面板不会自动跳，直接点工具栏
            if outcome.get("submitted_panel"):
                nxt = advance_level(page, idx)
            else:
                nxt = wait_index_change(page, idx, timeout=float(cfg["run"]["level_timeout"]))
                if nxt.get("index") == idx:
                    log("  ! 评测通过但页面没有跳到下一关，尝试点工具栏「下一关」…")
                    nxt = advance_level(page, idx)
            if nxt.get("index") == idx:
                die(f"第{idx}关评测已通过，但页面无法进入下一关，已暂停。")
            st = nxt
            log(f"    （本关用时 {time.time() - t_level:.1f} 秒）")
        ok = True
        return stats
    finally:
        if ok:
            browser.close_target(target["id"])


def resolve_chapter_args(chapters: list[Chapter], patterns: list[str],
                         *, strict: bool = True) -> list[Chapter]:
    """把命令行里的章节名/片段解析成章节列表（方案 B）。

    匹配忽略空白；短名命中多个章节时列出候选询问（回车=全部命中）。
    strict=True 时，档案里找不到的片段直接报错退出；harvest 传 False（可能来自课堂新章节）。
    """
    if not patterns:
        return list(chapters)
    order = {c.name: i for i, c in enumerate(chapters)}
    picked: dict[str, Chapter] = {}
    missing: list[str] = []
    for pat in patterns:
        pn = norm(pat)
        hits = [c for c in chapters if pn and pn in norm(c.name)]
        if not hits:
            missing.append(pat)
            continue
        if len(hits) > 1:
            log(f"\n！短名「{pat}」一次命中 {len(hits)} 个章节：")
            for i, h in enumerate(hits, 1):
                log(f"  {i}. {h.name}")
            try:
                ans = input("  选择要跑的编号（逗号分隔；回车=全部命中）：").strip()
            except EOFError:
                die("短名命中多个章节且无法询问，请把章节名写得更具体一些。")
            keep = hits
            if ans:
                sel = []
                for part in ans.replace("，", ",").split(","):
                    part = part.strip()
                    if part.isdigit() and 1 <= int(part) <= len(hits):
                        sel.append(hits[int(part) - 1])
                if not sel:
                    die(f"编号无效：{ans}（可选 1-{len(hits)}，逗号分隔）")
                keep = sel
            for h in keep:
                picked[h.name] = h
        else:
            picked[hits[0].name] = hits[0]
    if missing:
        if strict:
            die("答案档案里找不到这些章节：" + "、".join(missing))
        log("  ! 答案档案里没有：" + "、".join(missing) + "（将尝试从课堂里发现）")
    result = list(picked.values())
    result.sort(key=lambda c: order[c.name])
    return result


def cmd_cd(args, cfg: dict) -> None:
    """选择课程：cd -ls 列课程，cd 序号/名称 进入课程起始页。"""
    browser = ensure_browser(cfg)
    page = open_course_list(browser, cfg)
    ensure_login(browser, page.ws)
    courses = list_courses(page)
    if args.list_courses:
        if not courses:
            log("没有发现课程")
        else:
            log("课程列表：")
            for i, name in enumerate(courses, 1):
                log(f"  {i}. {name}")
        return
    if not courses:
        die("没有发现课程")
    name = choose_course(courses, args.target)
    target, course = select_course(browser, page, name)
    ensure_answers_file(cfg, course)
    if page.target.get("id") and page.target["id"] != target.get("id"):
        browser.close_target(page.target["id"])
    log(f"✓ 已进入课程：{course.name}（{course.code}）")
    log(f"  课程页：{course.classroom}")


def cmd_run(args, cfg: dict) -> None:
    browser = ensure_browser(cfg)
    course = current_course(browser, cfg)
    if course is None:
        die("没有当前课程：先 python3 答题.py cd -ls，再 python3 答题.py cd 序号/课程名")
    answers_path = course.answers or find_answers_file(cfg, course.code)
    if answers_path is None:
        die(f"课程「{course.name}」还没有答案档案：先 python3 答题.py cd {course.name}")
    cfg["run"]["answers"] = str(answers_path)
    chapters = load_answers(answers_path, missing_ok=True)
    if not chapters:
        die(f"课程「{course.name}」还没有章节骨架：先 python3 答题.py harvest")
    todo = resolve_chapter_args(chapters, args.chapter)
    if not todo:
        die("答案档案里找不到指定章节。")

    t0 = time.time()

    # 计划预览（原 check 命令并入：先看每关答案状态，再决定是否开跑）
    log("\n将按档案顺序处理：")
    print_archive_status(todo)
    if not args.yes:
        try:
            input("\n回车开始（Ctrl+C 取消）…")
        except (EOFError, KeyboardInterrupt):
            die("已取消。")

    classroom = classroom_page(browser, cfg, url=course.classroom)
    ensure_login(browser, classroom.ws)

    results = {}
    status_page = classroom     # 复用登录用的课堂页做状态检查标签，全程不重复开

    def run_one(ch) -> None:
        log(f"\n══ 章节：{ch.name} ══")
        if not ch.homework_id:
            die(f"章节「{ch.name}」缺少 homework_id，请先 harvest。")
        log("  → 检查平台状态…")
        rows = scrape_status(browser, status_page,
                             course.classroom + f"/{ch.homework_id}/detail?tabs=1",
                             expect=len(ch.levels))
        if not rows:
            log("  ! 详情页没有读到关卡列表，跳过本章")
            results[ch.name] = {"done": 0, "skipped": 0, "failed": 1}
            return
        if len(rows) != len(ch.levels):
            log(f"  ! 平台关卡数（{len(rows)}）与档案（{len(ch.levels)}）不一致，"
                "请先 harvest 补骨架；跳过本章")
            results[ch.name] = {"done": 0, "skipped": 0, "failed": 1}
            return
        if not _rows_match_levels(rows, ch):
            log("  ! 详情表关卡名与档案不一致（可能读到了上一章的旧表），跳过本章")
            results[ch.name] = {"done": 0, "skipped": 0, "failed": 1}
            return
        to_run = [lv for i, lv in enumerate(ch.levels, 1)
                  if not lv.skip and not is_passed_row(row_at(rows, i, lv.name))]
        if not to_run:
            log("  → 本章所有关卡都已通过或在档案里标了 skip，跳过")
            results[ch.name] = {"done": 0, "skipped": len(ch.levels), "failed": 0}
            return
        missing = [lv.name for lv in to_run if lv.answer_empty()]
        if missing:
            die(f"章节「{ch.name}」还有关卡没填答案：{'、'.join(missing)}\n"
                f"  请填写后重新运行：{cfg['run']['answers']}")
        # 只有真的要跑时，才开一个干净的课堂页去点「开始学习」
        entry_classroom = classroom_page(browser, cfg, url=course.classroom)
        t_ch = time.time()
        stats = {"done": 0, "skipped": 0, "failed": 0}
        results[ch.name] = stats      # 先就位：本章中途 die 时已作答数不丢
        try:
            ret = process_chapter(browser, entry_classroom, cfg, ch, rows,
                                  stats=stats)
        finally:
            if entry_classroom.target.get("id"):
                browser.close_target(entry_classroom.target["id"])
        if isinstance(ret, dict) and ret is not stats:
            stats.update(ret)          # 替身实现/旧式实现直接返回统计时并入
        stats["secs"] = time.time() - t_ch


    abort_code = 0
    for ch in todo:
        try:
            run_one(ch)
        except (SystemExit, RuntimeError, KeyboardInterrupt) as e:
            if isinstance(e, RuntimeError):
                log(f"  ! 章节中止：{e}")
            elif isinstance(e, KeyboardInterrupt):
                log("  ! 用户中断（Ctrl+C），先汇总已跑章节…")
            # die 的章节按失败 1 关+中止计入汇总；已就位的 stats 保留部分进度
            s = results.get(ch.name) or {"done": 0, "skipped": 0, "failed": 0}
            if not s.get("failed"):
                s["failed"] = 1
            s["aborted"] = True
            results[ch.name] = s
            abort_code = e.code if isinstance(e, SystemExit) and e.code else 2
            break

    log("\n══════ 汇总 ══════")
    for name, s in results.items():
        extra = f"（用时 {fmt_secs(s['secs'])}）" if s.get("secs") else ""
        log(f"  {name}：作答 {s['done']} 关，跳过 {s['skipped']} 关，失败 {s['failed']} 关{extra}")
    if abort_code:
        log(f"\n已中止（总用时 {fmt_secs(time.time() - t0)}）。浏览器保持打开，可自行检查。")
        sys.exit(abort_code)
    failed_chs = [n for n, s in results.items() if s.get("failed", 0) > 0]
    if failed_chs:
        # 软失败：整轮跑完但有章节没跑成，不能谎报完美收官
        log(f"\n完成（有 {len(failed_chs)} 章失败，总用时 {fmt_secs(time.time() - t0)}）。"
            "浏览器保持打开，可自行检查。")
        sys.exit(2)
    log(f"\n完成（总用时 {fmt_secs(time.time() - t0)}）。浏览器保持打开，可自行检查。")


def print_archive_status(chapters: list) -> None:
    """打印每章的关卡与答案状态（run 开跑前预览用；原 check 命令并入）。"""
    for ch in chapters:
        log(f"\n【{ch.name}】homework_id={ch.homework_id or '(缺)'}")
        for i, lv in enumerate(ch.levels, 1):
            kind = lv.type or "auto"
            if lv.skip:
                desc = "skip"
            elif lv.files:
                parts = [f"{f.get('path', '?').rsplit('/', 1)[-1]}"
                         f"{'✓' if str(f.get('answer') or '').strip() else ' 缺'}"
                         for f in lv.files]
                desc = f"{len(lv.files)} 个文件（{'，'.join(parts)}）"
            elif lv.answer_empty():
                desc = "缺答案"
            elif isinstance(lv.answer, list):
                desc = f"答案 {lv.answer}"
            else:
                text = str(lv.answer)
                desc = f"答案 {len(text)} 字符" if kind != "choice" and "\n" in text \
                    else f"答案 {text[:30]}"
            log(f"  {i:>2}. {lv.name:<32} [{kind:<4}] {desc}")
