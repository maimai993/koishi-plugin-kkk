import https from 'node:https'

import { logger } from 'node-karin'
import axios from 'node-karin/axios'

import { bilibiliFetcher } from '@/module/utils/amagiClient'
import type { BilibiliDataTypes } from '@/types'

export interface BilibiliId {
  type: BilibiliDataTypes[keyof BilibiliDataTypes]
  [x: string]: any
}

/**
 * return aweme_id
 * @param {string} url 分享连接
 * @returns
 */
export const getBilibiliID = async (url: string) => {
  // 如果是专栏链接且带有 opus_fallback 参数，先去掉参数让它自然重定向
  if (/\/read\/cv\d+/.test(url) && url.includes('opus_fallback')) {
    url = url.split('?')[0]
  }

  // 之前这里既没有超时、也没指定 IP 协议族：
  //   - timeout:0 → 连接被重置/卡住时会**无限等**（表现就是「开始解析」后一直没反应）
  //   - 没有 family:4 → Node 会先试 IPv6，这台机器上 bilibili 的 IPv6 会 ECONNRESET
  // 现在：强制 IPv4 + 15 秒超时 + 失败重试一次
  const request = (target: string) => axios.get(target, {
    timeout: 15000,
    maxRedirects: 5,
    httpsAgent: new https.Agent({ family: 4, keepAlive: true }),
    headers: {
      'User-Agent': 'Apifox/1.0.0 (https://apifox.com)'
    }
  })
  let resp
  try {
    resp = await request(url)
  } catch (error: any) {
    logger.warn('[B站解析] 首次请求失败（%s），用 IPv4 重试一次', error?.code ?? error?.message ?? error)
    resp = await request(url)
  }
  const longLink = resp?.request?.res?.responseUrl ?? resp?.config?.url ?? url
  let result = {} as BilibiliId
  let pValue: number | undefined
  const parsedUrl = new URL(longLink)
  const pParam = parsedUrl.searchParams.get('p')
  if (pParam) {
    pValue = parseInt(pParam, 10)
    if (isNaN(pValue)) {
      pValue = undefined
    }
  }
  const pathname = parsedUrl.pathname
  const hostname = parsedUrl.hostname

  switch (true) {
    case (hostname === 't.bilibili.com' && /^\/\d+/.test(pathname)) || (hostname === 'www.bilibili.com' && /^\/opus\/\d+/.test(pathname)): {
      const tMatch = hostname === 't.bilibili.com' ? pathname.match(/^\/(\d+)/) : null
      const opusMatch = hostname === 'www.bilibili.com' ? pathname.match(/^\/opus\/(\d+)/) : null
      const dynamic_id = tMatch ?? opusMatch
      result = {
        type: 'dynamic_info',
        dynamic_id: dynamic_id ? dynamic_id[1] : undefined
      }
      break
    }
    case /\/read\/cv(\d+)/.test(longLink): {
      const cvMatch = /\/read\/cv(\d+)/.exec(longLink)
      result = {
        type: 'dynamic_info',
        dynamic_id: cvMatch ? cvMatch[1] : undefined
      }
      break
    }
    case /\/bangumi\/play\/(\w+)/.test(longLink): {
      const playMatch = /\/bangumi\/play\/(\w+)/.exec(longLink)
      const id = playMatch ? playMatch[1] : ''
      let realid = ''
      let isEpid = false
      if (id.startsWith('ss')) {
        realid = id
      } else if (id.startsWith('ep')) {
        realid = id
        isEpid = true
      }
      result = {
        type: 'bangumi_video_info',
        isEpid,
        realid
      }
      break
    }
    case /(video\/|video-)([A-Za-z0-9]+)/.test(longLink): {
      const bvideoMatch = /video\/([A-Za-z0-9]+)|bvid=([A-Za-z0-9]+)/.exec(longLink)
      let bvid = bvideoMatch ? bvideoMatch[1] || bvideoMatch[2] : undefined

      if (bvid && bvid.toLowerCase().startsWith('av')) {
        const avid = parseInt(bvid.replace(/^av/i, ''))
        /**
         * av 号 → BV 号。
         *
         * **返回结构要逐层兜**：不同版本的 amagi 包了好几层，实测当前版本是
         * `{ success, data: { code, message, data: { bvid } }, message, code }` ——
         * 只取 `data.bvid` 会拿到 undefined，于是 `av` 链接被当成「没有 bvid 的视频」直接解析失败
         * （用户反馈：`/video/av117223783925866` 无法解析，而视频本身是好的）。
         * 取不到再退回官方接口 `/x/web-interface/view?aid=` 问一次，最后仍失败就明确报错，
         * 不要静默地带着 undefined 往下走。
         */
        const raw: any = await bilibiliFetcher.convertAvToBv({ avid })
        bvid = raw?.data?.bvid ?? raw?.data?.data?.bvid ?? raw?.bvid ?? raw?.data?.result?.bvid
        if (!bvid) {
          try {
            const { default: axios } = await import('axios')
            const res = await axios.get('https://api.bilibili.com/x/web-interface/view', {
              params: { aid: avid },
              timeout: 15000,
              headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' }
            })
            bvid = res.data?.data?.bvid
          } catch (error: any) {
            logger.warn('[B站] av 号转 BV 号失败（接口兜底也没成功）: av' + avid + ' ' + String(error?.message ?? error))
          }
        }
        if (!bvid) {
          throw new Error('这个 av 号没能转换成 BV 号（av' + avid + '），确认一下链接是否完整')
        }
      }

      result = {
        type: 'one_video',
        bvid,
        ...(pValue !== undefined && { p: pValue })
      }
      break
    }
    case /festival\/([A-Za-z0-9]+)/.test(longLink): {
      const festivalMatch = /festival\/([A-Za-z0-9]+)\?bvid=([A-Za-z0-9]+)/.exec(longLink)
      result = {
        type: 'one_video',
        id: festivalMatch ? festivalMatch[2] : undefined
      }
      break
    }
    case /play\/(\S+?)\??/.test(longLink): {
      const playMatch = /play\/(\w+)/.exec(longLink)
      const id = playMatch ? playMatch[1] : ''
      const isEpid = false
      if (id.startsWith('ss')) {
        result.realid = 'season_id'
      } else if (id.startsWith('ep')) {
        result.realid = 'ep_id'
      }
      result = {
        type: 'bangumi_video_info',
        isEpid,
        realid: playMatch ? playMatch[1] : ''
      }
      break
    }
    case /^https:\/\/t\.bilibili\.com\/(\d+)/.test(longLink) || /^https:\/\/www\.bilibili\.com\/opus\/(\d+)/.test(longLink): {
      const tMatch = /^https:\/\/t\.bilibili\.com\/(\d+)/.exec(longLink)
      const opusMatch = /^https:\/\/www\.bilibili\.com\/opus\/(\d+)/.exec(longLink)
      const dynamic_id = tMatch ?? opusMatch
      result = {
        type: 'dynamic_info',
        dynamic_id: dynamic_id ? dynamic_id[1] : dynamic_id
      }
      break
    }
    case longLink.includes('live.bilibili.com'): {
      const match = /https?:\/\/live\.bilibili\.com\/(\d+)/.exec(longLink)
      result = {
        type: 'live_room_detail',
        room_id: match ? match[1] : undefined
      }
      break
    }
    default:
      logger.warn('无法获取作品ID')
      break
  }

  console.log(result)
  return result
}
