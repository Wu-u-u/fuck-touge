/**
 * 媒体异步加载完成后决定是否落入缓存。
 * 壁纸可能在 storage.get / dataUrlToBlob 期间被删除；此时新建的 blob URL 不能缓存，
 * 必须立即 revoke，否则会留下一个无人引用的 object URL。
 */
export function commitLoadedMedia(
  key: string,
  media: string,
  stillUsed: boolean,
  cache: Map<string, string>,
): string {
  if (!stillUsed) {
    if (media.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(media);
      } catch (e) {}
    }
    return "";
  }
  cache.set(key, media);
  return media;
}
