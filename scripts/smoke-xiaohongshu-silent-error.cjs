/** 验证静默错误仍会上报，且不会走错误卡片渲染与发送。先运行 npm run build。 */
const assert = require('node:assert/strict')

const report = require('../lib/karin/module/utils/ErrorReport.js')
const render = require('../lib/karin/module/utils/ErrorHandler/render.js')
let uploads = 0
report.uploadErrorReport = async () => {
  uploads++
  return { id: 'test', url: 'https://example.invalid/test' }
}
render.renderErrorImage = async () => {
  throw new Error('静默模式不应渲染错误卡片')
}

const { handleBusinessError } = require('../lib/karin/module/utils/ErrorHandler/handler.js')
handleBusinessError(new Error('测试解析失败'), { businessName: '小红书视频解析', silentErrorReport: true }, [], { bot: {} })
  .then((result) => {
    assert.equal(result, 'handled')
    assert.equal(uploads, 1)
    console.log('小红书静默错误上报：通过')
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
