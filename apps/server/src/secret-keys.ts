/**
 * 永不外泄的设置键（§7 / 评审修复项）。
 *  · gitAuthEnc：凭据密文
 *  · gitAuth：凭据明文（历史遗留键，加密开启前的旧路径）
 *  · gitConflictState：冲突三方快照（含两端明文载荷，绝不该进导出/备份）
 *
 * 这份名单必须只有一个来源：`system.service.ts` 的 getSettings/backup 与
 * `backup.service.ts` 的自动快照都靠它，任何一处漏掉就等于把凭据写进磁盘 JSON。
 *
 * 语义：这些键只写不读（不回传给前端），避免明文凭据/内部快照泄露。
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(['gitAuthEnc', 'gitAuth', 'gitConflictState'])
