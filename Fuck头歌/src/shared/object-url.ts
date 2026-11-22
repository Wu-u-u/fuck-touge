/** 只 revoke 页面自己创建的 blob URL；data URL 等原样跳过。 */
export function releaseObjectUrls(urls: Iterable<string>): number {
  let count = 0;
  for (const url of urls) {
    if (typeof url !== "string" || !url.startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(url);
      count++;
    } catch (e) {}
  }
  return count;
}
