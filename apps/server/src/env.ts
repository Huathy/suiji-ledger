import fs from 'node:fs'
import path from 'node:path'

/** 数据目录：唯一权威来源（main.ts 与 BackupService 共用，避免相对路径歧义） */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.resolve(__dirname, '..', '..', '..'), 'apps', 'server', 'data')

export function ensureDataDir(): void {
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true })
}

export function databaseFileUrl(): string {
  return 'file:' + path.join(DATA_DIR, 'money.db').split(path.sep).join('/')
}
