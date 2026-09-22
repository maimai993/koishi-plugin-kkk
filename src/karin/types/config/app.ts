/** 定义视频解析工具的配置接口 */
export interface appConfig {
  /** 默认解析，即识别最高优先级，修改后重启生效 */
  videoTool: boolean

  /** 自定义优先级，「默认解析」关闭后才会生效。修改后重启生效 */
  priority: number

  /** 缓存自动删除，非必要不修改！ */
  removeCache: boolean

  /**
   * 优先渲染器。
   *
   * - `shotkit`（默认）：shotkit 内核，不依赖浏览器、单张几十毫秒、内存低；
   *   但预编译内核在 Windows 上加载不了 https 资源，远程封面/头像会缺图；
   * - `puppeteer`：浏览器（Chrome / Edge），完整渲染、远程资源正常。
   */
  renderer: 'shotkit' | 'puppeteer'

  /**
   * 渲染精度，可选值50~200，建议100。设置高精度会提高图片的精细度，过高可能会影响渲染与发送速度。
   *
   * 这是**起点**，不是死值：内核在 1x / 2x 下走的渲染路径不同，谁快看内容（实测评论卡 1x 快 2.7 倍、
   * 小红书笔记卡 2x 快 3 倍），所以每条路由会各测一次（第一次用这里的倍率，第二次换另一档），
   * 之后固定用快的那档。设成 50（只要 1x）时不测，直接听配置。
   */
  renderScale: number

  /**
   * 全屏 SVG 噪点层的处理方式（性能开关，静默生效，面板里没有这一项）。
   *
   * 模板每张卡片都铺了一层 `feTurbulence` 全屏噪声。shotkit 是软件光栅化，
   * 这层要按设备像素逐个生成噪声：实测 2880x4036 的卡片原样 **31.1s**，
   * 去掉后 **2.8s** —— 九成耗时在这里，而画面差异只有 ±4/255（看不出来）。
   *
   * - `'off'`（默认）：整层删掉，最快；
   * - `'tile'`：换成一枚 160x160 的噪点小图平铺，保住颗粒感（约 3.5s）；
   * - `'keep'`：保留原样（老行为，shotkit 下单张卡片 30s 起步）。
   */
  noiseOverlay: 'off' | 'tile' | 'keep'

  /** 渲染图片的主题色，0为自动，1为浅色，2为深色，3为智能场景（实验性，支持封面的模板会根据封面判断深浅色） */
  Theme: number

  /** 封面氛围背景参数：控制封面图对模板背景氛围的贡献度，取值均为 0~1 */
  ambientCover: {
    /** 模糊封面层不透明度：封面色强度总闸，越大整体越浓 */
    coverOpacity: number
    /** 主题色压色罩两端（顶/底）不透明度 */
    overlayEdgeOpacity: number
    /** 主题色压色罩中间带不透明度，越小封面色越透 */
    overlayMiddleOpacity: number
  }

  /** 渲染图片的等待时间，单位：秒；传递0可禁用 */
  RenderWaitTime: number

  /** 表情回应，若适配器不支持需要关闭 */
  EmojiReply: boolean

  /** 解析提示，发送提示信息："检测到xxx链接，开始解析" */
  parseTip: boolean

  /**
   * 解析结果合并转发。
   *
   * - **打开**：一次解析产生的所有内容（卡片、图片、视频、评论…）合并成**一条转发消息**发出，
   *   转发用触发者身份展示；过程提示（开始解析 / 下载中 / 发送中…）不会进转发；
   * - **关掉**：不合并，内容像以前一样一条一条发（用户实测反馈：「关闭合并转发 还是合并的」）。
   *
   * 只有支持合并转发的适配器有效果（QQ 官方适配器没有这个能力，会自动退化成逐条发送）。
   */
  fakeForward: boolean

  /**
   * **合并转发里包含哪些内容**（`fakeForward` 打开时才生效）。
   *
   * 取值参照各平台的「发送内容」，只是这里按**消息元素类型**分：
   *   - `'text'`     文字提示
   *   - `'image'`    图片（信息卡 / 评论卡 / 图集 / 切片）
   *   - `'video'`    视频
   *   - `'file'`     文件（群文件等）
   *
   * **没列出来的一律单独直发**。默认 `['text','image']`：
   * OneBot / NapCat 的转发节点装不下大体积载荷（实测 10.3MB 视频 base64 后约 13.7MB，
   * `send_group_forward_msg` 直接被拒）。要连视频一起进转发的就加上 `'video'`。
   *
   * **语音和 markdown 不在候选里**（配了也不生效）：QQ 的聊天记录不支持语音气泡；
   * markdown 只有官方 bot 认，而官方适配器根本没有合并转发能力。
   */
  forwardContent: Array<'text' | 'image' | 'video' | 'file'>

  // /**
  //  * 表情 ID
  //  * @see https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/external/face_config.json
  //  */
  // EmojiReplyID: number

  // /** 忽略表情回应失败，开启后表情回应失败时不会抛出错误 */
  // EmojiReplyIgnoreError: boolean

  /** 遇到错误时谁会收到错误日志：触发者 / 管理员（权限等级 > 4） */
  errorLogSendTo: Array<'trigger' | 'admin' | 'master' | 'allMasters'>

  /** 分页渲染，将模板渲染成多页的图片，以降低渲染器压力，默认开启，非必要不修改 */
  multiPageRender: boolean

  /** 分页渲染时，每页的高度，经测试最佳每页高度为12000px，默认12000px */
  multiPageHeight: number

  /** 解析包含 Live Photo 作品时，发送的静态图兼容系统
   * - 'google': Google Motion Photo 格式
   * - 'xiaomi': 小米实况照片格式，兼容小米（支持实况照片的任何版本）和 Google，但无法被 OPPO 识别
   * - 'oppo': OPPO 实况照片格式（推荐），兼容 OPPO、小米（较新版本）和 Google，兼容性最广
   * - 'huawei_honor': 华为/荣耀实况照片格式（理论可行但未实测，作者无对应设备）
   * 注：vivo（Origin OS）和 iPhone（iOS）需要独立的图片和同名视频文件，暂不支持
   */
  livePhotoSystem: 'google' | 'xiaomi' | 'oppo' | 'huawei_honor'

  /** 解析遇到实况图时的处理和发送方式
   * - 'video_and_livephoto': 生成并发送仿 iPhone Live Photo 播放效果的视频（播放三次，性能开销大，2C2G 服务器约 20s/张）+ 对应系统的实况图
   * - 'video_only': 仅生成并发送仿 iPhone Live Photo 播放效果的视频（播放三次，性能开销大，2C2G 服务器约 20s/张）
   * - 'livephoto_only': 仅生成并发送对应系统的实况图
   */
  livePhotoMode: 'video_and_livephoto' | 'video_only' | 'livephoto_only'

  /** 扫码登录时使用的地址类型，可选值：'lan'（局域网IP）、'external'（外部地址） */
  qrLoginAddrType: 'lan' | 'external'

  /** 外部访问地址（当 qrLoginAddrType 为 'external' 时使用，可以是公网IP或域名） */
  qrLoginExternalAddr: string

  // ============ 以下字段从 uploadConfig 合并 ============

  /**
   * 本地视频发送方式
   * - 'file': 使用 file 协议发送本地视频（需 Karin 与协议端在同一系统）
   * - 'base64': 转换为 base64 后发送（传输数据量增大约 30%，不在同一网络环境可能导致额外带宽成本）
   */
  videoSendMode: 'file' | 'base64'

  /** 视频上传拦截，开启后会根据视频文件大小判断是否需要上传，需配置「视频拦截阈值」。 */
  usefilelimit: boolean

  /** 视频拦截阈值，视频文件大于该数值则直接结束任务，不会上传，单位: MB，「视频上传拦截」开启后才会生效。 */
  filelimit: number

  /** 压缩视频，开启后会将视频文件压缩后再上传，适合上传大文件，任务过程中会吃满CPU，对低配服务器不友好。需配置「压缩触发阈值」与「压缩后的值」 */
  compress: boolean

  /** 压缩触发阈值，触发视频压缩的阈值，单位：MB。当文件大小超过该值时，才会压缩视频，「压缩视频」开启后才会生效 */
  compresstrigger: number

  /** 压缩后的值，单位：MB。若视频文件大小大于「压缩触发阈值」的值，则会进行压缩至该值（±5%），「压缩视频」开启后才会生效 */
  compressvalue: number

  /** 群文件上传，使用群文件上传，开启后会将视频文件上传到群文件中，需配置「群文件上传阈值」 */
  usegroupfile: boolean

  /** 群文件上传阈值，当文件大小超过该值时将使用群文件上传，单位：MB，「使用群文件上传」开启后才会生效 */
  groupfilevalue: number

  /**
   * 网络图片发送方式
   * - 'url': 直接传递 HTTP 链接给上游下载（可能因上游网络问题导致下载超时）
   * - 'file': 下载到本地使用 file 协议发送（需 Karin 与协议端在同一系统）
   * - 'base64': 下载后转换为 base64 发送（传输数据量增大约 30%，不在同一网络环境可能导致额外带宽成本）
   */
  imageSendMode: 'url' | 'file' | 'base64'

  /** 下载限速开关，开启后会限制下载速度，避免触发服务器风控导致连接被重置 */
  downloadThrottle: boolean

  /** 下载速度限制，单位：MB/s，0 表示不限速。建议设置为 5-20 之间，过高可能触发风控 */
  downloadMaxSpeed: number

  /** 断流自动降速，当检测到连接被重置时自动降低下载速度 */
  downloadAutoReduce: boolean

  /** 最低下载速度，单位：MB/s，自动降速时不会低于此值 */
  downloadMinSpeed: number
}
