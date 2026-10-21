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


# 激活路径 + 「该激活文件当前显示的 model uri」一次拿齐。
# model 的反查走 React fiber：编辑器实例存在组件 ref 里，本平台 getEditors
# 不存在（老版本 Monaco，见 脚本详细.md），用 允许粘贴.js 已实测过的 fiber 反查。
# 多个可见编辑器对应不同 model 时保持 uri=null（不瞎猜，让兜底走失败路径）。
FILE_ACTIVE_MODEL_JS = r"""
JSON.stringify((function(){
  const out = {path: null, uri: null};
  const el = document.querySelector('[class*="pathActive"]');
  if (el) out.path = (el.innerText || '').trim();
  try {
    const cands = [];
    [...document.querySelectorAll('.monaco-editor')].forEach(ed => {
      if (!(ed.getBoundingClientRect().width > 0)) return;
      let node = ed;
      while (node) {
        const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
        if (!key) { node = node.parentElement; continue; }
        let f = node[key], d = 0;
        while (f && d < 80) {
          let hook = f.memoizedState, h = 0;
          while (hook && h < 50) {
            const v = hook.memoizedState;
            const inst = v && v.current && v.current.instance;
            if (inst && typeof inst.getModel === 'function') {
              try {
                const m = inst.getModel();
                if (m && m.uri) cands.push(String(m.uri.toString()));
              } catch (e2) {}
              return;
            }
            hook = hook.next; h++;
          }
          f = f.return; d++;
        }
        return;
      }
    });
    const uniq = [...new Set(cands.filter(Boolean))];
    if (uniq.length === 1) out.uri = uniq[0];
  } catch (e) {}
  return JSON.stringify(out);
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
    """把「代码文件」下拉收起来（hover 触发，鼠标移开就会收）。

    收不起来必须报错停下：下拉会挡住遮罩后面的真实点击（「下一关」「评测」等），
    静默放弃会出现"看起来关了、实际后面全被吞"的诡异连环失败。
    """
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
            time.sleep(0.3)
            continue
        page.ws.mouse_click(pos["x"], pos["y"])
        time.sleep(0.3)
    # 下拉收起检测存在抖动（平台 re-render/鼠标位置），这里不再中断流程：
    # 记录告警并返回 False，调用方继续；真正被遮罩吞点击时后续步骤会自行报错。
    log("    ！「代码文件」下拉收不起来（移开鼠标和点击触发器都无效），继续尝试后续步骤")
    return False


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


def _norm_path(p: str) -> str:
    """归一化路径文本：去首尾空白、统一斜杠（用于路径比较）。"""
    return (p or "").strip().replace("\\", "/")


def _same_path(a: str, b: str, items: list[dict] | None = None) -> bool:
    """判断 a 是否就是目标文件 b。

    传了当前下拉的 items 时：若与 b 同名 basename 的菜单项 ≥2 个，说明同名
    兄弟文件存在歧义，此时必须**完整路径全等**才认为一致，绝不按 basename
    兜底（否则真实点击会落到同名兄弟文件上）。不歧义时保留旧行为
    （下拉显示的路径可能与档案路径不完全一致，basename 唯一时可以对应）。
    """
    a = _norm_path(a)
    b = _norm_path(b)
    if not a or not b:
        return False
    if a == b:
        return True
    if items is not None:
        base = b.rsplit("/", 1)[-1]
        same_base = [it for it in items
                     if _norm_path(str(it.get("path") or "")).rsplit("/", 1)[-1] == base]
        if len(same_base) >= 2:
            return False                     # 同名歧义：宁可不点也不能点错
    return a.rsplit("/", 1)[-1] == b.rsplit("/", 1)[-1]


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


def _resolve_active_model(page: Page, path: str,
                          model_map: dict | None = None) -> str | None:
    """没新建 model 的兜底：确认「当前激活文件」就是目标后，取它对应的 model。

    平台点已激活的文件是无操作，此时编辑器显示的就是这个文件的 model。
    依次确认：正在显示的 model（fiber 反查）→ 本流程内记录的 path→model 映射
    → 唯一 model。激活路径必须与目标**完整路径全等**（不做 basename 兜底）；
    哪条都确认不了就返回 None，让上层走失败路径 —— 绝不随便返回"最新的 model"，
    那可能是别的文件的 model，会把别的文件内容当成这个文件读写。
    """
    want = _norm_path(path)
    if not want:
        return None
    uris = _model_uris(page)
    if not uris:
        return None
    st = page.ws.eval_json(FILE_ACTIVE_MODEL_JS) or {}
    if _norm_path(str(st.get("path") or "")) != want:
        return None                                  # 激活的不是目标文件
    shown = st.get("uri")
    if shown and shown in uris:                      # 编辑器正在显示的 model
        if model_map is not None:
            model_map[want] = shown
        return shown
    if model_map is not None and model_map.get(want) in uris:
        return model_map[want]
    if len(uris) == 1:                               # 唯一 model 必然就是激活文件的
        if model_map is not None:
            model_map[want] = uris[0]
        return uris[0]
    return None


def click_code_file(page: Page, path: str, timeout: float = 5,
                    model_map: dict | None = None) -> str | None:
    """展开下拉、真实点击某个文件项，返回该文件对应的 model uri。

    点未激活的文件平台会新建 model（编号最大的新 model 就是刚点开的文件）；
    点「当前已激活」的文件是无操作（不新建 model）：此时必须确认激活路径与
    目标**完整路径全等**，再取该激活文件正在显示的 model（见
    _resolve_active_model），确认不了返回 None。绝不拿「最新的 model」充数 ——
    那可能是别的文件的 model，会读写错文件。
    model_map 是本流程内的「路径 → model uri」记录（新建 model 时更新），
    供兜底时确认对应关系；点不动（既没新 model、激活标记也对不上）会重试，
    最终失败返回 None。
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
        vis_now: list[dict] = []
        for _ in range(8):
            vis_now = [x for x in _file_items(page) if x.get("visible")]
            cur = _find_item(vis_now, path)
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
        # 点击前最后确认：该坐标下确实还是这个菜单项。当前下拉里同名 basename
        # 的项 ≥2 时存在歧义，只认完整路径全等，绝不按 basename 兜底
        #（否则会点错同名兄弟文件）；对不上就放弃本次点击重试。
        hit = page.ws.eval_json(FILE_HIT_JS % (fresh["x"], fresh["y"]))
        if hit is None or not _same_path(hit, path, vis_now):
            time.sleep(0.3)
            continue
        page.ws.mouse_click(fresh["x"], fresh["y"])      # 必须真实点击
        deadline = time.time() + timeout
        while time.time() < deadline:
            new = [u for u in _model_uris(page) if u not in before]
            if new:
                uri = _newest_uri(new)
                if model_map is not None:
                    model_map[_norm_path(path)] = uri
                return uri
            time.sleep(0.25)
        uri = _resolve_active_model(page, path, model_map)
        if uri:
            return uri
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
    """多文件关卡：逐个点开文件，从新 model 读代码（结束后收起下拉，避免遮罩）。"""
    out, notes = [], []
    model_map: dict[str, str] = {}   # 本次采集流程内的「路径 → model」映射，供兜底确认
    try:
        for path in paths:
            uri = click_code_file(page, path, model_map=model_map)
            if not uri:
                return None, None, f"点开文件「{path}」失败（下拉菜单里没反应）"
            code = wait_uri_settled(page, uri)
            if not isinstance(code, str) or not code.strip():
                return None, None, f"文件「{path}」读不到内容"
            out.append((path, code))
            notes.append(f"{path}（{len(code)} 字符）")
        return "files", out, "；".join(notes)
    finally:
        try:
            close_file_menu(page)       # 下拉展开着会挡住后面的「下一关」点击
        except cdp.CDPError:
            pass


def write_files(page: Page, live_paths: list[str], entries: list[dict]) -> None:
    """多文件关卡：逐文件真实点击切换 + 整文件覆盖，最后同步并核对。

    entries 来自答案档案：[{"path": ..., "answer": ...}, ...]。
    写入后把每个文件再点一遍：既让平台把自己的状态同步完整，也顺便核对
    新点开的 model 内容确实等于档案答案（不等就补写一次）。
    结束后必定收起「代码文件」下拉，避免遮罩吞掉后面的「下一关」点击。
    """
    try:
        _write_files(page, live_paths, entries)
    finally:
        try:
            close_file_menu(page)
        except cdp.CDPError:
            pass


def _write_files(page: Page, live_paths: list[str], entries: list[dict]) -> None:
    model_map: dict[str, str] = {}   # 本次写入流程内的「路径 → model」映射，供兜底确认

    def _entry_for(live: str) -> dict | None:
        """优先完整路径；只有 basename 在档案和当前关卡里都唯一时才退回 basename。"""
        live_n = (live or "").strip().replace("\\", "/")
        for e in entries:
            p = str(e.get("path") or "").strip().replace("\\", "/")
            if p == live_n:
                return e
        base = live_n.rsplit("/", 1)[-1]
        cands = [e for e in entries
                 if str(e.get("path") or "").strip().replace("\\", "/").rsplit("/", 1)[-1] == base]
        live_same = [p for p in live_paths
                     if (p or "").strip().replace("\\", "/").rsplit("/", 1)[-1] == base]
        if len(cands) == 1 and len(live_same) == 1:
            return cands[0]
        return None

    plan = []
    matched: set[int] = set()
    for live in live_paths:
        ent = _entry_for(live)
        if ent is None:
            raise RuntimeError(f"档案里没有文件「{live}」的条目（或同名文件有歧义），"
                               "请先 harvest 或手动补全")
        code = str(ent.get("answer") or "")
        if not code.strip():
            raise RuntimeError(f"档案里文件「{ent.get('path') or live}」的答案是空的")
        plan.append((live, code))
        matched.add(id(ent))
    extra = [str(e.get("path")) for e in entries if id(e) not in matched]
    if extra:
        raise RuntimeError("档案里的这些文件在本关不存在：" + "；".join(extra)
                           + "（可用 harvest 重新采集）")

    for path, code in plan:
        uri = click_code_file(page, path, model_map=model_map)
        if not uri:
            raise RuntimeError(f"点开文件「{path}」失败（下拉菜单里没反应）")
        wait_uri_settled(page, uri, timeout=6)    # 先等平台内容载入，防止写后被覆盖
        n = write_uri_code(page, uri, code)
        log(f"    已写入 {path}（{n} 字符）")
        time.sleep(0.3)                           # 让平台先消化这次修改再切文件

    for path, code in plan:
        uri = click_code_file(page, path, model_map=model_map)
        if not uri:
            raise RuntimeError(f"同步核对时点开文件「{path}」失败")
        got = wait_uri_settled(page, uri, timeout=6)
        if (got or "").strip("\n") != code.strip("\n"):
            uri = click_code_file(page, path, model_map=model_map)     # 补救一次
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


CHOICE_LETTER_RE = re.compile(r"^[A-Za-z]$")


def _choice_letter(value) -> str:
    """规范并校验单个选项字母：必须是 A-Z 的单个字母。"""
    s = str(value).strip()
    if not s:
        raise ValueError("选择题答案里有空选项")
    if not CHOICE_LETTER_RE.fullmatch(s):
        raise ValueError(
            f"选择题答案「{s}」无效：每题必须是单个字母 A-Z"
            "（多选题写成 [\"A\",\"B\"]，不要写 \"AB\"）")
    return s.upper()


def _norm_choice_items(items) -> list[list[str]]:
    """把「每题一项」的答案规范成 [[字母...], ...]，并拒绝空/非法值。"""
    if isinstance(items, str):
        items = [items]
    if not isinstance(items, (list, tuple)) or not items:
        raise ValueError("选择题答案不能为空")
    out: list[list[str]] = []
    for it in items:
        if isinstance(it, (list, tuple)):
            if not it:
                raise ValueError("选择题答案里有空的选项组")
            out.append([_choice_letter(x) for x in it])
        else:
            out.append([_choice_letter(it)])
    return out


def answer_choice(page: Page, items: list) -> None:
    """选择题：按题号顺序点选选项。

    items 每题一项：可以是 'A'，也可以是 ['A','B','D']（多选题）。
    关键：页面会回显历史勾选，而 checkbox 点击是"切换"，所以必须
    先清掉不在答案里的已勾选项，再补勾缺少的（radio 点目标即切换，无需清）。
    作答前先校验页面选项组数与答案题数一致，避免错位作答。
    """
    norm_items = _norm_choice_items(items)
    payload = json.dumps(norm_items)

    # 作答前校验页面选项组数与答案题数一致，避免错位作答
    try:
        groups = int(page.ws.eval("document.querySelectorAll('.option').length") or 0)
    except (cdp.CDPError, TypeError, ValueError):
        groups = 0
    if groups != len(norm_items):
        raise RuntimeError(
            f"页面选项组数（{groups}）与答案题数（{len(norm_items)}）不一致，已停止")

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
    """把档案里的选择题答案规整成「每题一项」的列表；多选题为子列表。

    校验规则：空答案/空项、非 A-Z 字符、多字符（如 "AB"）一律拒绝；
    多选请写成嵌套列表（[["A","B"], ["C"]]）。
    """
    if isinstance(answer, (list, tuple)):
        return _norm_choice_items(answer)
    s = str(answer or "").strip()
    if not s:
        raise ValueError("选择题答案不能为空")
    if "," in s or "，" in s:
        parts = re.split(r"[,，]", s)
        if any(not p.strip() for p in parts):
            raise ValueError(f"选择题答案「{s}」里有空项")
        return [_choice_letter(p) for p in parts]
    return [_choice_letter(s)]
