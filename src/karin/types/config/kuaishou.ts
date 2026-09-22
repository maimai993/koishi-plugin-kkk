export interface kuaishouConfig {
  /** 快手解析开关，单独开关，受「总开关」影响 */
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

  /** 快手评论解析，发送快手作品评论图 */
  comment: boolean

  /** 快手评论数量，范围1~30条 */
  numcomment: number
}
