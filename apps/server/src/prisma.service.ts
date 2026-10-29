import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect()
    await this.ensureSchema()
    await this.ensureBuiltinType()
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }

  /**
   * 首次启动自建表（免 prisma CLI）：打包版/全新数据目录开箱即用。
   * DDL 与 prisma/schema.prisma 保持一致；按表逐个补齐（幂等，支持旧库增量加表）。
   */
  private readonly DDL: Record<string, string[]> = {
    User: [`CREATE TABLE IF NOT EXISTS "User" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "passwordHash" TEXT NOT NULL, "createdAt" INTEGER NOT NULL)`],
    Setting: [`CREATE TABLE IF NOT EXISTS "Setting" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL)`],
    RecordType: [`CREATE TABLE IF NOT EXISTS "RecordType" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "emoji" TEXT NOT NULL, "color" TEXT, "direction" TEXT NOT NULL, "builtin" BOOLEAN NOT NULL DEFAULT false, "sort" INTEGER NOT NULL DEFAULT 0)`],
    Account: [`CREATE TABLE IF NOT EXISTS "Account" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "emoji" TEXT NOT NULL, "kind" TEXT NOT NULL, "group" TEXT, "initBalance" INTEGER NOT NULL DEFAULT 0, "inNetWorth" BOOLEAN NOT NULL DEFAULT true, "sort" INTEGER NOT NULL DEFAULT 0, "archived" BOOLEAN NOT NULL DEFAULT false, "note" TEXT, "createdAt" INTEGER NOT NULL)`],
    MonthlySnapshot: [
      `CREATE TABLE IF NOT EXISTS "MonthlySnapshot" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ym" TEXT NOT NULL, "accountId" INTEGER NOT NULL, "balance" INTEGER NOT NULL, "recordDate" TEXT NOT NULL, "note" TEXT, CONSTRAINT "MonthlySnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "MonthlySnapshot_ym_accountId_key" ON "MonthlySnapshot"("ym", "accountId")`,
      `CREATE INDEX IF NOT EXISTS "MonthlySnapshot_ym_idx" ON "MonthlySnapshot"("ym")`,
      `CREATE INDEX IF NOT EXISTS "MonthlySnapshot_accountId_idx" ON "MonthlySnapshot"("accountId")`,
    ],
    ChangeEntry: [
      `CREATE TABLE IF NOT EXISTS "ChangeEntry" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "ym" TEXT NOT NULL, "typeId" INTEGER NOT NULL, "amount" INTEGER NOT NULL, "note" TEXT, "accountId" INTEGER, "auto" BOOLEAN NOT NULL DEFAULT false, CONSTRAINT "ChangeEntry_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "RecordType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE)`,
      `CREATE INDEX IF NOT EXISTS "ChangeEntry_ym_idx" ON "ChangeEntry"("ym")`,
    ],
    Loan: [`CREATE TABLE IF NOT EXISTS "Loan" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "direction" TEXT NOT NULL, "counterparty" TEXT NOT NULL, "amount" INTEGER NOT NULL, "settledAmount" INTEGER NOT NULL DEFAULT 0, "date" TEXT NOT NULL, "dueDate" TEXT, "accountId" INTEGER, "note" TEXT, "createdAt" INTEGER NOT NULL)`],
    DeletedItem: [`CREATE TABLE IF NOT EXISTS "DeletedItem" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "kind" TEXT NOT NULL, "summary" TEXT NOT NULL, "payload" TEXT NOT NULL, "deletedAt" INTEGER NOT NULL)`],
  }

  private async ensureSchema() {
    const names = Object.keys(this.DDL)
    const existing: any[] = await this.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map((n) => `'${n}'`).join(',')})`,
    )
    const have = new Set(existing.map((r) => r.name))
    let created = false
    for (const name of names) {
      if (have.has(name)) continue
      for (const sql of this.DDL[name]) await this.$executeRawUnsafe(sql)
      created = true
    }
    // Loan 表增量迁移：老库补 accountId 列
    if (have.has('Loan')) {
      const cols: any[] = await this.$queryRawUnsafe(`PRAGMA table_info("Loan")`)
      if (!cols.some((c) => c.name === 'accountId')) {
        await this.$executeRawUnsafe(`ALTER TABLE "Loan" ADD COLUMN "accountId" INTEGER`)
      }
    }
    if (created) console.log('[Suiji Ledger] 数据库表已初始化/补齐（' + names.filter((n) => !have.has(n)).join(', ') + '）')
  }

  /** 确保内置「平账」类型存在（幂等） */
  async ensureBuiltinType() {
    const exists = await this.recordType.findFirst({ where: { builtin: true } })
    if (!exists) {
      await this.recordType.create({
        data: { name: '平账', emoji: '⚖️', direction: 'neutral', builtin: true, sort: 0 },
      })
    }
  }
}
