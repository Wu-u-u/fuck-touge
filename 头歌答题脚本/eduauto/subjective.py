"""主观题作业（common_homework）：扫描题目、保存纯文本答案、提交作品。

主观题没有自动判分，也没有代码编辑器；提交页面是一个 CodeMirror
Markdown 输入框。本模块只做两件事：
  · harvest：把主观题列表/题目/附件名写进独立 sidecar 档案；
  · run：按 sidecar 里的纯文本 answer 填入输入框并点提交。

答案档案与客观题分开，避免污染 chapters 结构：
  answers/<课程名>-<课程码>-subjective.toml
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import tomllib

import cdp
from eduauto.browser import classroom_page, ensure_login
from eduauto.config import load_state, update_state
from eduauto.page import Page
from eduauto.util import die, log, norm

COMMON_BASE = "https://www.educoder.net/classrooms"


def sidecar_path(course) -> Path:
    if course.answers is None:
        die(f"课程「{course.name}」没有答案档案路径")
    return course.answers.with_name(course.answers.stem + "-subjective.toml")


def _toml_str(value: str) -> str:
    # TOML basic string; JSON 的转义规则与 TOML 基本字符串兼容。
    return json.dumps(str(value or ""), ensure_ascii=False)


@dataclass
class Subjective:
    name: str
    homework_id: str
    post_url: str
    prompt: str = ""
    answer: str = ""
    image: str = ""
    max_attempts: int = 3

    @classmethod
    def from_raw(cls, raw: dict):
        return cls(
            name=str(raw.get("name", "")).strip(),
            homework_id=str(raw.get("homework_id", "")).strip(),
            post_url=str(raw.get("post_url", "")).strip(),
            prompt=str(raw.get("prompt", "")),
            answer=str(raw.get("answer", "")),
            image=str(raw.get("image", "")),
            max_attempts=int(raw.get("max_attempts", 3) or 3),
        )


def load_subjective(path: Path) -> list[Subjective]:
    if not path.exists():
        return []
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except (tomllib.TOMLDecodeError, OSError) as e:
        die(f"主观题档案读取失败：{path}\n  {e}")
    raw = data.get("subjective", [])
    if not isinstance(raw, list):
        die(f"主观题档案格式错误：subjective 不是数组：{path}")
    return [Subjective.from_raw(x) for x in raw if isinstance(x, dict)]


def save_subjective(path: Path, entries: Iterable[Subjective]) -> None:
    lines = ["# 主观题作业答案与题目（纯文本，不使用 Markdown）", "version = 1", ""]
    for e in entries:
        lines += [
            "[[subjective]]",
            f"name = {_toml_str(e.name)}",
            f"homework_id = {_toml_str(e.homework_id)}",
            f"post_url = {_toml_str(e.post_url)}",
            f"prompt = {_toml_str(e.prompt)}",
            f"answer = {_toml_str(e.answer)}",
            f"image = {_toml_str(e.image)}",
            f"max_attempts = {int(e.max_attempts)}",
            "",
        ]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    tmp.replace(path)


def _attempts_key(course_code: str, homework_id: str) -> str:
    return f"{course_code}:{homework_id}"


def _attempts(course_code: str, homework_id: str) -> int:
    state = load_state()
    data = state.get("subjective_attempts", {})
    if not isinstance(data, dict):
        return 0
    try:
        return int(data.get(_attempts_key(course_code, homework_id), 0) or 0)
    except (TypeError, ValueError):
        return 0


def _remember_attempt(course_code: str, homework_id: str) -> int:
    n = _attempts(course_code, homework_id) + 1
    state = load_state()
    data = state.get("subjective_attempts", {})
    if not isinstance(data, dict):
        data = {}
    data[_attempts_key(course_code, homework_id)] = n
    update_state(subjective_attempts=data)
    return n


def _card_names(page: Page) -> list[str]:
    try:
        names = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('[class*="listContainer"]')].map(c => {
  const n = c.querySelector('[class*="name___"]');
  return n ? (n.innerText||'').trim() : '';
}).filter(Boolean))
""") or []
    except cdp.CDPError:
        return []
    out = []
    for n in names:
        n = str(n).strip()
        if n and n not in out:
            out.append(n)
    return out


def _click_card_action(page: Page, name: str) -> bool:
    expr = (
        "[...document.querySelectorAll('[class*=\"listContainer\"]')].find(c=>"
        f"((c.querySelector('[class*=\"name___\"]')||c).innerText||'').trim()==={json.dumps(name, ensure_ascii=False)}"
        ")?.querySelector('aside')"
    )
    return page.click_expr(expr)


def _wait_common_id(page: Page, timeout: float = 20) -> tuple[str, str] | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            url = str(page.ws.eval("location.href") or "")
        except cdp.CDPError:
            url = ""
        m = re.search(r"/common_homework/(\d+)(?:/(detail|post))?", url)
        if m:
            return m.group(1), url
        time.sleep(0.3)
    return None


def _prompt_and_image(page: Page) -> tuple[str, str]:
    d = {}
    for _ in range(50):
        try:
            d = page.ws.eval_json(r"""
JSON.stringify((function(){
  const body = document.body ? document.body.innerText : '';
  const md = document.querySelector('[class*="mdBody"]');
  let prompt = md ? (md.innerText||'').trim() : '';
  if (!prompt || prompt === '暂无～') {
    const a = body.indexOf('作业描述');
    const b = body.indexOf('内容:');
    if (a >= 0 && b > a) prompt = body.slice(a + 4, b).trim();
  }
  const im = body.match(/微信图片[^\n]*/);
  return {prompt, image: im ? im[0].trim() : '',
          loaded: body.includes('上传附件') || body.includes('微信图片')};
})())
""") or {}
        except cdp.CDPError:
            d = {}
        if d.get("loaded") and d.get("prompt") not in ("", "暂无～"):
            break
        time.sleep(0.3)
    return str(d.get("prompt", "")), str(d.get("image", ""))


def harvest_subjective(browser, cfg: dict, course) -> Path:
    """扫描 common_homework 列表，补主观题骨架；答案为空，不覆盖已有答案。"""
    path = sidecar_path(course)
    old = load_subjective(path)
    by_name = {norm(e.name): e for e in old}
    common = f"{COMMON_BASE}/{course.code}/common_homework"
    page = classroom_page(browser, cfg, url=common)
    try:
        ensure_login(browser, page.ws)
        names = []
        for _ in range(40):
            names = _card_names(page)
            if names:
                break
            time.sleep(0.5)
        if not names:
            log("  ! 主观题作业列表没有读到卡片，跳过")
            return path
        log(f"  主观题作业：{len(names)} 个")
        for name in names:
            if norm(name) in by_name:
                log(f"    · 已存在：{name}")
                continue
            before = {t["id"] for t in browser.pages()}
            if not _click_card_action(page, name):
                log(f"    ! 找不到「{name}」的提交作品入口")
                continue
            detail_target = None
            for _ in range(40):
                time.sleep(0.3)
                for t in browser.pages():
                    u = t.get("url") or ""
                    if t["id"] not in before and "/common_homework/" in u:
                        detail_target = t
                        break
                if detail_target:
                    break
            if detail_target is None:
                # 兜底：少数情况下当前页直接跳转
                got = _wait_common_id(page)
                if not got:
                    log(f"    ! 点击「{name}」后没有拿到作业 ID")
                    continue
                hid = got[0]
                detail_ws = page.ws
                detail_page = page
            else:
                detail_ws = browser.attach(detail_target)
                detail_page = Page(detail_ws, detail_target)
                got = _wait_common_id(detail_page)
                if not got:
                    log(f"    ! 点击「{name}」后没有拿到作业 ID")
                    browser.close_target(detail_target["id"])
                    continue
                hid = got[0]
            post = f"{COMMON_BASE}/{course.code}/common_homework/{hid}/post"
            # 从 detail 导航到 post 取题目。
            prompt, image = "", ""
            try:
                detail_ws.call("Page.navigate", {"url": post})
                detail_ws.wait_for("document.readyState !== 'loading'", timeout=40)
                prompt, image = _prompt_and_image(detail_page)
            except cdp.CDPError:
                pass
            e = Subjective(name=name, homework_id=hid, post_url=post,
                           prompt=prompt, image=image)
            old.append(e)
            by_name[norm(name)] = e
            log(f"    ✓ {name}（{hid}）")
            if detail_target is not None:
                try:
                    detail_ws.close()
                except Exception:
                    pass
                browser.close_target(detail_target["id"])
        save_subjective(path, old)
        log(f"  ✓ 主观题骨架：{path}")
        return path
    finally:
        try:
            page.ws.close()
        except Exception:
            pass


def _fill_editor(page: Page, text: str) -> bool:
    # 编辑器默认可能是预览态；点「编辑」再写 CodeMirror。
    try:
        page.click_expr("[...document.querySelectorAll('button')].find(e=>(e.innerText||'').trim()==='编辑')")
    except Exception:
        pass
    time.sleep(0.3)
    try:
        got = page.ws.eval(
            "(function(text){const el=document.querySelector('.CodeMirror');"
            "const cm=el&&el.CodeMirror;if(!cm)return '';cm.setValue(text);"
            "if(cm.save)cm.save();return cm.getValue();})(" + json.dumps(text, ensure_ascii=False) + ")"
        )
        return str(got) == text
    except cdp.CDPError:
        return False


def run_subjective(browser, cfg: dict, course, names: list[str] | None = None) -> int:
    path = sidecar_path(course)
    entries = load_subjective(path)
    if not entries:
        log("  没有主观题档案；先运行 subjective harvest")
        return 0
    wanted = {norm(x) for x in (names or [])}
    if wanted:
        entries = [e for e in entries
                   if any(w in norm(e.name) or norm(e.name) in w for w in wanted)]
    if not entries:
        log("  没有匹配的主观题")
        return 0
    failed = 0
    for e in entries:
        if not e.answer.strip():
            log(f"  · {e.name}：答案为空，跳过")
            continue
        used = _attempts(course.code, e.homework_id)
        if used >= e.max_attempts:
            log(f"  · {e.name}：已达到最大提交次数 {e.max_attempts}，跳过")
            continue
        log(f"\n══ 主观题：{e.name} ══")
        page = classroom_page(browser, cfg, url=e.post_url)
        try:
            ensure_login(browser, page.ws)
            if not _fill_editor(page, e.answer):
                log("  ! 没找到内容编辑器，跳过")
                failed += 1
                continue
            # 编辑器底部常被 iframe 覆盖，真实鼠标点击会打空；
            # 这里直接对「提交」按钮做 DOM click，再处理确认弹层。
            clicked = page.ws.eval(
                "(function(){const el=[...document.querySelectorAll('button')]"
                ".find(e=>(e.innerText||'').trim()==='提交');"
                "if(!el)return false;el.click();return true;})()"
            )
            if not clicked:
                log("  ! 没找到提交按钮")
                failed += 1
                continue
            # 二次确认按钮文字是「确 定」（中间有空格）。
            confirmed = False
            success = False
            deadline = time.time() + 25
            while time.time() < deadline:
                time.sleep(0.3)
                url = str(page.ws.eval("location.href") or "")
                body = str(page.ws.eval("document.body.innerText") or "")
                if "/review/" in url or "按时提交" in body or "提交成功" in body:
                    success = True
                    break
                if not confirmed and page.ws.eval(
                    "(function(){const el=[...document.querySelectorAll('button')]"
                    ".find(e=>/^(确\\s*定|确认|继续提交)$/.test((e.innerText||'').trim()));"
                    "if(!el)return false;el.click();return true;})()"
                ):
                    confirmed = True
                    # 点击确认后继续等跳转，不要立刻判定失败。
            if success:
                n = _remember_attempt(course.code, e.homework_id)
                log(f"  ✓ 已提交（{n}/{e.max_attempts}）")
            else:
                log("  ! 未确认提交成功（可能被校验拦下），请检查页面")
                failed += 1
        except (cdp.CDPError, RuntimeError) as exc:
            log(f"  ! 提交失败：{exc}")
            failed += 1
        finally:
            try:
                page.ws.close()
            except Exception:
                pass
            if page.target.get("id"):
                browser.close_target(page.target["id"])
    return 2 if failed else 0
