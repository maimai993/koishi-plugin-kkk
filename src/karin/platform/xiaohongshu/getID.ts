import axios from 'node-karin/axios'
import { normalizeXiaohongshuLink, pickXiaohongshuToken } from './link'

export interface XiaohongshuIdData {
  type: 'note' | 'unknown'
  [x: string]: any
}

/**
 * 解析小红书分享链接，提取作品ID
 * - 典型长链接: https://www.xiaohongshu.com/explore/<note_id>
 * - 短链: https://xhslink.com/<code>、https://xhslink.cn/o/<code>（会重定向到长链接）
 */
export const getXiaohongshuID = async (url: string, log = true): Promise<XiaohongshuIdData> => {
  const sourceLink = normalizeXiaohongshuLink(url)
  const resp = await axios.get(sourceLink, {
    headers: {
      'User-Agent': 'Apifox/1.0.0 (https://apifox.com)'
    }
  })
  const longLink = resp?.request?.res?.responseUrl ?? sourceLink
  // 最终地址也可能来自 HTML 转义后的卡片链接
  const normalizedLink = normalizeXiaohongshuLink(longLink)

  const effectiveLink = (() => {
    try {
      const u = new URL(normalizedLink)
      if (u.pathname.startsWith('/404')) {
        const rp = u.searchParams.get('redirectPath')
        if (rp) {
          try {
            return decodeURIComponent(rp)
          } catch {
            return rp
          }
        }
      }
      const mm = /[?&]redirectPath=([^&#]+)/.exec(normalizedLink)
      if (mm?.[1]) {
        try {
          return decodeURIComponent(mm[1])
        } catch {
          return mm[1]
        }
      }
      return normalizedLink
    } catch {
      const mm = /[?&]redirectPath=([^&#]+)/.exec(normalizedLink)
      if (mm?.[1]) {
        try {
          return decodeURIComponent(mm[1])
        } catch {
          return mm[1]
        }
      }
      return normalizedLink
    }
  })()

  const finalToken = pickXiaohongshuToken(effectiveLink, normalizedLink, sourceLink)

  let result: XiaohongshuIdData = { type: 'unknown' }

  switch (true) {
    case /xiaohongshu\.com\/discovery\/item\/([0-9a-zA-Z]+)/.test(effectiveLink): {
      const m = /xiaohongshu\.com\/discovery\/item\/([0-9a-zA-Z]+)/.exec(effectiveLink)
      result = {
        type: 'note',
        note_id: m ? m[1] : undefined,
        xsec_token: finalToken
      }
      break
    }

    case /xiaohongshu\.com\/explore\/([0-9a-zA-Z]+)/.test(effectiveLink): {
      const m = /xiaohongshu\.com\/explore\/([0-9a-zA-Z]+)/.exec(effectiveLink)
      result = {
        type: 'note',
        note_id: m ? m[1] : undefined,
        xsec_token: finalToken
      }
      break
    }
    case /[?&]target_note_id=([0-9a-zA-Z]+)/.test(effectiveLink) || /[?&]target_note_id=([0-9a-zA-Z]+)/.test(normalizedLink): {
      // 笔记暂不可查看等场景会跳到 /explore?...&target_note_id=<note_id>，路径里没有 ID
      const m = /[?&]target_note_id=([0-9a-zA-Z]+)/.exec(effectiveLink) ?? /[?&]target_note_id=([0-9a-zA-Z]+)/.exec(normalizedLink)
      result = {
        type: 'note',
        note_id: m ? m[1] : undefined,
        xsec_token: finalToken
      }
      break
    }
    default:
      result = { type: 'unknown' }
      break
  }

  if (result.type === 'unknown') {
    throw new Error('无法从链接中提取小红书笔记ID')
  }

  if (log) console.log({ type: result.type, note_id: result.note_id, xsec_token: finalToken ? '有' : '（空）' })
  return result
}
