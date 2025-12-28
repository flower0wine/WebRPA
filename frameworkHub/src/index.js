/**
 * Web RPA 工作流仓库服务
 * 提供工作流的发布、查询、下载功能
 */

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { initDatabase } from './database.js'
import workflowRoutes from './routes/workflows.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { requestLogger } from './middleware/logger.js'

const app = express()
const PORT = process.env.PORT || 3000

// 安全中间件
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}))

// CORS 配置
app.use(cors({
  origin: '*', // 允许所有来源，因为是公共API
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Request-ID'],
  maxAge: 86400
}))

// 全局速率限制
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100, // 每个IP最多100次请求
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
})
app.use(globalLimiter)

// 请求体解析（限制大小）
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

// 请求日志
app.use(requestLogger)

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API 路由
app.use('/api/workflows', workflowRoutes)

// 404 处理
app.use(notFoundHandler)

// 错误处理
app.use(errorHandler)

// 启动服务器
async function start() {
  // 初始化数据库
  await initDatabase()

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║   🚀 Web RPA 工作流仓库服务已启动                           ║
║                                                            ║
║   地址: http://localhost:${PORT}                             ║
║   健康检查: http://localhost:${PORT}/health                  ║
║   API文档: http://localhost:${PORT}/api/workflows            ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `)
  })
}

start().catch(err => {
  console.error('启动失败:', err)
  process.exit(1)
})

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，正在关闭服务...')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('收到 SIGINT 信号，正在关闭服务...')
  process.exit(0)
})
