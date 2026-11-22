/**
 * 页面域 IndexedDB 媒体缓存。
 *
 * chrome.storage 里仍存壁纸 data URL（兼容旧版本/设置页），但页面只缓存一次：
 * 之后切换壁纸只传 mediaKey，页面从 IDB 取 Blob -> object URL，避免每次切图
 * 都把几十 MB 的字符串从 isolated world 复制到 MAIN world。
 */

const DB_NAME = "fuckTougeMediaV1";
const STORE = "media";
let dbPromise: Promise<IDBDatabase | null> | null = null;

const openDb = (): Promise<IDBDatabase | null> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  const current = dbPromise;
  // 打开失败时清掉缓存的 rejected/null promise，允许下一次调用重试
  void current.then((db) => {
    if (!db && dbPromise === current) dbPromise = null;
  });
  return current;
};

export async function getCachedMedia(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

export async function putCachedMedia(key: string, blob: Blob): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) {
      resolve(false);
    }
  });
}


/** 返回不在有效列表里的页面缓存 key（纯函数，便于回归测试）。 */
export const staleMediaKeys = (keys: readonly unknown[], validKeys: Iterable<string>): string[] => {
  const keep = new Set(validKeys);
  return keys.filter((key): key is string => typeof key === "string" && !keep.has(key));
};

/** 删除不在有效壁纸列表中的页面缓存；只动页面 IDB，不碰 chrome.storage */
export async function pruneCachedMedia(validKeys: Iterable<string>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const keep = new Set(validKeys);
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        for (const key of staleMediaKeys(req.result, keep)) store.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

/** data URL -> Blob；只在首次拉取某个 mediaKey 时走一次 */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(0, comma);
    const body = dataUrl.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      const mime = meta.slice(5).replace(/;base64.*$/i, "") || "application/octet-stream";
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    const res = await fetch(dataUrl);
    if (!res.ok) return null;
    return await res.blob();
  } catch (e) {
    return null;
  }
}
