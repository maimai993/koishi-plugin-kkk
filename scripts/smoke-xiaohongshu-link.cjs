/** 用截图中的 HTML 转义链接与跳转丢参场景验证 xsec_token 提取。 */
const assert = require('node:assert/strict')

;(async () => {
  const { normalizeXiaohongshuLink, pickXiaohongshuToken } = require('../lib/karin/platform/xiaohongshu/link.js')
  const axios = require('axios')
  const { getXiaohongshuID } = require('../lib/karin/platform/xiaohongshu/getID.js')
  const cardLink = 'https://www.xiaohongshu.com/discovery/item/abc123?app_platform=android&amp;ignoreEngage=true&amp;xsec_token=test-token%3D&amp;share_channel=qq'
  const token = 'test-token='

  assert.equal(new URL(normalizeXiaohongshuLink(cardLink)).searchParams.get('xsec_token'), token)
  assert.equal(pickXiaohongshuToken('https://www.xiaohongshu.com/404?target_note_id=abc123', cardLink), token)
  assert.equal(pickXiaohongshuToken('https://www.xiaohongshu.com/explore/abc?xsec_token=first', cardLink), 'first')
  assert.equal(pickXiaohongshuToken('https://www.xiaohongshu.com/explore/abc#?xsec_token=hash'), 'hash')
  assert.equal(pickXiaohongshuToken('https://www.xiaohongshu.com/explore/abc'), undefined)

  const originalGet = axios.get
  try {
    axios.get = async (requestedUrl) => {
      assert.equal(new URL(requestedUrl).searchParams.get('xsec_token'), token)
      return { request: { res: { responseUrl: 'https://www.xiaohongshu.com/discovery/item/abc123' } } }
    }
    assert.deepEqual(await getXiaohongshuID(cardLink, false), { type: 'note', note_id: 'abc123', xsec_token: token })
  } finally {
    axios.get = originalGet
  }
  console.log('小红书链接 xsec_token 提取：通过')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
