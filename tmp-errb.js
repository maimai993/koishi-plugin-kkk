
(function () {
  if (window.__KKK_ERR_BOUNDARY__) return
  window.__KKK_ERR_BOUNDARY__ = true
  var shown = false
  function draw (title, detail) {
    if (shown) return
    shown = true
    try {
      var box = document.createElement('div')
      box.id = 'kkk-error-boundary'
      box.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:14px 18px;' + 'background:#3a1d1d;color:#ffd7d7;font:13px/1.7 system-ui,-apple-system,sans-serif;' + 'border-bottom:1px solid #7a3a3a;white-space:pre-wrap;word-break:break-word'
      var head = document.createElement('div')
      head.style.cssText = 'font-weight:600;margin-bottom:4px'
      head.textContent = title
      var body = document.createElement('div')
      body.style.cssText = 'opacity:.9'
      body.textContent = detail
      var tip = document.createElement('div')
      tip.style.cssText = 'margin-top:6px;opacity:.75'
      tip.textContent = '面板还能继续用，刷新一下即可恢复。如果反复出现，把上面这行错误发给插件作者。'
      var again = document.createElement('button')
      again.textContent = '重新加载面板'
      again.style.cssText = 'margin-top:10px;padding:6px 14px;border:0;border-radius:6px;background:#c05555;color:#fff;cursor:pointer'
      again.onclick = function () { location.reload() }
      box.appendChild(head); box.appendChild(body); box.appendChild(tip); box.appendChild(again)
      document.body.appendChild(box)
    } catch (error) { /* 连兜底都失败就算了 */ }
  }
  window.addEventListener('error', function (event) {
    var msg = (event && (event.message || (event.error && event.error.message))) || '未知错误'
    draw('面板出错了（已捕获，不会黑屏）', String(msg))
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    draw('面板出错了（已捕获，不会黑屏）', String((reason && reason.message) || reason || '未知错误'))
  })
})()
