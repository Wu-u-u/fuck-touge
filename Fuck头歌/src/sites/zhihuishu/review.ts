/** 已完成课程复习的纯逻辑：便于单测，不依赖 DOM。 */

export interface ReviewDecision {
  reviewCompleted: boolean;
  autoNext: boolean;
  platformCompleted: boolean;
  lessonKey: string;
  /** 本次页面会话里已经从头重启过的课程 key */
  restartedKey: string;
}

export const isVideoAtEnd = (currentTime: number, duration: number, ended: boolean): boolean =>
  ended || (Number.isFinite(duration) && duration > 0 && currentTime >= duration - 1);

/** 已完成课程第一次进入复习时，应先把进度拉回 0，而不是直接跳下一节。 */
export const shouldRestartReview = (d: ReviewDecision): boolean =>
  d.reviewCompleted && d.autoNext && d.platformCompleted
  && !!d.lessonKey && d.lessonKey !== d.restartedKey;

/**
 * 平台进度条在复习重启后仍可能是 100%，不能仅凭 completed 就跳下一节；
 * 同一节已经从头重启过时，要等视频真正播到结尾。
 */
export const shouldAdvanceOnComplete = (
  reviewCompleted: boolean,
  lessonKey: string,
  restartedKey: string,
  atEnd: boolean,
): boolean => !reviewCompleted || !lessonKey || lessonKey !== restartedKey || atEnd;
