/**
 * 错误处理中间件
 */

/**
 * 404 处理
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: '接口不存在',
    path: req.path,
    method: req.method
  })
}

/**
 * 全局错误处理
 */
export function errorHandler(err, req, res, next) {
  // 记录错误
  console.error('服务器错误:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  })

  // JSON 解析错误
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'JSON 格式错误',
      message: '请检查请求体的 JSON 格式'
    })
  }

  // 请求体过大
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: '请求体过大',
      message: '请求数据不能超过 1MB'
    })
  }

  // 速率限制错误
  if (err.status === 429) {
    return res.status(429).json({
      error: '请求过于频繁',
      message: '请稍后再试'
    })
  }

  // 默认错误响应
  res.status(err.status || 500).json({
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : '请稍后重试'
  })
}
