/** 小红书配置 */
export interface xiaohongshuConfig {
  /** 是否开启小红书解析功能 */
  switch: boolean
  /**
   * **本平台单独打开合并转发**（全局 `app.fakeForward` 关着时才生效；全局打开 → 全局优先）。
   * 默认 false：装完不配置就是一条一条发。
   */
  forward: boolean

  /**
   * **本平台合并转发里包含哪些内容**（留空 = 用全局 `app.forwardContent` 那份）：
   * text 文字 / image 图片 / video 视频 / file 文件。
   * 没列出来的内容单独直发。
   */
  forwardContent: Array<'text' | 'image' | 'video' | 'file'>

  /** 解析时发送的内容，可选值：'info'(笔记、视频信息)、'comment'(评论图片)、'image'(笔记图片)、'video'(视频文件) */
  sendContent: ('info' | 'comment' | 'image' | 'video')[]

  /** 小红书评论数量 */
  numcomment: number

  /**
   * 视频画质偏好设置，'adapt' 为自动根据「maxAutoVideoSize」大小选择，其他为固定画质
   * - '540p': 540P 标清
   * - '720p': 720P 高清
   * - '1080p': 1080P 超清
   * - '2k': 2K 超高清
   * - '4k': 4K 超高清
   */
  videoQuality: 'adapt' | '540p' | '720p' | '1080p' | '2k' | '4k'

  /** 视频体积上限，自动画质模式下可接受的最大视频大小（单位：MB），仅在 「videoQuality」 为 'adapt' 时生效 */
  maxAutoVideoSize: number
}
