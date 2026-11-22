import {
  COLOR_DEFS,
  CUSTOM_CONFIG_KEY,
  activeWallpaper,
  isHexColor,
  isMediaSource,
  normalizeCustomConfig,
  wallpaperKind,
  MAX_WALLPAPERS,
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
import { dataUrlToBlob } from "../features/media-cache";
import type { BackgroundFit, BackgroundTransition, CustomColorKey, CustomConfig, Wallpaper, WallpaperCrop, WallpaperKind } from "../shared/types";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const els = {
  version: $<HTMLSpanElement>("#version"),
  aboutVersion: $<HTMLSpanElement>("#aboutVersion"),
  bgState: $<HTMLSpanElement>("#bgState"),
  bgPreview: $<HTMLDivElement>("#bgPreview"),
  bgThumb: $<HTMLImageElement>("#bgThumb"),
  bgThumbVideo: $<HTMLVideoElement>("#bgThumbVideo"),
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
  bgTransition: $<HTMLSelectElement>("#bgTransition"),
  bgTransitionDuration: $<HTMLSelectElement>("#bgTransitionDuration"),
  bgMeta: $<HTMLDivElement>("#bgMeta"),
  wallpaperList: $<HTMLDivElement>("#wallpaperList"),
  cropDialog: $<HTMLDialogElement>("#cropDialog"),
  cropStage: $<HTMLDivElement>("#cropStage"),
  cropImage: $<HTMLImageElement>("#cropImage"),
  cropVideo: $<HTMLVideoElement>("#cropVideo"),
  cropZoom: $<HTMLInputElement>("#cropZoom"),
  cropZoomVal: $<HTMLOutputElement>("#cropZoomVal"),
  cropCancel: $<HTMLButtonElement>("#cropCancel"),
  cropSave: $<HTMLButtonElement>("#cropSave"),
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

interface CropState {
  dataUrl: string;
  name: string;
  kind: WallpaperKind;
  nw: number;
  nh: number;
  baseScale: number;
  zoom: number;
  x: number;
  y: number;
  stageW: number;
  stageH: number;
}
let cropState: CropState | null = null;
let cropSaving = false;
let cropTargetId = "";
let cropDrag: { sx: number; sy: number; x: number; y: number } | null = null;

const setStatus = (text: string, kind: "ok" | "err" | "idle" = "idle"): void => {
  els.status.textContent = text;
  els.status.className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const mediaCache = new Map<string, string>();
const mediaLoading = new Map<string, Promise<string>>();
const mediaMissing = new Set<string>();

const mediaFor = (wp: { image: string; mediaKey?: string }): string =>
  (wp.mediaKey ? mediaCache.get(wp.mediaKey) : "") || wp.image || "";

const loadMediaFor = async (wp: { image: string; mediaKey?: string }): Promise<string> => {
  const cached = mediaFor(wp);
  if (cached) return cached;
  if (!wp.mediaKey) return "";
  const key = wp.mediaKey;
  const loading = mediaLoading.get(key);
  if (loading) return loading;
  const task = (async () => {
    const r = await new Promise<Record<string, unknown>>((resolve) => {
      try { chrome.storage.local.get(key, (x) => resolve(x || {})); }
      catch (e) { resolve({}); }
    });
    const data = typeof r[key] === "string" ? String(r[key]) : "";
    if (!data) return "";
    // 设置页也把 data URL 换成 object URL，避免把 63MB base64 字符串一直放内存里
    const blob = await dataUrlToBlob(data);
    const media = blob ? URL.createObjectURL(blob) : data;
    mediaCache.set(key, media);
    return media;
  })();
  mediaLoading.set(key, task);
  try {
    return await task;
  } finally {
    mediaLoading.delete(key);
  }
};

const hydrateMedia = async (): Promise<void> => {
  let changed = false;
  for (const wp of config.background.wallpapers) {
    if (wp.image && !wp.mediaKey) {
      const key = `fuckTougeMedia:${wp.id}`;
      await new Promise<void>((resolve) => {
        try { chrome.storage.local.set({ [key]: wp.image }, () => resolve()); }
        catch (e) { resolve(); }
      });
      mediaCache.set(key, wp.image);
      wp.mediaKey = key;
      wp.image = "";
      changed = true;
    }
  }
  if (changed) {
    lastSaved = JSON.stringify(config);
    saveNow();
    render();
    applyMaterialPreview();
  }
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
  const seed = activeWallpaper(config)?.seed || config.materialSeed;
  if (config.materialYou && seed) {
    applyMaterialPalette(document.documentElement, seed);
  } else {
    clearMaterialPalette(document.documentElement);
  }
};

const renderBackground = (): void => {
  const bg = config.background;
  const active = activeWallpaper(config);
  const media = active ? mediaFor(active) : "";
  const isVideo = active?.kind === "video";
  if (active && !media && active.mediaKey && !mediaMissing.has(active.mediaKey)) {
    void loadMediaFor(active).then((loaded) => {
      if (!loaded) mediaMissing.add(active.mediaKey);
      if (activeWallpaper(config)?.id === active.id) renderBackground();
    });
  }
  els.bgThumb.hidden = !media || isVideo;
  els.bgThumbVideo.hidden = !media || !isVideo;
  els.bgEmpty.hidden = !!media;
  if (media) {
    if (isVideo) {
      els.bgThumbVideo.src = media;
      els.bgThumbVideo.play?.().catch(() => {});
    } else {
      els.bgThumb.src = media;
    }
    els.bgPreview.classList.add("has-image");
  } else {
    els.bgThumb.removeAttribute("src");
    els.bgThumbVideo.removeAttribute("src");
    els.bgPreview.classList.remove("has-image");
  }

  els.bgState.textContent = bg.enabled ? (active ? "已开启" : "待添加壁纸") : "未开启";
  els.bgState.classList.toggle("off", !bg.enabled);
  const transparency = Math.round((1 - bg.opacity) * 100);
  els.bgOpacity.value = String(transparency);
  els.bgOpacityVal.textContent = `${transparency}%`;
  els.bgPanelOpacity.value = String(Math.round(bg.panelOpacity * 100));
  els.bgPanelOpacityVal.textContent = `${Math.round(bg.panelOpacity * 100)}%`;
  els.bgEditorOpacity.value = String(Math.round(bg.editorOpacity * 100));
  els.bgEditorOpacityVal.textContent = `${Math.round(bg.editorOpacity * 100)}%`;
  els.bgFit.value = bg.fit;
  els.bgTransition.value = bg.transition;
  els.bgTransitionDuration.value = String(bg.transitionDuration);
  if (!els.bgTransitionDuration.value) els.bgTransitionDuration.value = "1500";
  els.removeBg.disabled = !active;
  els.pickImage.disabled = bg.wallpapers.length >= MAX_WALLPAPERS;

  const canMaterial = !!active?.seed;
  els.materialYou.disabled = !canMaterial;
  els.materialYou.checked = canMaterial && config.materialYou;
  els.materialYouHint.textContent = !active
    ? "先添加一张壁纸，再从图片取色"
    : !active.seed
      ? "正在从图片取色…"
      : config.materialYou
        ? "已启用 · 跟随当前壁纸取色，只影响弹窗和高级设置"
        : "从当前壁纸取色，只影响弹窗和高级设置";

  if (!active) {
    els.bgMeta.textContent = "未选择壁纸";
  } else if (media) {
    const label = active.kind === "video" ? "视频" : active.kind === "gif" ? "GIF 动图" : "静态图";
    els.bgMeta.textContent = `${active.name} · ${label} · 约 ${formatBytes(estimateDataUrlBytes(media))}`;
  } else {
    els.bgMeta.textContent = `${active.name} · 媒体加载中…`;
  }

  renderWallpapers();
};

const addWallpaperButtons = (item: HTMLElement, wp: Wallpaper): void => {
  const recrop = document.createElement("button");
  recrop.type = "button";
  recrop.className = "recrop";
  recrop.textContent = "裁";
  recrop.title = "重新裁剪";
  recrop.addEventListener("click", (e) => {
    e.stopPropagation();
    void loadMediaFor(wp).then((media) => {
      if (media) void openCrop(media, wp.name, wp.kind, wp.width, wp.height, wp.id);
    });
  });
  item.appendChild(recrop);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.textContent = "×";
  del.title = "删除这张壁纸";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    removeWallpaper(wp.id);
  });
  item.appendChild(del);
};

const renderWallpapers = (): void => {
  const bg = config.background;
  els.wallpaperList.innerHTML = "";

  for (const wp of bg.wallpapers) {
    const item = document.createElement("div");
    item.className = "wallpaper-item" + (wp.id === bg.activeId ? " active" : "");
    item.title = wp.name;
    item.addEventListener("click", () => selectWallpaper(wp.id));

    const media = mediaFor(wp);
    // 非当前视频不预加载完整媒体；用占位符，选中/裁剪时再加载
    const deferVideo = wp.kind === "video" && !media && wp.id !== bg.activeId;
    if (!media && wp.mediaKey && !mediaMissing.has(wp.mediaKey) && !deferVideo) {
      void loadMediaFor(wp).then((loaded) => {
        if (!loaded) mediaMissing.add(wp.mediaKey);
        renderWallpapers();
      });
    }
    if (wp.kind === "video") {
      if (!media) {
        const ph = document.createElement("div");
        ph.className = "video-placeholder";
        ph.textContent = "▶";
        item.appendChild(ph);
        addWallpaperButtons(item, wp);
        els.wallpaperList.appendChild(item);
        continue;
      }
      const video = document.createElement("video");
      video.src = media;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", wp.name);
      video.addEventListener("loadedmetadata", () => { try { video.currentTime = 0.1; } catch (e) {} }, { once: true });
      item.appendChild(video);
    } else {
      const img = document.createElement("img");
      if (media) img.src = media;
      img.alt = wp.name;
      item.appendChild(img);
    }

    addWallpaperButtons(item, wp);
    els.wallpaperList.appendChild(item);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "wallpaper-add";
  add.disabled = bg.wallpapers.length >= MAX_WALLPAPERS;
  add.innerHTML = "<b>＋</b><span>添加壁纸</span>";
  add.addEventListener("click", () => els.bgFile.click());
  els.wallpaperList.appendChild(add);
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

const newWallpaperId = (): string =>
  `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const addWallpaper = async (
  image: string,
  name: string,
  kind: WallpaperKind,
  seed: string,
  crop: WallpaperCrop,
  width: number,
  height: number,
): Promise<boolean> => {
  if (config.background.wallpapers.length >= MAX_WALLPAPERS) {
    setStatus("最多 5 张壁纸，先删一张再添加", "err");
    return false;
  }
  if (config.background.wallpapers.some((w) => mediaFor(w) === image)) {
    setStatus("这张壁纸已经添加过了", "err");
    return false;
  }
  const id = newWallpaperId();
  const mediaKey = `fuckTougeMedia:${id}`;
  await new Promise<void>((resolve) => {
    try { chrome.storage.local.set({ [mediaKey]: image }, () => resolve()); }
    catch (e) { resolve(); }
  });
  mediaCache.set(mediaKey, image);
  const wp = {
    id,
    name: name || `壁纸 ${config.background.wallpapers.length + 1}`,
    image: "",
    mediaKey,
    kind,
    animated: kind !== "image",
    seed,
    crop,
    width,
    height,
  };
  config.background.wallpapers.push(wp);
  config.background.activeId = wp.id;
  config.background.image = "";
  config.background.enabled = true;
  config.materialSeed = seed;
  saveNow();
  render();
  applyMaterialPreview();
  return true;
};

const mediaDimensions = (dataUrl: string, kind: WallpaperKind): Promise<{ w: number; h: number }> =>
  new Promise((resolve, reject) => {
    if (kind === "video") {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ w: v.videoWidth, h: v.videoHeight });
      v.onerror = () => reject(new Error("视频无法解码"));
      v.src = dataUrl;
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("图片无法解码"));
    img.src = dataUrl;
  });

const seedFromVideo = async (dataUrl: string): Promise<string> => {
  try {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = dataUrl;
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("视频无法解码"));
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(320, v.videoWidth || 320);
    canvas.height = Math.min(180, v.videoHeight || 180);
    canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
    return (await seedFromImage(canvas.toDataURL("image/jpeg", .8))) || "#cba6f7";
  } catch (e) {
    return "#cba6f7";
  }
};

const selectWallpaper = (id: string): void => {
  const wp = config.background.wallpapers.find((w) => w.id === id);
  if (!wp || wp.id === config.background.activeId) return;
  config.background.activeId = wp.id;
  config.background.image = "";
  config.materialSeed = wp.seed;
  saveNow();
  render();
  applyMaterialPreview();
  setStatus(`已切换到「${wp.name}」`, "ok");
};

const removeWallpaper = (id: string): void => {
  const list = config.background.wallpapers;
  const idx = list.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const removed = list[idx];
  list.splice(idx, 1);
  if (removed.mediaKey) {
    try { chrome.storage.local.remove(removed.mediaKey); } catch (e) {}
    const cached = mediaCache.get(removed.mediaKey);
    if (cached?.startsWith("blob:")) {
      try { URL.revokeObjectURL(cached); } catch (e) {}
    }
    mediaCache.delete(removed.mediaKey);
  }
  if (!list.length) {
    config.background.activeId = "";
    config.background.image = "";
    config.background.enabled = false;
    config.materialSeed = "";
    config.materialYou = false;
  } else {
    const next = list[Math.min(idx, list.length - 1)];
    config.background.activeId = next.id;
    config.background.image = "";
    config.materialSeed = next.seed;
  }
  saveNow();
  render();
  applyMaterialPreview();
  setStatus("壁纸已移除", "ok");
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(new Error("文件读取失败"));
    fr.readAsDataURL(file);
  });

const applyCropView = (): void => {
  if (!cropState) return;
  const c = cropState;
  const scale = c.baseScale * c.zoom;
  const w = c.nw * scale;
  const h = c.nh * scale;
  const minX = c.stageW - w;
  const minY = c.stageH - h;
  c.x = Math.min(0, Math.max(minX, c.x));
  c.y = Math.min(0, Math.max(minY, c.y));
  const media = c.kind === "video" ? els.cropVideo : els.cropImage;
  media.style.width = `${w}px`;
  media.style.height = `${h}px`;
  media.style.left = `${c.x}px`;
  media.style.top = `${c.y}px`;
  els.cropZoom.value = String(Math.round(c.zoom * 100));
  els.cropZoomVal.textContent = `${Math.round(c.zoom * 100)}%`;
};

const openCrop = async (dataUrl: string, name: string, kind: WallpaperKind, nw: number, nh: number, targetId = ""): Promise<void> => {
  cropState = null;
  cropSaving = false;
  cropTargetId = targetId;
  cropDrag = null;
  const isVideo = kind === "video";
  els.cropImage.hidden = isVideo;
  els.cropVideo.hidden = !isVideo;
  if (isVideo) {
    els.cropVideo.src = dataUrl;
    els.cropVideo.currentTime = 0;
    els.cropVideo.play?.().catch(() => {});
  } else {
    els.cropImage.src = dataUrl;
    try {
      await els.cropImage.decode();
    } catch (e) {
      setStatus("图片解码失败，换一张试试", "err");
      return;
    }
  }
  if (!nw || !nh) {
    setStatus("无法读取媒体尺寸", "err");
    return;
  }
  els.cropDialog.showModal();
  const stage = els.cropStage.getBoundingClientRect();
  if (!stage.width || !stage.height) {
    els.cropDialog.close();
    setStatus("无法读取裁剪区域", "err");
    return;
  }
  const baseScale = Math.max(stage.width / nw, stage.height / nh);
  cropState = {
    dataUrl, name, kind, nw, nh, baseScale, zoom: 1,
    x: (stage.width - nw * baseScale) / 2,
    y: (stage.height - nh * baseScale) / 2,
    stageW: stage.width, stageH: stage.height,
  };
  applyCropView();
};

els.cropZoom.addEventListener("input", () => {
  if (!cropState) return;
  const c = cropState;
  const oldScale = c.baseScale * c.zoom;
  const cx = c.x + (c.nw * oldScale) / 2;
  const cy = c.y + (c.nh * oldScale) / 2;
  c.zoom = Math.max(1, Math.min(3, Number(els.cropZoom.value) / 100));
  const newScale = c.baseScale * c.zoom;
  c.x = cx - (c.nw * newScale) / 2;
  c.y = cy - (c.nh * newScale) / 2;
  applyCropView();
});

els.cropStage.addEventListener("pointerdown", (e) => {
  if (!cropState) return;
  cropDrag = { sx: e.clientX, sy: e.clientY, x: cropState.x, y: cropState.y };
  els.cropStage.setPointerCapture?.(e.pointerId);
});

els.cropStage.addEventListener("pointermove", (e) => {
  if (!cropState || !cropDrag) return;
  cropState.x = cropDrag.x + (e.clientX - cropDrag.sx);
  cropState.y = cropDrag.y + (e.clientY - cropDrag.sy);
  applyCropView();
});

const endCropDrag = (e: PointerEvent): void => {
  cropDrag = null;
  try {
    els.cropStage.releasePointerCapture?.(e.pointerId);
  } catch (err) {}
};
els.cropStage.addEventListener("pointerup", endCropDrag);
els.cropStage.addEventListener("pointercancel", endCropDrag);

els.cropCancel.addEventListener("click", () => {
  cropState = null;
  cropTargetId = "";
  els.cropDialog.close();
});

els.cropSave.addEventListener("click", () => {
  if (!cropState || cropSaving) return;
  const c = cropState;
  const scale = c.baseScale * c.zoom;
  const sx = Math.max(0, -c.x / scale);
  const sy = Math.max(0, -c.y / scale);
  const sw = Math.min(c.nw - sx, c.stageW / scale);
  const sh = Math.min(c.nh - sy, c.stageH / scale);
  const crop: WallpaperCrop = {
    x: Math.max(0, Math.min(1, sx / c.nw)),
    y: Math.max(0, Math.min(1, sy / c.nh)),
    w: Math.max(0.05, Math.min(1, sw / c.nw)),
    h: Math.max(0.05, Math.min(1, sh / c.nh)),
  };
  cropSaving = true;
  els.cropSave.disabled = true;
  els.cropSave.classList.add("loading");
  els.cropSave.setAttribute("aria-busy", "true");
  els.cropCancel.disabled = true;
  void (async () => {
    try {
      const seed = c.kind === "video" ? await seedFromVideo(c.dataUrl) : ((await seedFromImage(c.dataUrl)) || "#cba6f7");
      if (cropTargetId) {
        const wp = config.background.wallpapers.find((w) => w.id === cropTargetId);
        if (wp) {
          wp.crop = crop;
          wp.seed = seed;
          config.background.activeId = wp.id;
          config.background.image = "";
          config.materialSeed = seed;
          saveNow();
          render();
          applyMaterialPreview();
          setStatus("已重新裁剪 · 原图保留", "ok");
        }
        cropTargetId = "";
        els.cropDialog.close();
        cropState = null;
        return;
      }
      if (await addWallpaper(c.dataUrl, c.name, c.kind, seed, crop, c.nw, c.nh)) {
        setStatus("壁纸已添加 · 原图保留，裁剪只记录区域", "ok");
        els.cropDialog.close();
        cropState = null;
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "裁剪处理失败", "err");
    } finally {
      cropSaving = false;
      els.cropSave.disabled = false;
      els.cropSave.classList.remove("loading");
      els.cropSave.removeAttribute("aria-busy");
      els.cropCancel.disabled = false;
    }
  })();
});

els.cropDialog.addEventListener("close", () => {
  cropState = null;
  cropTargetId = "";
  cropDrag = null;
});

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
      void hydrateMedia();
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
    void hydrateMedia();
    setStatus("已同步弹窗开关", "ok");
  });
} catch (e) {}

els.pickImage.addEventListener("click", () => els.bgFile.click());

els.bgFile.addEventListener("change", async () => {
  const file = els.bgFile.files?.[0];
  els.bgFile.value = "";
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  if (!file.type.startsWith("image/") && !isVideo) {
    setStatus("请选择图片、GIF 或视频文件", "err");
    return;
  }
  const kind: WallpaperKind = isVideo ? "video" : file.type === "image/gif" ? "gif" : "image";
  els.pickImage.disabled = true;
  setStatus(isVideo ? "正在读取视频…" : "正在读取图片…");
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const { w, h } = await mediaDimensions(dataUrl, kind);
    const seed = kind === "video" ? await seedFromVideo(dataUrl) : ((await seedFromImage(dataUrl)) || "#cba6f7");
    await openCrop(dataUrl, file.name.replace(/\.[^.]+$/, ""), kind, w, h);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "媒体读取失败", "err");
  } finally {
    els.pickImage.disabled = false;
  }
});

els.removeBg.addEventListener("click", () => {
  const active = activeWallpaper(config);
  if (active) removeWallpaper(active.id);
});

els.materialYou.addEventListener("change", () => {
  const active = activeWallpaper(config);
  config.materialYou = els.materialYou.checked && !!active?.seed;
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

els.bgTransition.addEventListener("change", () => {
  config.background.transition = els.bgTransition.value as BackgroundTransition;
  saveNow();
  const label = els.bgTransition.selectedOptions[0]?.textContent || "随机";
  setStatus(`过渡效果：${label}`, "ok");
});

els.bgTransitionDuration.addEventListener("change", () => {
  const ms = Number(els.bgTransitionDuration.value) || 1500;
  config.background.transitionDuration = Math.min(4000, Math.max(500, Math.round(ms)));
  saveNow();
  const label = els.bgTransitionDuration.selectedOptions[0]?.textContent || `${ms} 毫秒`;
  setStatus(`过渡速度：${label}`, "ok");
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
