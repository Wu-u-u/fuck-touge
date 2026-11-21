import {
  COLOR_DEFS,
  CUSTOM_CONFIG_KEY,
  isHexColor,
  normalizeCustomConfig,
} from "../shared/custom";
import {
  EDITOR_DIRECT_OPTIONS,
  EDITOR_GROUPS,
  countEditorOverrides,
  deleteEditorPath,
  getEditorPath,
  setEditorPath,
  type EditorOptionField,
} from "../shared/editor-options";
import { applyMaterialPalette, clearMaterialPalette, seedFromImage } from "../shared/material-theme";
import type { BackgroundFit, CustomColorKey, CustomConfig } from "../shared/types";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const els = {
  version: $<HTMLSpanElement>("#version"),
  aboutVersion: $<HTMLSpanElement>("#aboutVersion"),
  bgState: $<HTMLSpanElement>("#bgState"),
  bgPreview: $<HTMLDivElement>("#bgPreview"),
  bgThumb: $<HTMLImageElement>("#bgThumb"),
  bgEmpty: $<HTMLDivElement>("#bgEmpty"),
  bgFile: $<HTMLInputElement>("#bgFile"),
  pickImage: $<HTMLButtonElement>("#pickImage"),
  removeBg: $<HTMLButtonElement>("#removeBg"),
  bgOpacity: $<HTMLInputElement>("#bgOpacity"),
  bgOpacityVal: $<HTMLOutputElement>("#bgOpacityVal"),
  bgPanelOpacity: $<HTMLInputElement>("#bgPanelOpacity"),
  bgPanelOpacityVal: $<HTMLOutputElement>("#bgPanelOpacityVal"),
  bgEditorOpacity: $<HTMLInputElement>("#bgEditorOpacity"),
  bgEditorOpacityVal: $<HTMLOutputElement>("#bgEditorOpacityVal"),
  bgFit: $<HTMLSelectElement>("#bgFit"),
  bgFixed: $<HTMLInputElement>("#bgFixed"),
  bgMeta: $<HTMLDivElement>("#bgMeta"),
  materialYou: $<HTMLInputElement>("#materialYou"),
  materialYouHint: $<HTMLDivElement>("#materialYouHint"),
  colors: $<HTMLDivElement>("#colors"),
  resetColors: $<HTMLButtonElement>("#resetColors"),
  editorCount: $<HTMLSpanElement>("#editorCount"),
  editorDirect: $<HTMLDivElement>("#editorDirect"),
  editorGroups: $<HTMLDivElement>("#editorGroups"),
  moreEditor: $<HTMLDetailsElement>("#moreEditor"),
  moreHint: $<HTMLSpanElement>("#moreHint"),
  resetEditor: $<HTMLButtonElement>("#resetEditor"),
  editorJson: $<HTMLTextAreaElement>("#editorJson"),
  applyEditorJson: $<HTMLButtonElement>("#applyEditorJson"),
  editorJsonMsg: $<HTMLSpanElement>("#editorJsonMsg"),
  status: $<HTMLSpanElement>("#status"),
};

let config: CustomConfig = normalizeCustomConfig(null);
let saveTimer = 0;
let saveSeq = 0;
let lastSaved = "";
let colorRows = new Map<CustomColorKey, {
  row: HTMLDivElement;
  check: HTMLInputElement;
  color: HTMLInputElement;
  hex: HTMLInputElement;
}>();

let editorDirectInputs = new Map<string, HTMLInputElement>();
let editorFieldControls = new Map<string, HTMLInputElement | HTMLSelectElement>();

const setStatus = (text: string, kind: "ok" | "err" | "idle" = "idle"): void => {
  els.status.textContent = text;
  els.status.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const estimateDataUrlBytes = (dataUrl: string): number => {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.round((payload.length * 3) / 4) - padding);
};

const save = (): void => {
  const seq = ++saveSeq;
  const snapshot = normalizeCustomConfig(config);
  lastSaved = JSON.stringify(snapshot);
  try {
    chrome.storage.local.set({ [CUSTOM_CONFIG_KEY]: snapshot }, () => {
      if (seq !== saveSeq) return;
      const err = chrome.runtime?.lastError;
      if (err) {
        setStatus(`保存失败：${err.message || "图片可能太大，换一张小图"}`, "err");
        return;
      }
      setStatus("已保存 · 头歌页面会自动更新（若已打开）", "ok");
    });
  } catch (e) {
    setStatus("保存失败：浏览器没有开放存储权限", "err");
  }
};

const saveSoon = (): void => {
  setStatus("保存中…");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    save();
  }, 260);
};

const saveNow = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = 0;
  }
  save();
};

const applyMaterialPreview = (): void => {
  if (config.materialYou && config.materialSeed) {
    applyMaterialPalette(document.documentElement, config.materialSeed);
  } else {
    clearMaterialPalette(document.documentElement);
  }
};

const renderBackground = (): void => {
  const bg = config.background;
  const hasImage = !!bg.image;
  els.bgThumb.hidden = !hasImage;
  els.bgEmpty.hidden = hasImage;
  if (hasImage) {
    els.bgThumb.src = bg.image;
    els.bgPreview.classList.add("has-image");
  } else {
    els.bgThumb.removeAttribute("src");
    els.bgPreview.classList.remove("has-image");
  }

  els.bgState.textContent = bg.enabled ? "已开启" : "未开启";
  els.bgState.classList.toggle("off", !bg.enabled);
  const transparency = Math.round((1 - bg.opacity) * 100);
  els.bgOpacity.value = String(transparency);
  els.bgOpacityVal.textContent = `${transparency}%`;
  els.bgPanelOpacity.value = String(Math.round(bg.panelOpacity * 100));
  els.bgPanelOpacityVal.textContent = `${Math.round(bg.panelOpacity * 100)}%`;
  els.bgEditorOpacity.value = String(Math.round(bg.editorOpacity * 100));
  els.bgEditorOpacityVal.textContent = `${Math.round(bg.editorOpacity * 100)}%`;
  els.bgFit.value = bg.fit;
  els.bgFixed.checked = bg.fixed;
  els.removeBg.disabled = !hasImage;
  const canMaterial = hasImage && !!config.materialSeed;
  els.materialYou.disabled = !canMaterial;
  els.materialYou.checked = canMaterial && config.materialYou;
  els.materialYouHint.textContent = !hasImage
    ? "先选择背景图，再从图片取色"
    : !config.materialSeed
      ? "正在从图片取色…"
      : config.materialYou
        ? "已启用 · 从背景图取色，只影响弹窗和高级设置"
        : "从背景图取色，只影响弹窗和高级设置";

  if (!hasImage) {
    els.bgMeta.textContent = "未选择图片";
  } else if (/^data:image\//i.test(bg.image)) {
    els.bgMeta.textContent = `本地图片 · 约 ${formatBytes(estimateDataUrlBytes(bg.image))} · 已压缩`;
  } else {
    els.bgMeta.textContent = "外链图片 · 加载速度取决于源站";
  }
};

const renderColors = (): void => {
  for (const def of COLOR_DEFS) {
    const row = colorRows.get(def.key);
    if (!row) continue;
    const value = config.colors[def.key];
    const on = !!value;
    row.row.classList.toggle("on", on);
    row.check.checked = on;
    row.color.value = value || def.default;
    row.hex.value = value || def.default;
    row.color.disabled = !on;
    row.hex.disabled = !on;
  }
};

const buildColorRows = (): void => {
  els.colors.innerHTML = "";
  colorRows = new Map();

  for (const def of COLOR_DEFS) {
    const row = document.createElement("div");
    row.className = "color-row";
    row.dataset.key = def.key;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "enable";
    check.setAttribute("aria-label", `覆盖${def.label}`);

    const name = document.createElement("div");
    name.className = "name";
    const strong = document.createElement("strong");
    strong.textContent = def.label;
    const small = document.createElement("small");
    small.textContent = def.hint;
    name.append(strong, small);

    const color = document.createElement("input");
    color.type = "color";
    color.value = def.default;
    color.setAttribute("aria-label", `${def.label}颜色`);

    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "hex";
    hex.maxLength = 9;
    hex.spellcheck = false;
    hex.setAttribute("aria-label", `${def.label}颜色值`);
    hex.value = def.default;

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "reset";
    reset.textContent = "跟随主题";

    const applyValue = (value: string, persist: boolean): void => {
      check.checked = true;
      color.disabled = false;
      hex.disabled = false;
      row.classList.add("on");
      color.value = value;
      hex.value = value;
      config.colors[def.key] = value;
      if (persist) saveSoon();
    };

    check.addEventListener("change", () => {
      if (check.checked) {
        const value = isHexColor(hex.value) ? hex.value : def.default;
        applyValue(value, true);
      } else {
        delete config.colors[def.key];
        color.disabled = true;
        hex.disabled = true;
        row.classList.remove("on");
        saveNow();
      }
    });

    color.addEventListener("input", () => {
      if (!isHexColor(color.value)) return;
      if (!check.checked) {
        check.checked = true;
        color.disabled = false;
        hex.disabled = false;
        row.classList.add("on");
      }
      hex.value = color.value;
      config.colors[def.key] = color.value;
      saveSoon();
    });

    hex.addEventListener("change", () => {
      if (!isHexColor(hex.value)) {
        hex.value = config.colors[def.key] || def.default;
        setStatus("颜色格式不对，应该是 #rgb / #rrggbb", "err");
        return;
      }
      applyValue(hex.value.trim().toLowerCase(), true);
      saveNow();
    });

    reset.addEventListener("click", () => {
      delete config.colors[def.key];
      check.checked = false;
      color.disabled = true;
      hex.disabled = true;
      row.classList.remove("on");
      color.value = def.default;
      hex.value = def.default;
      saveNow();
    });

    row.append(check, name, color, hex, reset);
    els.colors.appendChild(row);
    colorRows.set(def.key, { row, check, color, hex });
  }
};

const editorFieldValue = (field: EditorOptionField): unknown => getEditorPath(config.editor, field.path);

const writeEditorField = (field: EditorOptionField, value: unknown): void => {
  if (value === undefined) deleteEditorPath(config.editor, field.path);
  else setEditorPath(config.editor, field.path, value);
  saveNow();
  renderEditorOptions();
};

const updateEditorCounts = (): void => {
  const total = countEditorOverrides(config.editor);
  els.editorCount.textContent = `${total} 项覆盖`;
  els.editorCount.classList.toggle("off", total === 0);
  els.moreHint.textContent = total ? `${total} 项已覆盖` : "按分类展开";
  for (const group of EDITOR_GROUPS) {
    const count = group.fields.filter((f) => getEditorPath(config.editor, f.path) !== undefined).length;
    const badge = els.editorGroups.querySelector<HTMLElement>(
      `.count[data-group="${group.id}"]`,
    );
    if (badge) badge.textContent = count ? `${count} 项` : "";
  }
};

const createEditorControl = (field: EditorOptionField): HTMLInputElement | HTMLSelectElement => {
  if (field.type === "bool" || field.type === "select") {
    const select = document.createElement("select");
    select.setAttribute("aria-label", field.label);
    const add = (value: string, label: string): void => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    };
    add("", "跟随默认");
    if (field.type === "bool") {
      add("true", "开");
      add("false", "关");
    } else {
      for (const opt of field.options || []) add(opt.value, opt.label);
    }
    select.addEventListener("change", () => {
      if (!select.value) {
        writeEditorField(field, undefined);
      } else if (field.type === "bool") {
        writeEditorField(field, select.value === "true");
      } else {
        writeEditorField(field, field.numeric ? Number(select.value) : select.value);
      }
    });
    return select;
  }

  const input = document.createElement("input");
  input.type = field.type === "number" ? "number" : "text";
  input.placeholder = field.placeholder || "跟随默认";
  input.setAttribute("aria-label", field.label);
  if (field.type === "number") {
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.step !== undefined) input.step = String(field.step);
  }
  input.addEventListener("change", () => {
    const raw = input.value.trim();
    if (!raw) {
      writeEditorField(field, undefined);
      return;
    }
    if (field.type === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        renderEditorOptions();
        setStatus("请输入数字", "err");
        return;
      }
      writeEditorField(field, value);
    } else {
      writeEditorField(field, raw);
    }
  });
  return input;
};

const buildEditorDirect = (): void => {
  els.editorDirect.innerHTML = "";
  editorDirectInputs = new Map();
  for (const field of EDITOR_DIRECT_OPTIONS) {
    const row = document.createElement("div");
    row.className = "editor-row";

    const name = document.createElement("div");
    name.className = "name";
    const strong = document.createElement("strong");
    strong.textContent = field.label;
    const small = document.createElement("small");
    small.textContent = field.hint || field.path;
    name.append(strong, small);

    const sw = document.createElement("label");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", field.label);
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.append(input, slider);

    input.addEventListener("change", () => {
      if (input.checked) setEditorPath(config.editor, field.path, true);
      else deleteEditorPath(config.editor, field.path);
      saveNow();
      renderEditorOptions();
    });

    row.append(name, sw);
    els.editorDirect.appendChild(row);
    editorDirectInputs.set(field.path, input);
  }
};

const buildEditorGroups = (): void => {
  els.editorGroups.innerHTML = "";
  editorFieldControls = new Map();
  for (const group of EDITOR_GROUPS) {
    const details = document.createElement("details");
    details.className = "editor-group";

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = group.label;
    const count = document.createElement("span");
    count.className = "count";
    count.dataset.group = group.id;
    summary.append(label, count);
    details.appendChild(summary);

    const fields = document.createElement("div");
    fields.className = "editor-fields";
    for (const field of group.fields) {
      const row = document.createElement("div");
      row.className = "editor-field";
      const name = document.createElement("span");
      name.className = "ef-label";
      name.textContent = field.label;
      name.title = field.path;
      const control = createEditorControl(field);
      row.append(name, control);
      fields.appendChild(row);
      editorFieldControls.set(field.path, control);
    }
    details.appendChild(fields);
    els.editorGroups.appendChild(details);
  }
};

const renderEditorOptions = (): void => {
  for (const field of EDITOR_DIRECT_OPTIONS) {
    const input = editorDirectInputs.get(field.path);
    if (input) input.checked = getEditorPath(config.editor, field.path) === true;
  }

  for (const group of EDITOR_GROUPS) {
    for (const field of group.fields) {
      const control = editorFieldControls.get(field.path);
      if (!control) continue;
      const value = editorFieldValue(field);
      if (control instanceof HTMLSelectElement) {
        if (field.type === "bool") {
          control.value = value === true ? "true" : value === false ? "false" : "";
        } else {
          control.value = value === undefined ? "" : String(value);
        }
      } else {
        control.value = typeof value === "number" || typeof value === "string" ? String(value) : "";
      }
    }
  }

  if (document.activeElement !== els.editorJson) {
    els.editorJson.value = JSON.stringify(config.editor, null, 2) || "{}";
  }
  updateEditorCounts();
};

const render = (): void => {
  renderBackground();
  renderColors();
  renderEditorOptions();
};

const decodeFile = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

const compressImage = async (
  file: File,
): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> => {
  if (file.size > 30 * 1024 * 1024) throw new Error("图片太大（超过 30MB），换一张小图");
  const source = await decodeFile(file);
  const sw = "width" in source ? source.width : 0;
  const sh = "height" in source ? source.height : 0;
  if (!sw || !sh) throw new Error("无法读取图片尺寸");

  const max = 2560;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器无法创建图片画布");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  if ("close" in source && typeof source.close === "function") source.close();

  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/webp", quality);
  while (estimateDataUrlBytes(dataUrl) > 1.8 * 1024 * 1024 && quality > 0.55) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/webp", quality);
  }
  const bytes = estimateDataUrlBytes(dataUrl);
  if (!dataUrl.startsWith("data:image/") || bytes === 0) {
    throw new Error("图片压缩失败，换一张 PNG / JPG / WebP 试试");
  }
  if (bytes > 3 * 1024 * 1024) {
    throw new Error("压缩后仍然太大，换一张尺寸小一点的图片");
  }
  return { dataUrl, width, height, bytes };
};

const setBackground = (image: string, seed: string): void => {
  config.background.image = image;
  config.background.enabled = true;
  config.materialSeed = seed;
  saveNow();
  render();
  applyMaterialPreview();
};

const load = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, (result) => {
      if (chrome.runtime?.lastError) {
        setStatus("读取失败，先显示默认值", "err");
        config = normalizeCustomConfig(null);
      } else {
        config = normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY]);
        lastSaved = JSON.stringify(config);
        setStatus("已读取 · 修改会自动保存", "ok");
      }
      render();
      applyMaterialPreview();
    });
  } catch (e) {
    config = normalizeCustomConfig(null);
    lastSaved = JSON.stringify(config);
    render();
    applyMaterialPreview();
    setStatus("读取失败，先显示默认值", "err");
  }
};

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CUSTOM_CONFIG_KEY]) return;
    const next = normalizeCustomConfig(changes[CUSTOM_CONFIG_KEY].newValue);
    const json = JSON.stringify(next);
    if (json === lastSaved) return;
    lastSaved = json;
    config = next;
    render();
    applyMaterialPreview();
    setStatus("已同步弹窗开关", "ok");
  });
} catch (e) {}

els.pickImage.addEventListener("click", () => els.bgFile.click());

els.bgFile.addEventListener("change", async () => {
  const file = els.bgFile.files?.[0];
  els.bgFile.value = "";
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("请选择图片文件", "err");
    return;
  }
  els.pickImage.disabled = true;
  setStatus("正在压缩图片…");
  try {
    const result = await compressImage(file);
    const seed = (await seedFromImage(result.dataUrl)) || "#cba6f7";
    setBackground(result.dataUrl, seed);
    setStatus(`背景已更新 · ${result.width}×${result.height} · ${formatBytes(result.bytes)}`, "ok");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "图片处理失败", "err");
  } finally {
    els.pickImage.disabled = false;
  }
});

els.removeBg.addEventListener("click", () => {
  config.background.image = "";
  config.background.enabled = false;
  config.materialSeed = "";
  config.materialYou = false;
  saveNow();
  render();
  applyMaterialPreview();
  setStatus("背景已移除", "ok");
});

els.materialYou.addEventListener("change", () => {
  config.materialYou = els.materialYou.checked && !!config.materialSeed;
  saveNow();
  applyMaterialPreview();
  renderBackground();
});

els.bgOpacity.addEventListener("input", () => {
  const value = Number(els.bgOpacity.value);
  config.background.opacity = Math.min(1, Math.max(0, 1 - value / 100));
  els.bgOpacityVal.textContent = `${Math.round((1 - config.background.opacity) * 100)}%`;
  saveSoon();
});

els.bgPanelOpacity.addEventListener("input", () => {
  const value = Number(els.bgPanelOpacity.value);
  config.background.panelOpacity = Math.min(1, Math.max(0.5, value / 100));
  els.bgPanelOpacityVal.textContent = `${Math.round(config.background.panelOpacity * 100)}%`;
  saveSoon();
});

els.bgEditorOpacity.addEventListener("input", () => {
  const value = Number(els.bgEditorOpacity.value);
  config.background.editorOpacity = Math.min(1, Math.max(0.5, value / 100));
  els.bgEditorOpacityVal.textContent = `${Math.round(config.background.editorOpacity * 100)}%`;
  saveSoon();
});

els.bgFit.addEventListener("change", () => {
  config.background.fit = els.bgFit.value as BackgroundFit;
  saveNow();
});

els.bgFixed.addEventListener("change", () => {
  config.background.fixed = els.bgFixed.checked;
  saveNow();
});

// 拖动时用 debounce，松手立刻落盘，避免后台标签页定时器被节流导致“看起来没生效”
for (const slider of [els.bgOpacity, els.bgPanelOpacity, els.bgEditorOpacity]) {
  slider.addEventListener("change", saveNow);
}

els.resetColors.addEventListener("click", () => {
  config.colors = {};
  renderColors();
  saveNow();
  setStatus("页面颜色已恢复跟随主题", "ok");
});

els.resetEditor.addEventListener("click", () => {
  config.editor = {};
  saveNow();
  renderEditorOptions();
  setStatus("编辑器选项已恢复默认", "ok");
});

els.applyEditorJson.addEventListener("click", () => {
  try {
    const raw = els.editorJson.value.trim() || "{}";
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON 必须是一个对象");
    }
    config = normalizeCustomConfig({ ...config, editor: parsed });
    saveNow();
    render();
    els.editorJsonMsg.textContent = "已应用";
    els.editorJsonMsg.className = "meta ok";
  } catch (e) {
    els.editorJsonMsg.textContent = e instanceof Error ? e.message : "JSON 格式错误";
    els.editorJsonMsg.className = "meta err";
  }
});

const navLinks = [...document.querySelectorAll<HTMLAnchorElement>(".nav a[data-section]")];
const navSections = navLinks
  .map((a) => document.getElementById(a.dataset.section || ""))
  .filter((s): s is HTMLElement => !!s);

const setActiveNav = (id: string): void => {
  navLinks.forEach((a) => {
    const on = a.dataset.section === id;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  });
};

const showPanel = (id: string): void => {
  navSections.forEach((section) => {
    section.hidden = section.id !== id;
  });
  window.scrollTo({ top: 0, behavior: "auto" });
};

if (navSections.length) {
  navLinks.forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.dataset.section || "";
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      setActiveNav(id);
      showPanel(id);
      try {
        history.replaceState(null, "", `#${id}`);
      } catch (err) {}
    });
  });
  const initial = location.hash.replace(/^#/, "");
  const active = navSections.some((s) => s.id === initial) ? initial : navSections[0].id;
  setActiveNav(active);
  showPanel(active);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && saveTimer) saveNow();
});

buildColorRows();
buildEditorDirect();
buildEditorGroups();
els.version.textContent = `v${chrome.runtime.getManifest().version}`;
els.aboutVersion.textContent = `v${chrome.runtime.getManifest().version} · 测试版`;
render();
load();
