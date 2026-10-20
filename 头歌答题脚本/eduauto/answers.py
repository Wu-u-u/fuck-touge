"""评测结果等待与已保存答案读取（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

import json
import time

import cdp
from eduauto.page import Page, probe_state
from eduauto.code import close_file_menu, list_code_files, read_saved_files

TOAST_NEXT = "已为您自动跳转至下一关"


TOAST_LAST = "已经是最后一关了"


FAIL_TEXT = "评测未通过"


def wait_outcome(page: Page, ctx: dict, timeout: float) -> dict:
    """评测后等待结果。

    返回 {'kind': 'next'|'last'|'fail'|'timeout', 'detail': ...}

    判定原则（实测总结）：
    · 「关卡变化」是最硬的信号，优先信；
    · 「已经是最后一关了」提示（探针按元素去重）直接判定 last；
    · 「已为您自动跳转至下一关」只当作"通过"提示，必须再等到关卡变化才算 next，
      否则会被上一关残留的提示语骗（真实踩坑）；
    · 庆祝弹层仍活着 → 按按钮文案判定，并兜底帮扩展点掉；
    · 出现新的「评测未通过」消息 → fail。
    """
    deadline = time.time() + timeout
    popup_seen_at = 0.0
    fail_seen_at = 0.0
    next_hint_at = 0.0
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            st = page.state()
        except cdp.CDPError:
            continue
        pr = probe_state(page.ws)
        toast_text = " ".join(list(pr.get("toasts", [])))
        if TOAST_LAST in toast_text:
            return {"kind": "last", "detail": TOAST_LAST}
        if TOAST_NEXT in toast_text and not next_hint_at:
            next_hint_at = time.time()
        if st.get("popup"):
            btns = st.get("popupBtns", [])
            kind = "last" if any(b in ("最后一关", "完成") for b in btns) else "next"
            if not popup_seen_at:
                popup_seen_at = time.time()
            # 扩展不在时，弹层会一直留着：1.5 秒后由我们点掉
            if time.time() - popup_seen_at > 1.5:
                page.click_expr(
                    "[...document.querySelectorAll('.evaluate-result-container')]"
                    " .flatMap(b=>[...b.querySelectorAll('a,button,[role=button]')])"
                    ".find(el=>/下一关|最后一关|完成/.test((el.innerText||'').trim()))"
                )
                return {"kind": kind, "detail": "self-clicked:" + ",".join(btns)}
            continue
        if st.get("failMsgs", 0) > ctx.get("fail0", 0):
            if not fail_seen_at:
                fail_seen_at = time.time()
            # 未通过不会再出庆祝弹层；给 1.2 秒宽限防止消息早于弹层
            if time.time() - fail_seen_at > 1.2 and not st.get("popup"):
                return {"kind": "fail", "detail": FAIL_TEXT}
        if st.get("index") and st.get("index") != ctx.get("index0"):
            return {"kind": "next", "detail": "关卡已跳转"}
        if st.get("url") != ctx.get("url0"):
            if ctx.get("is_last"):
                return {"kind": "last", "detail": "最后一关已结束"}
            return {"kind": "next", "detail": "页面已跳转"}
        if pr.get("popups", 0) > 0 and ctx.get("is_last"):
            # 最后一关：弹层已被扩展点掉、却没等到「最后一关」提示（理论少见）
            return {"kind": "last", "detail": "弹层已被扩展点掉（最后一关）"}
        if next_hint_at and time.time() - next_hint_at > 12:
            # 有"已跳转"提示却迟迟没有关卡变化：交给外层用工具栏兜底
            return {"kind": "next", "detail": "提示已跳转但未检测到关卡变化"}
    return {"kind": "timeout", "detail": "等待评测结果超时"}


def read_editor_code(page: Page, timeout: float = 8, need_stable: int = 3) -> str | None:
    """直接读编辑器里的代码（多 model 时取创建最早的 = 主编辑器）。

    平台会先塞占位/模板代码、稍后才加载真实代码，所以等内容稳定后才返回。
    """
    last, stable = None, 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cur = page.ws.eval(
                "(window.Monaco && window.Monaco.editor.getModels().length)"
                " ? window.Monaco.editor.getModels()[0].getValue() : null"
            )
        except cdp.CDPError:
            cur = None
        if isinstance(cur, str) and cur.strip() and cur == last:
            stable += 1
            if stable >= need_stable:
                return cur
        else:
            stable = 0
        last = cur
        time.sleep(0.5)
    return last if isinstance(last, str) and last.strip() else None


def close_code_modal(page: Page, timeout: float = 6) -> None:
    """关闭「代码详情」弹窗并确认已关（X → ESC → 按钮，逐级兜底）。

    弹窗遮罩会吞掉后续所有真实鼠标点击；关不掉必须抛错停下，
    否则会出现"评测读的弹窗挡着 → 无法跳关 → 反复重读"的慢速死循环。
    """
    def visible() -> bool:
        try:
            return bool(page.ws.eval(
                "[...document.querySelectorAll('.ant-modal')].some(m=>{const r=m.getBoundingClientRect();"
                "return r.width>0||r.height>0;})"
            ))
        except cdp.CDPError:
            return False

    def click_visible(expr: str) -> bool:
        try:
            pos = page.ws.eval_json(
                "JSON.stringify((function(){const el=(" + expr + "); if(!el) return null;"
                "const r=el.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return null;"
                "return {x:r.x+r.width/2,y:r.y+r.height/2};})())"
            )
            if not pos:
                return False
            page.ws.mouse_click(pos["x"], pos["y"])
            return True
        except cdp.CDPError:
            return False

    if not visible():
        return
    time.sleep(0.5)                                  # 等开启动画结束，坐标才稳定
    click_visible("document.querySelector('.ant-modal .ant-modal-close')")
    for _ in range(5):                               # 1) X 按钮
        time.sleep(0.4)
        if not visible():
            return
    try:                                             # 2) ESC 兜底
        for typ in ("keyDown", "keyUp"):
            page.ws.call("Input.dispatchKeyEvent", {
                "type": typ, "key": "Escape", "code": "Escape",
                "windowsVirtualKeyCode": 27, "nativeVirtualKeyCode": 27,
            })
    except cdp.CDPError:
        pass
    for _ in range(5):
        time.sleep(0.4)
        if not visible():
            return
    click_visible("(function(){const m=[...document.querySelectorAll('.ant-modal')]"
                  ".find(m=>{const r=m.getBoundingClientRect(); return r.width>0||r.height>0;});"
                  "if(!m) return null; return [...m.querySelectorAll('button,[role=button]')]"
                  ".find(e=>/^(知道了|关闭|确定|OK)$/.test((e.innerText||'').trim()));})()")
    for _ in range(5):                               # 3) 「知道了」等按钮
        time.sleep(0.4)
        if not visible():
            return
    raise RuntimeError("「代码详情」弹窗无法关闭，已停止（遮罩会吞掉后续点击）")


def read_submitted_code(page: Page, timeout: float = 15) -> str | None:
    """从『记录』里最近一次"评测通过"的提交中读取当时提交的代码。

    比编辑器更可靠：有些关卡平台不回显已提交代码（编辑器只剩模板，实测五章第 5 关）。
    原理：点开「查看代码」后平台会新建一个 Monaco model，直接读那个 model 的完整内容，
    避免抓带行号和 &nbsp; 的展示文本。
    """
    def click_expr(expr: str) -> bool:
        pos = page.ws.eval_json(
            "JSON.stringify((function(){const el=(" + expr + "); if(!el) return null;"
            "const r=el.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return null;"
            "return {x:r.x+r.width/2,y:r.y+r.height/2};})())"
        )
        if not pos:
            return False
        page.ws.mouse_click(pos["x"], pos["y"])
        return True

    try:
        before = set(page.ws.eval_json(
            "JSON.stringify(window.Monaco.editor.getModels().map(m=>m.uri.toString()))"
        ) or [])
        # 1) 切到「记录」页签
        if not click_expr(
            "[...document.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='记录')"
        ):
            return None
        page.ws.wait_for("!!document.querySelector('.ant-table-row')", timeout=timeout)
        # 2) 点最近一次"评测通过"那一行的「查看代码」
        if not click_expr(
            "(function(){const rows=[...document.querySelectorAll('.ant-table-row')];"
            "const row=rows.find(r=>(r.innerText||'').includes('评测通过'));"
            "if(!row) return null;"
            "return [...row.querySelectorAll('*')].find(e=>(e.innerText||'').trim()==='查看代码');})()"
        ):
            return None
        # 3) 等新 model 出现并读取
        code = None
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.4)
            models = page.ws.eval_json(
                "JSON.stringify(window.Monaco.editor.getModels().map(m=>({uri:m.uri.toString(), value:m.getValue()})))"
            ) or []
            new = [m for m in models if m["uri"] not in before]
            if new:
                code = new[-1]["value"]
                break
        return code or None
    finally:
        # 4) 关掉弹窗（无论成功失败；关不掉会抛错，避免遮罩悄悄吞掉后续点击）
        close_code_modal(page)


_TEMPLATE_MARKERS = (
    "请在此", "在此填写", "在此处填写", "实现代码", "填写代码",
    "your code here", "your code goes here", "write your code",
    "# todo", "// todo", "/* todo",
)


def looks_like_template(code: str) -> bool:
    """判断编辑器内容是否更像平台模板/占位，而不是用户答案。

    保守策略：至少命中 1 个标记；若只命中 1 个且文本较长（>=400 字符），
    视为正常代码里的注释，避免误伤。空内容也算模板。
    """
    text = str(code or "")
    if not text.strip():
        return True
    low = text.lower()
    hits = sum(1 for marker in _TEMPLATE_MARKERS if marker in low)
    return hits >= 1 and (hits >= 2 or len(text) < 400)


def read_saved_answer(page: Page, st: dict) -> tuple[str | None, str | None, str]:
    """读取当前关卡服务器上已保存的答案。

    返回 (kind, value, note)：kind = 'code'（完整代码）或 'choice'（每题字母列表）；
    读不到则 kind=None。
    """
    if st.get("hasEditor"):
        paths, _ = list_code_files(page)          # 单文件关卡也会有 1 项
        if len(paths) > 1:
            return read_saved_files(page, paths)  # 多文件：逐个点开读
        close_file_menu(page)
        code = read_editor_code(page)             # 首选：直接读编辑器（默认就是对的）
        src = "编辑器"
        if not code or not code.strip() or looks_like_template(code):
            if st.get("models", 0) != 1:
                if not code or not code.strip():
                    return None, None, f"编辑器没读到内容，且有 {st.get('models')} 个 model"
                return None, None, "编辑器内容像模板，且无法读取评测记录"
            rec = read_submitted_code(page)       # 回退：评测记录里的提交代码
            if rec and rec.strip() and not looks_like_template(rec):
                code, src = rec, "评测记录（编辑器像模板）"
            elif not code or not code.strip():
                return None, None, "编辑器是空的，记录里也没读到"
            else:
                return None, None, "编辑器内容像模板，评测记录也没读到"
        if not code or not code.strip():
            return None, None, "编辑器是空的，记录里也没读到"
        return "code", code, f"{len(code)} 字符（{src}）"
    if st.get("choiceCount", 0) > 0:
        # 等服务器保存的选项回显
        for _ in range(12):
            groups = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.option')].map(g => {
  const ins = [...g.querySelectorAll('input')];
  const checked = [];
  ins.forEach((inp, i) => { if (inp.checked) checked.push(String.fromCharCode(65 + i)); });
  return checked;
}))
""")
            if groups and any(groups):
                return "choice", groups, json.dumps(groups, ensure_ascii=False)
            time.sleep(0.5)
        return None, None, "没有已保存的选项"
    return None, None, "未知题型"


def _clean_code(text: str) -> str:
    """统一换行并拒绝 TOML 字面量不允许的控制字符。"""
    text = str(text).replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    bad = sorted({ch for ch in text if ord(ch) < 32 and ch not in "\n\t"})
    if bad:
        raise RuntimeError(f"代码里含有 TOML 不允许的控制字符：{bad!r}，请手动清理后重试")
    return text


def answer_to_toml(kind: str, value) -> str:
    """把采集到的答案转成 TOML 里的 answer 行（多文件则是 files 子块）。"""
    if kind == "files":
        blocks = []
        for path, code in value:
            text = _clean_code(code)
            if "'''" in text:
                raise RuntimeError(
                    f"文件 {path} 的代码里含有三个单引号，无法用字面量字符串写入，请手动粘贴")
            blocks.append(
                "[[chapters.levels.files]]\n"
                f"path = {json.dumps(path, ensure_ascii=False)}\n"
                "answer = '''\n" + text + "\n'''"
            )
        return "\n".join(blocks)
    if kind == "choice":
        return "answer = " + json.dumps(value, ensure_ascii=False)
    text = _clean_code(value)
    if "'''" in text:
        raise RuntimeError("代码里含有三个单引号，无法用字面量字符串写入，请手动粘贴")
    return "answer = '''\n" + text + "\n'''"
