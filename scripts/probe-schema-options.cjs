const fs = require('fs')
const text = fs.readFileSync(process.argv[2], 'utf8')
for (const key of ['sendContent', 'default_config', 'yaml', 'YAML', 'extractOptions(']) {
  let from = 0, n = 0
  while (n < 3) {
    const at = text.indexOf(key, from)
    if (at < 0) break
    console.log('--- ' + key + ' @' + at + ' ---')
    console.log(text.slice(Math.max(0, at - 200), at + 200).replace(/\n/g, ' '))
    from = at + key.length; n++
  }
}
