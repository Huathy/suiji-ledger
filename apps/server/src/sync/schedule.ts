/** 调度纯函数（不依赖 Nest/Prisma，便于单测） */

/**
 * 每日 03:00 该跑而未跑 → 跑。
 * 用「今天 03:00 的时间戳」比较，而不是「距上次 ≥24h」：
 * 进程整点不在时，下次启动要能补跑，不能等到明天。
 */
export function shouldRunNow(mode: string, now: Date, lastRunAt: number | null): boolean {
  if (mode !== 'daily') return false
  const today3 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0)
  if (now.getTime() < today3.getTime()) return false
  return !lastRunAt || lastRunAt < Math.floor(today3.getTime() / 1000)
}

/** 离线指数退避：1m / 5m / 15m / 30m 封顶（error 态与 offline 共用，评审修复项） */
export function backoffMinutes(retries: number): number {
  return [1, 5, 15, 30][Math.min(Math.max(retries, 0), 3)]
}

/** 自动重试的次数上限：达到即**停手转人工**，不再无限退避（用户要求「重试三次就别一直重试」）。 */
export const MAX_AUTO_RETRIES = 3

/**
 * 是否该停止自动重试。
 * `>=` 而不是 `===`：状态可能从别处带着更高的 retries 进来（旧库、手工改库），
 * 判 `===` 会让它永远跨不过去、继续无限重试。
 */
export function shouldHalt(retries: number): boolean {
  return retries >= MAX_AUTO_RETRIES
}

/**
 * 失败分类：这类失败**重试多少次都不会变成成功**（凭据 / 地址 / 权限 / 保护规则），
 * 不该算「离线」，更不该按 1/5/15/30 退避空转。
 *
 * 首选判据是 isomorphic-git `HttpError.data.statusCode`（401/403/404），它是服务端原文；
 * 拿不到时才退到消息文本（403 与 Gitee 的 `The token username invalid` 都见过）。
 * 429 / 5xx / 超时 / 连接失败仍属「暂时性」，由调用方走退避。
 */
export function isPermanentFailure(statusCode: number | string | null | undefined, msg: string): boolean {
  const code = Number(statusCode || 0)
  if (code === 401 || code === 403 || code === 404) return true
  const m = String(msg || '')
  // 只在消息里认"明确的状态码报错"，不裸匹配数字：
  // "http://host:404/x" 或 "timeout 4040ms" 这类文本不该把真断网误判成永久性失败（会被判成永久失败而停手）。
  if (/HTTP Error:\s*(401|403|404)\b/i.test(m)) return true
  return /token username invalid|invalid (access )?token|bad credentials|authentication (failed|required)|permission denied|access denied|repository (not found|is empty)|project .*not.*found|protected branch|pre-receive hook declined/i.test(m)
}

/** 永久性失败给人看的定性文案（原错误仍留在 lastError 里，这里只补「怎么办」） */
export function permanentFailureHint(msg: string): string {
  if (/\b404\b|not found|does not exist/i.test(msg)) return '远端仓库或分支不存在：检查「地址 / 分支」拼写，或先在远端建好该分支。'
  if (/\b403\b|permission|access denied|protected branch|pre-receive/i.test(msg)) return '凭据或权限问题：令牌所属账号对该仓库无推送权、分支受保护，或 Gitee 要求「用户名=令牌属主 login」（令牌作密码时用户名填 oauth2）。'
  return '凭据被服务端拒绝：检查 PAT 是否有效、是否给足该仓库读写权限。'
}

/**
 * 租约式强推校验（D9 / §6.3，--force-with-lease 的等价物）：
 * 只有"远端现在还停在我们上次真正推到的那一版"才允许 force——
 * 覆盖的是"我们本要看清的那一版"；远端被第三方推进过就拒绝并转人工。
 *
 * 边界：
 *  - lease 为空（本机从没成功推过）→ 无租约可言，拒绝（首次就该走正常 push/认领流程）。
 *  - remote 为空（远端分支还不存在）→ 强推等价于首次建分支，允许。
 */
export function leaseAllowsForce(leaseOid: string | null | undefined, remoteOid: string | null | undefined): boolean {
  if (!leaseOid) return false
  if (!remoteOid) return true
  return leaseOid === remoteOid
}
