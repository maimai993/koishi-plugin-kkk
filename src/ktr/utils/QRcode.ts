/**
 * Koishi 移植：\`@ikenxuan/qrcode\` 是 ESM-only 包（exports 里没有 require 条件），
 * 而模板组件在 react-dom/server 的**同步渲染**里调用本函数，没法 await import。
 * 因此改为「渲染入口预先异步加载好生成器，这里同步取用」。
 */
type GenerateSync = (options: Record<string, unknown>, format: string, output: string) => string

let generateSyncImpl: GenerateSync | undefined

/** 由渲染入口在 SSR 之前注入（见 module/utils/Render/index.ts） */
export const setQrcodeGenerator = (impl: GenerateSync) => {
  generateSyncImpl = impl
}

/** 生成器是否已就绪 */
export const hasQrcodeGenerator = () => typeof generateSyncImpl === 'function'

/**
 * Generates a QR code image in base64 format for the given text.
 *
 * @param {string} text - The text to encode in the QR code.
 * @param {boolean} [useDarkTheme=false] - Whether to use a dark theme for the QR code.
 * @param {Uint8Array} [image] - Optional binary logo image embedded in the center of the QR code.
 * @return {string} The base64-encoded QR code image.
 */
export const generateQRCode = (text: string, useDarkTheme: boolean = false, image?: Uint8Array) => {
  if (typeof generateSyncImpl !== 'function') {
    throw new Error('二维码生成器未初始化（@ikenxuan/qrcode 未加载）')
  }
  const hasImage = Boolean(image?.byteLength)
  const base64 = generateSyncImpl(
    {
      data: text,
      size: 1000,
      dotsOptions: {
        dotType: 'extra-rounded',
        color: useDarkTheme ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)'
      },
      cornersSquareOptions: {
        cornerType: 'dot',
        color: useDarkTheme ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)'
      },
      cornersDotOptions: {
        cornerType: 'dot',
        color: useDarkTheme ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)'
      },
      backgroundOptions: {
        transparent: true
      },
      image: hasImage ? image : undefined,
      imageOptions: hasImage
        ? {
            imageSize: 0.2,
            margin: 24,
            round: 0.2,
            hideBackgroundDots: true
          }
        : undefined
    },
    'webp',
    'base64'
  )

  return `data:image/webp;base64,${base64}`
}
