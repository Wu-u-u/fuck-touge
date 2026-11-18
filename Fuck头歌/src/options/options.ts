import {
  COLOR_DEFS,
  CUSTOM_CONFIG_KEY,
  isHexColor,
  normalizeCustomConfig,
} from "../shared/custom";
import type { BackgroundFit, CustomColorKey, CustomConfig } from "../shared/types";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const els = {
  version: $<HTMLSpanElement>("#version"),
  bgState: $<HTMLSpanElement>("#bgState"),
  bgEnabled: $<HTMLInputElement>("#bgEnabled"),
  bgDetails: $<HTMLDivElement>("#bgDetails"),
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
  colors: $<HTMLDivElement>("#colors"),
  resetColors: $<HTMLButtonElement>("#resetColors"),
  status: $<HTMLSpanElement>("#status"),
};

let config: CustomConfig = normalizeCustomConfig(null);
let saveTimer = 0;
let saveSeq = 0;
let colorRows = new Map<CustomColorKey, {
  row: HTMLDivElement;
  check: HTMLInputElement;
  color: HTMLInputElement;
  hex: HTMLInputElement;
}>();

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

const renderBackground = (): void => {
  const bg = config.background;
  const hasImage = !!bg.image;
  els.bgEnabled.checked = bg.enabled;
  els.bgDetails.hidden = !bg.enabled;
  els.bgThumb.hidden = !hasImage;
  els.bgEmpty.hidden = hasImage;
  if (hasImage) {
    els.bgThumb.src = bg.image;
    els.bgPreview.classList.add("has-image");
  } else {
    els.bgThumb.removeAttribute("src");
    els.bgPreview.classList.remove("has-image");
  }

  els.bgState.textContent = bg.enabled ? (hasImage ? "已启用" : "待选择图片") : "未启用";
  els.bgState.classList.toggle("off", !bg.enabled || !hasImage);
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

const render = (): void => {
  renderBackground();
  renderColors();
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

const setBackground = (image: string): void => {
  config.background.image = image;
  config.background.enabled = true;
  saveNow();
  render();
};

const load = (): void => {
  try {
    chrome.storage.local.get(CUSTOM_CONFIG_KEY, (result) => {
      if (chrome.runtime?.lastError) {
        setStatus("读取失败，先显示默认值", "err");
        config = normalizeCustomConfig(null);
      } else {
        config = normalizeCustomConfig(result?.[CUSTOM_CONFIG_KEY]);
        setStatus("已读取 · 修改会自动保存", "ok");
      }
      render();
    });
  } catch (e) {
    config = normalizeCustomConfig(null);
    render();
    setStatus("读取失败，先显示默认值", "err");
  }
};

els.bgEnabled.addEventListener("change", () => {
  config.background.enabled = els.bgEnabled.checked;
  saveNow();
  render();
});

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
    setBackground(result.dataUrl);
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
  saveNow();
  render();
  setStatus("背景已移除", "ok");
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

document.addEventListener("visibilitychange", () => {
  if (document.hidden && saveTimer) saveNow();
});

buildColorRows();
els.version.textContent = `v${chrome.runtime.getManifest().version}`;
render();
load();
