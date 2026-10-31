// Vitest 全局配置：测试夹具会在每个测试文件启动隔离的 SQLite 服务并播种演示数据，
// 在 2 核 Windows CI runner 上并行执行时默认 10s hook 超时不够用，这里放宽上限。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // e2e 用例会启动真实 Express 服务并写临时数据库，串行更稳定。
    fileParallelism: true,
  },
});
