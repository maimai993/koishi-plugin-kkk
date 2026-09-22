/** 卡片消息里的链接会把查询参数的 & 转成 HTML 实体。 */
export const normalizeXiaohongshuLink = (link: string): string => {
  const unescaped = link.replace(/&(?:amp|#0*38|#x0*26);/gi, '&')
  try {
    return decodeURIComponent(unescaped)
  } catch {
    return unescaped
  }
}

/** 跳转后的地址可能丢掉 xsec_token，因此按顺序回退到原分享链接。 */
export const pickXiaohongshuToken = (...links: string[]): string | undefined => {
  for (const link of links) {
    const normalized = normalizeXiaohongshuLink(link)
    try {
      const url = new URL(normalized)
      const token = url.searchParams.get('xsec_token') || url.searchParams.get('XSEC_TOKEN')
      if (token) return token
      const hashToken = /(?:^|[?&#])(?:xsec_token|XSEC_TOKEN)=([^&#]+)/.exec(url.hash)?.[1]
      if (hashToken) return hashToken
    } catch {
      const token = /(?:^|[?&#])(?:xsec_token|XSEC_TOKEN)=([^&#]+)/.exec(normalized)?.[1]
      if (token) return token
    }
  }
  return undefined
}
