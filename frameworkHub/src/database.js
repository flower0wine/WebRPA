/**
 * 数据库初始化和操作
 * 使用 sql.js（纯 JavaScript SQLite 实现）
 */

import initSqlJs from 'sql.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 数据目录
const dataDir = join(__dirname, '..', 'data')
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}

// 数据库文件路径
const dbPath = join(dataDir, 'workflows.db')

// 数据库实例
let db = null

// 自动保存间隔（毫秒）
const AUTO_SAVE_INTERVAL = 30000

/**
 * 初始化数据库
 */
export async function initDatabase() {
  const SQL = await initSqlJs()
  
  // 如果数据库文件存在，加载它
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
    console.log('✅ 已加载现有数据库')
  } else {
    db = new SQL.Database()
    console.log('✅ 已创建新数据库')
  }

  // 创建表
  db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      author TEXT DEFAULT '匿名',
      category TEXT DEFAULT '其他',
      tags TEXT,
      content TEXT NOT NULL,
      node_count INTEGER DEFAULT 0,
      download_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      ip_address TEXT,
      user_agent TEXT,
      client_id TEXT,
      is_active INTEGER DEFAULT 1
    )
  `)

  // 尝试添加 client_id 列（如果不存在）
  try {
    db.run(`ALTER TABLE workflows ADD COLUMN client_id TEXT`)
  } catch (e) {
    // 列已存在，忽略错误
  }

  // 创建索引
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_hash ON workflows(hash)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_category ON workflows(category)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_created_at ON workflows(created_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_download_count ON workflows(download_count)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_is_active ON workflows(is_active)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_client_id ON workflows(client_id)`)

  // 下载记录表
  db.run(`
    CREATE TABLE IF NOT EXISTS download_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      ip_address TEXT NOT NULL,
      downloaded_at TEXT DEFAULT (datetime('now'))
    )
  `)

  // 举报表
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      description TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'pending'
    )
  `)

  // 保存数据库
  saveDatabase()

  // 设置自动保存
  setInterval(() => {
    saveDatabase()
  }, AUTO_SAVE_INTERVAL)

  console.log('✅ 数据库初始化完成')
}

/**
 * 保存数据库到文件
 */
export function saveDatabase() {
  if (db) {
    const data = db.export()
    const buffer = Buffer.from(data)
    writeFileSync(dbPath, buffer)
  }
}

/**
 * 数据库包装器，提供类似 better-sqlite3 的 API
 */
class DatabaseWrapper {
  prepare(sql) {
    return new StatementWrapper(sql)
  }

  exec(sql) {
    db.run(sql)
    saveDatabase()
  }
}

class StatementWrapper {
  constructor(sql) {
    this.sql = sql
  }

  run(...params) {
    db.run(this.sql, params)
    saveDatabase()
    return { changes: db.getRowsModified() }
  }

  get(...params) {
    const stmt = db.prepare(this.sql)
    stmt.bind(params)
    if (stmt.step()) {
      const row = stmt.getAsObject()
      stmt.free()
      return row
    }
    stmt.free()
    return undefined
  }

  all(...params) {
    const results = []
    const stmt = db.prepare(this.sql)
    stmt.bind(params)
    while (stmt.step()) {
      results.push(stmt.getAsObject())
    }
    stmt.free()
    return results
  }
}

// 导出数据库包装器
export default new DatabaseWrapper()
