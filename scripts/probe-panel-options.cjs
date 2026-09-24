const fs = require('fs')
const file = process.argv[2]
const text = fs.readFileSync(file, 'utf8')
const keys = ['评论图', '解析时发送的内容', 'sendContent']
for (const key of keys) {
  let from = 0, count = 0
  while (count < 4) {
    const at = text.indexOf(key, from)
    if (at < 0) break
    console.log('--- ' + key + ' @' + at + ' ---')
    console.log(text.slice(Math.max(0, at - 240), at + 240).replace(/\n/g, ' '))
    from = at + key.length
    count++
  }
}
