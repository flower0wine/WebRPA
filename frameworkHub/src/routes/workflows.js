/**
 * 工作流 API 路由
 */

import { Router } from 'express'
import { body, query, param, validationResult } from 'express-validator'
import rateLimit from 'express-rate-limit'
import { v4 as uuidv4 } from 'uuid'
import xss from 'xss'
import db from '../database.js'
import { calculateWorkflowHash, validateWorkflowContent, sanitizeWorkflow } from '../utils/workflow.js'
import { getClientIP } from '../utils/ip.js'

const router = Router()

// 发布工作流的速率限制（更严格）
const publishLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1小时
  max: 10, // 每个IP每小时最多发布10个
  message: { error: '发布过于频繁，请1小时后再试' }
})

// 下载速率限制
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 30, // 每分钟最多30次下载
  message: { error: '下载过于频繁，请稍后再试' }
})

// XSS 过滤配置
const xssOptions = {
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script']
}

/**
 * 获取工作流列表
 * GET /api/workflows
 */
router.get('/',
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('category').optional().isString().trim(),
    query('search').optional().isString().trim(),
    query('sort').optional().isIn(['newest', 'popular', 'downloads'])
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误', details: errors.array() })
    }

    const page = req.query.page || 1
    const limit = req.query.limit || 20
    const offset = (page - 1) * limit
    const category = req.query.category
    const search = req.query.search
    const sort = req.query.sort || 'newest'

    let whereClause = 'WHERE is_active = 1'
    const params = []

    if (category && category !== '全部') {
      whereClause += ' AND category = ?'
      params.push(category)
    }

    if (search) {
      whereClause += ' AND (name LIKE ? OR description LIKE ? OR tags LIKE ?)'
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern)
    }

    // 排序
    let orderClause = 'ORDER BY created_at DESC'
    if (sort === 'popular') {
      orderClause = 'ORDER BY download_count DESC, created_at DESC'
    } else if (sort === 'downloads') {
      orderClause = 'ORDER BY download_count DESC'
    }

    // 获取总数
    const countStmt = db.prepare(`SELECT COUNT(*) as total FROM workflows ${whereClause}`)
    const { total } = countStmt.get(...params)

    // 获取列表
    const listStmt = db.prepare(`
      SELECT id, name, description, author, category, tags, node_count, download_count, created_at
      FROM workflows
      ${whereClause}
      ${orderClause}
      LIMIT ? OFFSET ?
    `)
    const workflows = listStmt.all(...params, limit, offset)

    res.json({
      workflows: workflows.map(w => ({
        ...w,
        tags: w.tags ? w.tags.split(',').filter(Boolean) : []
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  }
)

/**
 * 获取分类列表
 * GET /api/workflows/categories
 */
router.get('/categories', (req, res) => {
  const stmt = db.prepare(`
    SELECT category, COUNT(*) as count 
    FROM workflows 
    WHERE is_active = 1 
    GROUP BY category 
    ORDER BY count DESC
  `)
  const categories = stmt.all()
  
  res.json({
    categories: [
      { name: '全部', count: categories.reduce((sum, c) => sum + c.count, 0) },
      ...categories.map(c => ({ name: c.category, count: c.count }))
    ]
  })
})

/**
 * 获取单个工作流详情
 * GET /api/workflows/:id
 */
router.get('/:id',
  [param('id').isUUID()],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '无效的工作流ID' })
    }

    const stmt = db.prepare(`
      SELECT id, name, description, author, category, tags, content, node_count, download_count, created_at
      FROM workflows
      WHERE id = ? AND is_active = 1
    `)
    const workflow = stmt.get(req.params.id)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    res.json({
      ...workflow,
      tags: workflow.tags ? workflow.tags.split(',').filter(Boolean) : [],
      content: JSON.parse(workflow.content)
    })
  }
)

/**
 * 下载工作流（增加下载计数）
 * POST /api/workflows/:id/download
 */
router.post('/:id/download',
  downloadLimiter,
  [param('id').isUUID()],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '无效的工作流ID' })
    }

    const workflowId = req.params.id
    const clientIP = getClientIP(req)

    // 检查工作流是否存在
    const checkStmt = db.prepare('SELECT id, content FROM workflows WHERE id = ? AND is_active = 1')
    const workflow = checkStmt.get(workflowId)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    // 检查是否在短时间内已下载过（防止刷下载量）
    const recentDownload = db.prepare(`
      SELECT id FROM download_logs 
      WHERE workflow_id = ? AND ip_address = ? 
      AND downloaded_at > datetime('now', '-1 hour')
    `).get(workflowId, clientIP)

    if (!recentDownload) {
      // 记录下载并增加计数
      try {
        db.prepare('INSERT INTO download_logs (workflow_id, ip_address) VALUES (?, ?)').run(workflowId, clientIP)
        db.prepare('UPDATE workflows SET download_count = download_count + 1 WHERE id = ?').run(workflowId)
      } catch (e) {
        // 忽略重复插入错误
      }
    }

    res.json({
      success: true,
      content: JSON.parse(workflow.content)
    })
  }
)

/**
 * 发布工作流
 * POST /api/workflows
 */
router.post('/',
  publishLimiter,
  [
    body('name')
      .isString()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('名称长度应在2-50个字符之间'),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 })
      .withMessage('描述不能超过500个字符'),
    body('author')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 30 })
      .withMessage('作者名不能超过30个字符'),
    body('category')
      .optional()
      .isString()
      .trim()
      .isIn(['数据采集', '自动化操作', '表单填写', 'AI应用', '定时任务', '其他'])
      .withMessage('无效的分类'),
    body('tags')
      .optional()
      .isArray({ max: 5 })
      .withMessage('标签最多5个'),
    body('tags.*')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 20 })
      .withMessage('单个标签不能超过20个字符'),
    body('content')
      .exists()
      .custom((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('工作流内容必须是对象')
        }
        return true
      }),
    body('clientId')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
      .withMessage('无效的客户端ID')
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数验证失败', details: errors.array() })
    }

    const { name, description, author, category, tags, content, clientId } = req.body
    const clientIP = getClientIP(req)
    const userAgent = req.get('User-Agent') || ''

    // 验证工作流内容
    const validation = validateWorkflowContent(content)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    // 清理和标准化工作流内容
    const sanitizedContent = sanitizeWorkflow(content)

    // 计算哈希值
    const hash = calculateWorkflowHash(sanitizedContent)

    // 检查是否已存在相同的工作流
    const existingStmt = db.prepare('SELECT id, name FROM workflows WHERE hash = ?')
    const existing = existingStmt.get(hash)

    if (existing) {
      return res.status(409).json({
        error: '该工作流已存在于仓库中',
        existingId: existing.id,
        existingName: existing.name
      })
    }

    // XSS 过滤
    const safeName = xss(name, xssOptions)
    const safeDescription = description ? xss(description, xssOptions) : ''
    const safeAuthor = author ? xss(author, xssOptions) : '匿名'
    const safeTags = tags ? tags.map(t => xss(t, xssOptions)).join(',') : ''

    // 生成 ID
    const id = uuidv4()

    // 计算节点数量
    const nodeCount = sanitizedContent.nodes?.length || 0

    // 插入数据库
    try {
      const insertStmt = db.prepare(`
        INSERT INTO workflows (id, hash, name, description, author, category, tags, content, node_count, ip_address, user_agent, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      
      insertStmt.run(
        id,
        hash,
        safeName,
        safeDescription,
        safeAuthor,
        category || '其他',
        safeTags,
        JSON.stringify(sanitizedContent),
        nodeCount,
        clientIP,
        userAgent.substring(0, 200),
        clientId || null
      )

      res.status(201).json({
        success: true,
        id,
        message: '工作流发布成功'
      })
    } catch (error) {
      console.error('发布工作流失败:', error)
      res.status(500).json({ error: '发布失败，请稍后重试' })
    }
  }
)

/**
 * 检查工作流是否已存在
 * POST /api/workflows/check
 */
router.post('/check',
  [body('content').isObject()],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误' })
    }

    const { content } = req.body

    // 验证工作流内容
    const validation = validateWorkflowContent(content)
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    // 清理和计算哈希
    const sanitizedContent = sanitizeWorkflow(content)
    const hash = calculateWorkflowHash(sanitizedContent)

    // 检查是否存在
    const existingStmt = db.prepare('SELECT id, name FROM workflows WHERE hash = ? AND is_active = 1')
    const existing = existingStmt.get(hash)

    res.json({
      exists: !!existing,
      existingId: existing?.id,
      existingName: existing?.name
    })
  }
)

/**
 * 举报工作流
 * POST /api/workflows/:id/report
 */
router.post('/:id/report',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: '举报过于频繁' }
  }),
  [
    param('id').isUUID(),
    body('reason')
      .isIn(['违规内容', '恶意代码', '侵权', '垃圾信息', '其他'])
      .withMessage('无效的举报原因'),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 })
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误', details: errors.array() })
    }

    const { reason, description } = req.body
    const workflowId = req.params.id
    const clientIP = getClientIP(req)

    // 检查工作流是否存在
    const checkStmt = db.prepare('SELECT id FROM workflows WHERE id = ? AND is_active = 1')
    if (!checkStmt.get(workflowId)) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    // 记录举报
    try {
      db.prepare(`
        INSERT INTO reports (workflow_id, reason, description, ip_address)
        VALUES (?, ?, ?, ?)
      `).run(workflowId, reason, description || '', clientIP)

      res.json({ success: true, message: '举报已提交' })
    } catch (error) {
      res.status(500).json({ error: '提交失败' })
    }
  }
)

/**
 * 删除工作流（仅发布者可删除）
 * DELETE /api/workflows/:id
 */
router.delete('/:id',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: '操作过于频繁' }
  }),
  [
    param('id').isUUID(),
    body('clientId')
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
      .withMessage('无效的客户端ID')
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误', details: errors.array() })
    }

    const workflowId = req.params.id
    const { clientId } = req.body

    // 检查工作流是否存在
    const checkStmt = db.prepare('SELECT id, client_id, name FROM workflows WHERE id = ? AND is_active = 1')
    const workflow = checkStmt.get(workflowId)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    // 验证是否为发布者
    if (!workflow.client_id || workflow.client_id !== clientId) {
      return res.status(403).json({ error: '无权删除此工作流' })
    }

    // 硬删除（从数据库中真正删除）
    try {
      // 先删除相关的下载记录
      db.prepare('DELETE FROM download_logs WHERE workflow_id = ?').run(workflowId)
      // 删除相关的举报记录
      db.prepare('DELETE FROM reports WHERE workflow_id = ?').run(workflowId)
      // 删除工作流本身
      db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId)
      res.json({ success: true, message: '工作流已删除' })
    } catch (error) {
      console.error('删除工作流失败:', error)
      res.status(500).json({ error: '删除失败' })
    }
  }
)

/**
 * 检查工作流是否属于当前用户
 * POST /api/workflows/:id/check-owner
 */
router.post('/:id/check-owner',
  [
    param('id').isUUID(),
    body('clientId')
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误' })
    }

    const workflowId = req.params.id
    const { clientId } = req.body

    const stmt = db.prepare('SELECT client_id FROM workflows WHERE id = ? AND is_active = 1')
    const workflow = stmt.get(workflowId)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    res.json({
      isOwner: workflow.client_id === clientId
    })
  }
)

/**
 * 获取用户发布的工作流列表
 * POST /api/workflows/my-workflows
 */
router.post('/my-workflows',
  [
    body('clientId')
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
      .withMessage('无效的客户端ID'),
    body('page').optional().isInt({ min: 1 }).toInt(),
    body('limit').optional().isInt({ min: 1, max: 50 }).toInt()
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误', details: errors.array() })
    }

    const { clientId, page = 1, limit = 20 } = req.body
    const offset = (page - 1) * limit

    // 获取总数
    const countStmt = db.prepare('SELECT COUNT(*) as total FROM workflows WHERE client_id = ? AND is_active = 1')
    const { total } = countStmt.get(clientId)

    // 获取列表
    const listStmt = db.prepare(`
      SELECT id, name, description, author, category, tags, node_count, download_count, created_at
      FROM workflows
      WHERE client_id = ? AND is_active = 1
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    const workflows = listStmt.all(clientId, limit, offset)

    res.json({
      workflows: workflows.map(w => ({
        ...w,
        tags: w.tags ? w.tags.split(',').filter(Boolean) : []
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    })
  }
)

/**
 * 更新工作流信息（仅发布者可更新）
 * PUT /api/workflows/:id
 */
router.put('/:id',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: '操作过于频繁' }
  }),
  [
    param('id').isUUID(),
    body('clientId')
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
      .withMessage('无效的客户端ID'),
    body('name')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('名称长度应在2-50个字符之间'),
    body('description')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 500 })
      .withMessage('描述不能超过500个字符'),
    body('author')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 30 })
      .withMessage('作者名不能超过30个字符'),
    body('category')
      .optional()
      .isString()
      .trim()
      .isIn(['数据采集', '自动化操作', '表单填写', 'AI应用', '定时任务', '其他'])
      .withMessage('无效的分类'),
    body('tags')
      .optional()
      .isArray({ max: 5 })
      .withMessage('标签最多5个'),
    body('tags.*')
      .optional()
      .isString()
      .trim()
      .isLength({ max: 20 })
      .withMessage('单个标签不能超过20个字符'),
    body('content')
      .optional()
      .custom((value) => {
        if (value && (typeof value !== 'object' || Array.isArray(value))) {
          throw new Error('工作流内容必须是对象')
        }
        return true
      })
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数验证失败', details: errors.array() })
    }

    const workflowId = req.params.id
    const { clientId, name, description, author, category, tags, content } = req.body

    // 检查工作流是否存在
    const checkStmt = db.prepare('SELECT id, client_id, hash FROM workflows WHERE id = ? AND is_active = 1')
    const workflow = checkStmt.get(workflowId)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    // 验证是否为发布者
    if (!workflow.client_id || workflow.client_id !== clientId) {
      return res.status(403).json({ error: '无权修改此工作流' })
    }

    // 构建更新语句
    const updates = []
    const params = []

    if (name !== undefined) {
      updates.push('name = ?')
      params.push(xss(name, xssOptions))
    }

    if (description !== undefined) {
      updates.push('description = ?')
      params.push(xss(description, xssOptions))
    }

    if (author !== undefined) {
      updates.push('author = ?')
      params.push(xss(author, xssOptions))
    }

    if (category !== undefined) {
      updates.push('category = ?')
      params.push(category)
    }

    if (tags !== undefined) {
      updates.push('tags = ?')
      params.push(tags.map(t => xss(t, xssOptions)).join(','))
    }

    if (content !== undefined) {
      // 验证工作流内容
      const validation = validateWorkflowContent(content)
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error })
      }

      // 清理和标准化工作流内容
      const sanitizedContent = sanitizeWorkflow(content)

      // 计算新的哈希值
      const newHash = calculateWorkflowHash(sanitizedContent)

      // 检查是否与其他工作流重复（排除自己）
      const existingStmt = db.prepare('SELECT id, name FROM workflows WHERE hash = ? AND id != ?')
      const existing = existingStmt.get(newHash, workflowId)

      if (existing) {
        return res.status(409).json({
          error: '该工作流内容已存在于仓库中',
          existingId: existing.id,
          existingName: existing.name
        })
      }

      updates.push('content = ?')
      params.push(JSON.stringify(sanitizedContent))

      updates.push('hash = ?')
      params.push(newHash)

      updates.push('node_count = ?')
      params.push(sanitizedContent.nodes?.length || 0)
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有要更新的内容' })
    }

    // 添加更新时间
    updates.push('updated_at = CURRENT_TIMESTAMP')

    // 执行更新
    try {
      params.push(workflowId)
      const updateStmt = db.prepare(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`)
      updateStmt.run(...params)

      res.json({
        success: true,
        message: '工作流更新成功'
      })
    } catch (error) {
      console.error('更新工作流失败:', error)
      res.status(500).json({ error: '更新失败，请稍后重试' })
    }
  }
)

/**
 * 获取用户发布的单个工作流详情（包含完整内容，用于编辑）
 * POST /api/workflows/:id/edit
 */
router.post('/:id/edit',
  [
    param('id').isUUID(),
    body('clientId')
      .isString()
      .trim()
      .isLength({ min: 16, max: 64 })
      .withMessage('无效的客户端ID')
  ],
  (req, res) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: '参数错误', details: errors.array() })
    }

    const workflowId = req.params.id
    const { clientId } = req.body

    const stmt = db.prepare(`
      SELECT id, name, description, author, category, tags, content, node_count, download_count, created_at
      FROM workflows
      WHERE id = ? AND is_active = 1
    `)
    const workflow = stmt.get(workflowId)

    if (!workflow) {
      return res.status(404).json({ error: '工作流不存在' })
    }

    // 验证是否为发布者
    const ownerStmt = db.prepare('SELECT client_id FROM workflows WHERE id = ?')
    const ownerInfo = ownerStmt.get(workflowId)

    if (!ownerInfo.client_id || ownerInfo.client_id !== clientId) {
      return res.status(403).json({ error: '无权查看此工作流的编辑信息' })
    }

    res.json({
      ...workflow,
      tags: workflow.tags ? workflow.tags.split(',').filter(Boolean) : [],
      content: JSON.parse(workflow.content)
    })
  }
)

export default router
