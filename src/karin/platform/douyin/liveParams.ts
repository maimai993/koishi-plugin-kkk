/**
 * 抖音直播间查询参数。
 *
 * `room_id` 从 amagi `7.0.0-beta.6` 起被标成**内部参数**（`InternalParam`），
 * 于是从对外参数类型里被排除掉了 —— 照原样写对象字面量过不了 tsc
 * （TS2353「对象字面量只能指定已知属性」）。
 *
 * **但那个标记只影响文档，不影响请求**：`internalParamKeysOf` 全仓唯一的调用点是
 * `parametersOf`，而那是给 OpenAPI 生成器过滤 query 参数用的。请求构建路径根本不读它
 * —— `douyin.liveRoomInfo` 的 `build` 里仍是 `getLiveRoomInfo(p)`，把整个 params
 * 原样交给 URL 构造，与升级前**一字不差**（两版端点定义唯一的区别就是这个标记）。
 *
 * 所以这里**保留传值**：`room_id` 来自用户资料里的真实房间号，行为与升级前一致，
 * 只是绕开类型。哪天确认 amagi 会自己从 `web_rid` 推导出 `room_id`，删掉第二项即可。
 *
 * @param webRid 直播间短号（分享链接里那段），必填
 * @param roomId 真实房间号，可选
 */
export const liveRoomParams = (webRid: string, roomId?: string): { web_rid: string } =>
  ({ room_id: roomId, web_rid: webRid }) as { web_rid: string }
