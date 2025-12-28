/**
 * 请求日志中间件
 */

import { anonymizeIP, getClientIP } from '../utils/ip.js'

/**
 * 请求日志记录
 */
export function requestLogger(req, res, next) {
  const startTime = Date.now()
  const clientIP = getClientIP(req)

  // 响应完成后记录日志
  res.on('finish', () => {
    const duration = Date.now() - startTime
    const logData = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: anonymizeIP(clientIP),
      userAgent: (req.get('User-Agent') || '').substring(0, 100)
    }

    // 根据状态码选择日志级别
    if (res.statusCode >= 500) {
      console.error('❌ 请求错误:', logData)
    } else if (res.statusCode >= 400) {
      console.warn('⚠️ 请求警告:', logData)
    } else if (process.env.NODE_ENV === 'development') {
      console.log('✅ 请求完成:', logData)
    }
  })

  next()
}
