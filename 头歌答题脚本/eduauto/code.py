"""多代码文件、编辑器读写与选择题作答（v0.9.13 从答题.py 抽出）。"""

from __future__ import annotations

import json
import re
import time

import cdp
from eduauto.page import Page
from eduauto.util import log

MODEL_NUM_RE = re.compile(r"model/(\d+)")


FILE_ITEMS_JS = r"""
JSON.stringify([...document.querySelectorAll('.ant-dropdown-menu-item')].map(e => {
  const r = e.getBoundingClientRect();
  return {path: (e.innerText||'').trim(), visible: r.width > 2 && r.height > 2,
          x: r.x + r.width/2, y: r.y + r.height/2};
}).filter(x => x.path))
"""


FILE_TRIGGER_JS = r"""
JSON.stringify((function(){
  const s = [...document.querySelectorAll('span')]
      .find(x => (x.textContent||'').trim() === '代码文件');
  const t = s && s.parentElement.querySelector('.ant-dropdown-trigger');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return null;
  return {x: r.x + r.width/2, y: r.y + r.height/2};
})())
"""


FILE_ACTIVE_JS = r"""
JSON.stringify((function(){
  const el = document.querySelector('[class*="pathActive"]');
  return el ? (el.innerText||'').trim() : null;
})())
"""


FILE_HIT_JS = r"""
JSON.stringify((function(){
  const e = document.elementFromPoint(%s, %s);
  if (!e) return null;
  const it = e.closest('.ant-dropdown-menu-item');
  return it ? (it.innerText||'').trim() : null;
})())
"""


def _file_items(page: Page) -> list[dict]:
    return page.ws.eval_json(FILE_ITEMS_JS) or []


def ensure_file_menu(page: Page, timeout: float = 5) -> list[dict]:
    """确保「代码文件」下拉已展开，返回菜单项（含 visible 标记与坐标）。

    下拉是懒渲染（没打开过时 DOM 里没有菜单项）且 **hover 触发**：
    实测后台标签页（visibilityState=hidden）既不响应 hover 也不展开下拉，
    所以这里先把隐藏标签页切到前台，再用 mouseMoved 悬停展开；悬停没反应才补一次点击。
    撑不开或没有该下拉则返回现有项（可能为空）。
    """
    items = _file_items(page)
    if any(it.get("visible") for it in items):
        return items
    try:
        if page.ws.eval("document.visibilityState") != "visible":
            page.ws.call("Page.bringToFront")
            time.sleep(0.3)
    except cdp.CDPError:
        pass
    deadline = time.time() + timeout
    clicked = False
    while time.time() < deadline:
        pos = page.ws.eval_json(FILE_TRIGGER_JS)
        if not pos:
            time.sleep(0.25)
            continue
        # 虚拟鼠标若已停在触发器上，再发 mouseMoved 不会产生 mouseenter
        # （Chrome 对同坐标去重），下拉不会展开 —— 先移到中性点再悬停。
        page.ws.mouse_move(20, 400)
        time.sleep(0.1)
        page.ws.mouse_move(pos["x"], pos["y"])       # hover 展开
        for _ in range(4):
            time.sleep(0.15)
            items = _file_items(page)
            if any(it.get("visible") for it in items):
                return items
        if not clicked:                              # 悬停无效时补一次点击
            page.ws.mouse_click(pos["x"], pos["y"])
            clicked = True
    return items


def close_file_menu(page: Page) -> None:
    """把「代码文件」下拉收起来（hover 触发，鼠标移开就会收）。"""
    for _ in range(3):
        items = _file_items(page)
        if not any(it.get("visible") for it in items):
            return
        page.ws.mouse_move(20, 400)                  # 移开鼠标
        time.sleep(0.3)
        items = _file_items(page)
        if not any(it.get("visible") for it in items):
            return
        pos = page.ws.eval_json(FILE_TRIGGER_JS)     # 兜底：点一下触发器
        if not pos:
            return
        page.ws.mouse_click(pos["x"], pos["y"])
        time.sleep(0.3)


def list_code_files(page: Page) -> tuple[list[str], str]:
    """返回（本关代码文件路径列表, 当前显示的文件）。没有「代码文件」下拉则 ([], "")。

    单文件关卡也有这个下拉（只有 1 项），所以可以用它判断是否多文件关卡。
    """
    items = ensure_file_menu(page)
    vis = [it for it in items if it.get("visible")]
    if not items and page.ws.eval_json(FILE_TRIGGER_JS):
        log("    ！「代码文件」下拉没能展开，暂按单文件处理"
            "（页面不在前台时可能发生）")
    paths = [it["path"] for it in (vis or items)]
    active = page.ws.eval_json(FILE_ACTIVE_JS) or ""
    return paths, active


def _same_path(a: str, b: str) -> bool:
    a = (a or "").strip().replace("\\", "/")
    b = (b or "").strip().replace("\\", "/")
    if not a or not b:
        return False
    return a == b or a.rsplit("/", 1)[-1] == b.rsplit("/", 1)[-1]


def _find_item(items: list[dict], want: str) -> dict | None:
    want = (want or "").strip().replace("\\", "/")
    if not want:
        return None
    for it in items:
        if it["path"].replace("\\", "/") == want:
            return it
    base = want.rsplit("/", 1)[-1]
    cands = [it for it in items
             if it["path"].replace("\\", "/").rsplit("/", 1)[-1] == base]
    return cands[0] if len(cands) == 1 else None


def _model_uris(page: Page) -> list[str]:
    return page.ws.eval_json(
        "JSON.stringify(window.Monaco.editor.getModels().map(m => m.uri.toString()))"
    ) or []


def _newest_uri(uris: list[str]) -> str | None:
    if not uris:
        return None

    def num(u: str) -> int:
        m = MODEL_NUM_RE.search(u)
        return int(m.group(1)) if m else -1
    return max(uris, key=num)


def click_code_file(page: Page, path: str, timeout: float = 5) -> str | None:
    """展开下拉、真实点击某个文件项，返回该文件对应的 model uri。

    点已激活的文件不会新建 model（正常），此时返回最新的 model；
    点不动（既没新 model、激活标记也没变）会重试，最终失败返回 None。
    """
    for _ in range(3):
        before = set(_model_uris(page))
        items = ensure_file_menu(page)
        vis = [it for it in items if it.get("visible")]
        it = _find_item(vis, path)
        if it is None:
            if vis and _find_item(items, path) is None:
                return None                 # 下拉里确实没有这个文件
            time.sleep(0.5)                 # 菜单没撑开或目标还藏着，重试
            continue
        # 下拉有展开动画：等目标项坐标连续两次一致再点，防止点到滑动中的位置。
        # 注意 menu 可能中途自己收起（平台 re-render），一旦目标消失就重来，
        # 绝不使用上一次抓到的陈旧坐标去点（会点穿到编辑器上）。
        fresh = None
        pos_prev = None
        for _ in range(8):
            cur = _find_item([x for x in _file_items(page) if x.get("visible")], path)
            if cur is None:
                break
            if pos_prev is not None and abs(cur["x"] - pos_prev[0]) < 1.5 \
                    and abs(cur["y"] - pos_prev[1]) < 1.5:
                fresh = cur
                break
            pos_prev = (cur["x"], cur["y"])
            fresh = cur
            time.sleep(0.12)
        if fresh is None:
            time.sleep(0.3)                 # 菜单收了，下一轮重新 ensure
            continue
        # 点击前最后确认：该坐标下确实还是这个菜单项
        hit = page.ws.eval_json(FILE_HIT_JS % (fresh["x"], fresh["y"]))
        if hit is None or not _same_path(hit, path):
            time.sleep(0.3)
            continue
        page.ws.mouse_click(fresh["x"], fresh["y"])      # 必须真实点击
        deadline = time.time() + timeout
        while time.time() < deadline:
            new = [u for u in _model_uris(page) if u not in before]
            if new:
                return _newest_uri(new)
            time.sleep(0.25)
        active = page.ws.eval_json(FILE_ACTIVE_JS) or ""
        if _same_path(active, path):
            return _newest_uri(_model_uris(page))
        time.sleep(0.5)
    return None


def wait_uri_settled(page: Page, uri: str, timeout: float = 8,
                     need_stable: int = 2) -> str | None:
    """等某个 model 的内容稳定（刚点开的文件可能还在从平台状态载入）。"""
    last, stable = None, 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cur = page.ws.eval_json(
                "JSON.stringify((function(){const ms=window.Monaco.editor.getModels()"
                f".filter(m=>m.uri.toString()==={json.dumps(uri)});"
                "return ms.length ? ms[0].getValue() : null;})())"
            )
        except cdp.CDPError:
            cur = None
        if isinstance(cur, str) and cur == last:
            stable += 1
            if stable >= need_stable:
                return cur
        else:
            stable = 0
        last = cur
        time.sleep(0.4)
    return last


def write_uri_code(page: Page, uri: str, code: str) -> int:
    """对指定 model 做整文件覆盖写入，写完回读校验（不一致重试一次）。"""
    def write_and_read() -> tuple[bool, int]:
        expr = (
            "(function(){const ms=window.Monaco.editor.getModels()"
            f".filter(m=>m.uri.toString()==={json.dumps(uri)});"
            "if(!ms.length) return JSON.stringify({ok:false});"
            f"ms[0].setValue({json.dumps(code)});"
            "const got=ms[0].getValue();"
            "return JSON.stringify({ok: got === " + json.dumps(code) + ", len: got.length});})()"
        )
        r = page.ws.eval_json(expr) or {}
        return bool(r.get("ok")), int(r.get("len") or 0)

    ok, n = write_and_read()
    if not ok:
        time.sleep(0.5)
        ok, n = write_and_read()
    if not ok:
        raise RuntimeError("代码写入后回读校验不一致，已停止（防止只写进去一部分）")
    return n


def read_saved_files(page: Page, paths: list[str]) -> tuple[str | None, object, str]:
    """多文件关卡：逐个点开文件，从新 model 读代码。"""
    out, notes = [], []
    for path in paths:
        uri = click_code_file(page, path)
        if not uri:
            return None, None, f"点开文件「{path}」失败（下拉菜单里没反应）"
        code = wait_uri_settled(page, uri)
        if not isinstance(code, str) or not code.strip():
            return None, None, f"文件「{path}」读不到内容"
        out.append((path, code))
        notes.append(f"{path}（{len(code)} 字符）")
    return "files", out, "；".join(notes)


def write_files(page: Page, live_paths: list[str], entries: list[dict]) -> None:
    """多文件关卡：逐文件真实点击切换 + 整文件覆盖，最后同步并核对。

    entries 来自答案档案：[{"path": ..., "answer": ...}, ...]。
    写入后把每个文件再点一遍：既让平台把自己的状态同步完整，也顺便核对
    新点开的 model 内容确实等于档案答案（不等就补写一次）。
    """
    plan = []
    for live in live_paths:
        ent = next((e for e in entries if _same_path(str(e.get("path") or ""), live)), None)
        if ent is None:
            raise RuntimeError(f"档案里没有文件「{live}」的条目，请先 harvest 或手动补全")
        code = str(ent.get("answer") or "")
        if not code.strip():
            raise RuntimeError(f"档案里文件「{ent.get('path') or live}」的答案是空的")
        plan.append((live, code))
    extra = [str(e.get("path")) for e in entries
             if not any(_same_path(str(e.get("path") or ""), p) for p in live_paths)]
    if extra:
        raise RuntimeError("档案里的这些文件在本关不存在：" + "；".join(extra)
                           + "（可用 harvest 重新采集）")

    for path, code in plan:
        uri = click_code_file(page, path)
        if not uri:
            raise RuntimeError(f"点开文件「{path}」失败（下拉菜单里没反应）")
        wait_uri_settled(page, uri, timeout=6)    # 先等平台内容载入，防止写后被覆盖
        n = write_uri_code(page, uri, code)
        log(f"    已写入 {path}（{n} 字符）")
        time.sleep(0.3)                           # 让平台先消化这次修改再切文件

    for path, code in plan:
        uri = click_code_file(page, path)
        if not uri:
            raise RuntimeError(f"同步核对时点开文件「{path}」失败")
        got = wait_uri_settled(page, uri, timeout=6)
        if (got or "").strip("\n") != code.strip("\n"):
            uri = click_code_file(page, path)     # 补救一次
            if not uri:
                raise RuntimeError(f"文件「{path}」回读不一致后重写失败")
            write_uri_code(page, uri, code)
            got = wait_uri_settled(page, uri, timeout=6) or ""
            if got.strip("\n") != code.strip("\n"):
                raise RuntimeError(f"文件「{path}」写入后回读不一致，已停止")
        log(f"    ✓ 核对 {path}：平台状态与档案一致（{len(got)} 字符）")


def wait_model_settled(page: Page, timeout: float = 10, need_stable: int = 3) -> str | None:
    """等 Monaco 编辑器内容稳定下来再读写。

    平台打开关卡时会先塞一段示例/占位代码，稍后才加载服务器上的真实代码；
    读太早会采到占位代码（真实踩坑：五章第 5 关采成了 public class Demo），
    写太早则可能被随后加载的真实代码覆盖掉。
    """
    last, stable = None, 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            cur = page.ws.eval(
                "(window.Monaco && window.Monaco.editor.getModels().length === 1)"
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
    return last if isinstance(last, str) else None


def set_code(page: Page, code: str) -> None:
    """把完整代码整体覆盖进 Monaco（等效一次性全选粘贴）。

    说明：这里用的是 model.setValue()，**整文件覆盖**而不是只改 Begin-End 中间那段；
    写入前等编辑器内容稳定，写完立刻回读校验，确保写入内容和档案完全一致
    （不一致就重试一次，仍不行则报错暂停）。
    """
    wait_model_settled(page, timeout=8)      # 防止平台随后加载的真实代码覆盖我们

    def write_and_read() -> tuple[bool, int]:
        expr = (
            "(function(){const ms=window.Monaco.editor.getModels();"
            "if(!ms.length) return JSON.stringify({ok:false});"
            f"ms[0].setValue({json.dumps(code)});"
            "const got = ms[0].getValue();"
            "return JSON.stringify({ok: got === "
            f"{json.dumps(code)}"
            ", len: got.length});})()"
        )
        r = page.ws.eval_json(expr) or {}
        return bool(r.get("ok")), int(r.get("len") or 0)

    ok, n = write_and_read()
    if not ok:
        time.sleep(0.5)
        ok, n = write_and_read()          # 偶尔遇到编辑器重载，重试一次
    if not ok:
        raise RuntimeError("代码写入后回读校验不一致，已停止（防止只写进去一部分）")
    log(f"    已整文件覆盖写入并校验通过（{n} 字符）")


def answer_choice(page: Page, items: list) -> None:
    """选择题：按题号顺序点选选项。

    items 每题一项：可以是 'A'，也可以是 ['A','B','D']（多选题）。
    关键：页面会回显历史勾选，而 checkbox 点击是"切换"，所以必须
    先清掉不在答案里的已勾选项，再补勾缺少的（radio 点目标即切换，无需清）。
    """
    norm_items = []
    for it in items:
        if isinstance(it, list):
            norm_items.append([str(x).strip().upper()[:1] for x in it])
        else:
            norm_items.append([str(it).strip().upper()[:1]])
    payload = json.dumps(norm_items)

    def apply_and_check() -> tuple[list, list]:
        result = page.ws.eval_json(
            "(function(ls){"
            "const groups=[...document.querySelectorAll('.option')];"
            "const out=[];"
            "groups.forEach((g,gi)=>{"
            "  const letters=ls[gi]; if(!letters) return;"
            "  const inputs=[...g.querySelectorAll('input')];"
            "  const want=new Set(letters.map(L=>L.charCodeAt(0)-65));"
            "  const isRadio=inputs.length>0 && inputs[0].type==='radio';"
            "  if(!isRadio){"
            "    inputs.forEach((inp,i)=>{ if(inp.checked && !want.has(i)) (inp.closest('label')||inp).click(); });"
            "  }"
            "  want.forEach(i=>{"
            "    const inp=inputs[i];"
            "    if(inp && !inp.checked) (inp.closest('label')||inp).click();"
            "  });"
            "  out.push({q:gi+1, letters:letters});"
            "});"
            "return JSON.stringify(out);"
            f"}})({payload})"
        ) or []
        time.sleep(0.5)
        checked = page.ws.eval_json(r"""
JSON.stringify([...document.querySelectorAll('.option')].map(g =>
  [...g.querySelectorAll('input')].map((inp,i)=>inp.checked?i:-1).filter(i=>i>=0)))
""") or []
        return result, checked

    result, checked = apply_and_check()
    # 校验：每题勾选集合必须与答案完全一致；不一致再重试一次
    def bad() -> bool:
        for gi, letters in enumerate(norm_items):
            want = sorted(ord(L) - 65 for L in letters)
            got = sorted(checked[gi]) if gi < len(checked) else []
            if want != got:
                return True
        return False

    if bad():
        result, checked = apply_and_check()
    if bad():
        raise RuntimeError(f"选项勾选与答案不一致（实际 {checked}，应为 {norm_items}）")
    log(f"    已选择：{[{'q': i+1, 'letters': items} for i, items in enumerate(norm_items)]}（勾选数已核对）")


def choice_letters(answer) -> list:
    """把档案里的选择题答案规整成「每题一项」的列表；多选题为子列表。"""
    if isinstance(answer, list):
        return answer
    s = str(answer or "").strip()
    if not s:
        return []
    if "," in s or "，" in s:
        return [x.strip().upper()[:1] for x in re.split(r"[,，]", s) if x.strip()]
    return [s.upper()[:1]]
