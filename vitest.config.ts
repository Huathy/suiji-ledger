import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 含真实 git 仓库的集成测试（sync-git-merge）在 Windows 上单次 merge 就要 1~2s，
    // 默认 5s 会随机超时；这些用例串行做多次 init/commit/merge，给足余量。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 并行 worker 同时写依赖缓存时会偶发 EPERM（Windows + 受限文件系统），
    // 结果是"静默少跑几个文件、退出码 1"，比慢更坑。串行 + 关缓存换确定性。
    fileParallelism: false,
    cache: false,
  },
})
