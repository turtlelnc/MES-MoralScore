// 版本号一致性测试：package.json、server/version.mjs、src/version.ts 必须一致。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION, BUILD_NUMBER, VERSION_LABEL } from "./version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("版本身份", () => {
  it("package.json / server / 前端版本一致", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const source = fs.readFileSync(path.join(root, "src/version.ts"), "utf8");
    expect(`v${packageJson.version}`).toBe(APP_VERSION);
    expect(source).toContain(`"${APP_VERSION}"`);
    expect(source).toContain(`"${BUILD_NUMBER}"`);
    expect(source).toContain("export const VERSION_LABEL");
    expect(VERSION_LABEL).toBe(`${APP_VERSION} (build${BUILD_NUMBER})`);
  });

  it("构建号格式与当前发布一致", () => {
    expect(BUILD_NUMBER).toMatch(/^\d{8}$/);
    expect(BUILD_NUMBER).toBe("26103101");
    expect(APP_VERSION).toBe("v0.1.0-rc1");
    expect(VERSION_LABEL).toBe("v0.1.0-rc1 (build26103101)");
  });

  it("健康检查返回版本身份", async () => {
    const { createTestServer } = await import("./test-utils.mjs");
    const server = await createTestServer({ seed: false });
    try {
      const health = await server.request("/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        ok: true,
        version: APP_VERSION,
        build: BUILD_NUMBER,
        versionLabel: VERSION_LABEL,
      });
    } finally {
      await server.close();
    }
  });
});
