/**
 * `node-karin/sqlite3` 的兼容实现：基于 Node 内置的 node:sqlite。
 *
 * 原插件按 node-sqlite3 的回调风格调用：`db.run(sql, params, cb)`、
 * `db.get/all(sql, params, cb)`，回调里还有 `this.lastID` / `this.changes`，这里逐条对齐。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

type Callback = (err: Error | null, row?: any) => void

interface RunContext {
  lastID: number
  changes: number
}

class CompatDatabase {
  private db: DatabaseSync
  private readonly filename: string

  constructor (filename: string, callback?: (err: Error | null) => void) {
    this.filename = filename
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      // node:sqlite 默认开启外键校验（enableForeignKeyConstraints: true），
      // 而 node-sqlite3 默认关闭；上游表结构的外键（GroupUserSubscriptions.groupId → Groups.id）
      // 在开启校验时会直接报 "foreign key mismatch"，因此这里显式关掉，与 Karin 版行为一致。
      this.db = new DatabaseSync(filename, { enableForeignKeyConstraints: false })
      this.db.exec('PRAGMA journal_mode = WAL')
      callback?.(null)
    } catch (error) {
      callback?.(error as Error)
      throw error
    }
  }

  private normalize (params: any[]): any[] {
    return (params ?? []).map((item) => {
      if (item === undefined) return null
      if (typeof item === 'boolean') return item ? 1 : 0
      return item as any
    })
  }

  run (sql: string, params?: any[] | Callback, callback?: Callback) {
    const cb = typeof params === 'function' ? params : callback
    const args = Array.isArray(params) ? params : []
    try {
      const stmt = this.db.prepare(sql)
      const result = stmt.run(...this.normalize(args))
      const ctx: RunContext = { lastID: Number(result.lastInsertRowid ?? 0), changes: Number(result.changes ?? 0) }
      cb?.call(ctx, null)
      return ctx
    } catch (error) {
      cb?.call({ lastID: 0, changes: 0 }, error as Error)
      return { lastID: 0, changes: 0 }
    }
  }

  get (sql: string, params?: any[] | Callback, callback?: Callback) {
    const cb = typeof params === 'function' ? params : callback
    const args = Array.isArray(params) ? params : []
    try {
      const row = this.db.prepare(sql).get(...this.normalize(args))
      cb?.(null, row)
      return row
    } catch (error) {
      cb?.(error as Error)
      return undefined
    }
  }

  all (sql: string, params?: any[] | Callback, callback?: Callback) {
    const cb = typeof params === 'function' ? params : callback
    const args = Array.isArray(params) ? params : []
    try {
      const rows = this.db.prepare(sql).all(...this.normalize(args))
      cb?.(null, rows)
      return rows
    } catch (error) {
      cb?.(error as Error)
      return []
    }
  }

  exec (sql: string, callback?: Callback) {
    try {
      this.db.exec(sql)
      callback?.(null)
    } catch (error) {
      callback?.(error as Error)
    }
  }

  close (callback?: (err: Error | null) => void) {
    try {
      this.db.close()
      callback?.(null)
    } catch (error) {
      callback?.(error as Error)
    }
  }

  serialize (callback?: () => void) {
    callback?.()
  }

  get path () {
    return this.filename
  }
}

export const sqlite3 = {
  Database: CompatDatabase,
  verbose () {
    return sqlite3
  }
}

export default sqlite3
export type Sqlite3Compat = typeof sqlite3
export const Database = CompatDatabase
