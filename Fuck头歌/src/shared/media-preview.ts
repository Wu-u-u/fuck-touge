/** 释放预览 <video> 的 src 并停止解码；隐藏元素也可能继续播放/占内存。 */
export function resetVideoElement(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch (e) {}
  video.removeAttribute("src");
  try {
    video.load();
  } catch (e) {}
}
