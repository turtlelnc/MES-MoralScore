# 部署与运维指南（MES-MoralScore v0.1.0-rc1）

本指南面向学校信息中心/运维人员。应用为单进程 Node.js 服务：Express 5 提供 API 与前端静态资源，`node:sqlite` 存储业务数据，证据文件保存在私有数据目录。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11、主流 Linux 发行版、macOS（Apple Silicon / Intel） |
| Node.js | ≥ 24（使用内置 `node:sqlite`，无需单独安装数据库） |
| 内存/磁盘 | 1 GB 内存起步；磁盘按证据文件规模预留（默认单文件 ≤8 MB） |
| 浏览器 | Chrome/Edge/Safari/Firefox 近两年版本；移动端 Safari/Chrome |

不需要 PostgreSQL、Redis、Nginx 或 Docker 也能运行；生产环境建议使用反向代理与 HTTPS。

## 2. 安装

```bash
git clone https://github.com/turtlelnc/MES-MoralScore.git
cd MES-MoralScore
npm ci                 # 或 npm install
npm run build          # 生成 dist/（由 Express 托管）
```

## 3. 初始化与配置

```bash
cp .env.example .env
# 生成高强度密钥（Linux/macOS）
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`.env` 关键项：

| 变量 | 说明 |
| --- | --- |
| `PORT` / `HOST` | 默认 `8080` / `127.0.0.1`；局域网访问设 `HOST=0.0.0.0` 并放行防火墙端口 |
| `APP_SECRET` | 生产环境必填，≥32 位随机字符串；用于令牌/敏感字段加密。**更换会使已有加密数据不可读** |
| `DATA_DIR` | SQLite 与私有证据目录，默认 `./data`；建议放在独立数据盘并纳入备份 |
| `BACKUP_DIR` | 备份目录，必须在 `DATA_DIR` 之外；未配置时系统管理“立即备份”会明确报错 |
| `BACKUP_KEEP_RECENT` | 保留最近备份数量，默认 24 |
| `APP_ORIGIN` | 浏览器访问的精确 Origin（如 `https://moral.example.edu.cn`），用于同源写入校验与分享链接 |
| `COOKIE_SECURE` | HTTPS 部署必须为 `1`；纯内网 HTTP 保持 `0` |
| `TRUST_PROXY_HOPS` | 反向代理/负载均衡层数（如 Nginx 单层为 1），否则登录限流按代理 IP 计数 |
| `EVIDENCE_MAX_MB` | 单个证据文件上限（默认 8 MB） |
| `SESSION_DAYS` / `LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_SECONDS` | 会话有效期与登录失败限流 |

创建首个管理员（生产环境不要使用演示数据）：

```bash
npm run admin:create -- \
  --account=admin \
  --password='请改成至少10位含字母数字的强密码' \
  --name=林校长 \
  --school-name='某某实验学校' \
  --school-code=MY-SCHOOL \
  --stage=初中
```

该命令会创建学校、当前学年与两个学期、9 个默认指标分类、系统参数，以及系统管理员账号（首次登录会提示改密）；输出的账号可用于登录。

## 4. 启动

```bash
# 前台运行
node --env-file=.env server/index.mjs

# 或使用 npm（不会自动加载 .env，请先 export 或使用上面的命令）
npm start
```

启动后访问 `http://127.0.0.1:8080/api/health` 应返回 `ok: true` 与版本号。首次进入后建议顺序：

1. 系统管理 → 学校资料/学年学期 → 确认当前学期；
2. 系统管理 → 年级/班级/学生（或 CSV 导入）；
3. 系统管理 → 账号与数据范围（为值日老师分配年级/班级）；
4. 德育处账号 → 评分规则 → 创建并发布规则；
5. 值日老师 → 快捷记分 → 验证账本、复核与申报流程。

### systemd 示例（Linux）

```ini
[Unit]
Description=MES-MoralScore
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mes-moralscore
EnvironmentFile=/opt/mes-moralscore/.env
ExecStart=/usr/bin/node server/index.mjs
Restart=on-failure
RestartSec=3
User=mes
Group=mes

[Install]
WantedBy=multi-user.target
```

### Windows 服务示例

可使用 NSSM 或计划任务：

```powershell
nssm install MES-MoralScore "C:\Program Files\nodejs\node.exe" "server/index.mjs"
nssm set MES-MoralScore AppDirectory "C:\mes-moralscore"
nssm set MES-MoralScore AppEnvironmentExtra "NODE_ENV=production"
nssm start MES-MoralScore
```

### 反向代理（Nginx）

```nginx
server {
  listen 443 ssl http2;
  server_name moral.example.edu.cn;
  ssl_certificate     /etc/ssl/fullchain.pem;
  ssl_certificate_key /etc/ssl/privkey.pem;

  client_max_body_size 20m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

对应 `.env`：`APP_ORIGIN=https://moral.example.edu.cn`、`COOKIE_SECURE=1`、`TRUST_PROXY_HOPS=1`。

## 5. 备份与恢复

应用使用 SQLite WAL 模式，备份必须使用 `VACUUM INTO`（在线一致快照），不要直接复制正在写入的 `.sqlite` 文件。

```bash
# 手动备份（脚本从 .env 读取 DATA_DIR/BACKUP_DIR）
npm run backup:run
# 查看备份记录
npm run backup:status
```

- 系统管理 → 备份 页面可手动触发并查看真实的开始/结束时间、文件大小、成功/失败原因。
- 建议用 cron/systemd timer 每日执行 `npm run backup:run`，并把 `BACKUP_DIR` 同步到另一块磁盘或对象存储。
- 备份文件包含全部学生与积分数据，必须限制访问权限（例如 `chmod 600`、仅运维账号可读）。

恢复步骤：

1. 停止服务；
2. 备份当前 `DATA_DIR/moral-score.sqlite`（保留回滚点）；
3. 将目标备份文件复制为 `DATA_DIR/moral-score.sqlite`，删除同目录 `-wal` 与 `-shm` 文件；
4. 启动服务并访问 `/api/health`，抽查学生/记录数据；
5. 如恢复失败，用第 2 步的回滚点还原。

## 6. 升级

1. 备份数据库；
2. 拉取新版本代码，`npm ci && npm run build`；
3. 重启服务（迁移在启动时自动执行，且可重复执行）；
4. 查看 `/api/health` 的版本与构建号；
5. 如新版本包含 schema 变更，迁移会在事务中执行；失败时服务不会带病启动，请保留日志。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动报“生产环境必须配置至少 32 位随机 APP_SECRET” | 在 `.env` 配置 `APP_SECRET`（≥32 位随机） |
| 启动报 `EACCES` / 端口被占用 | 该端口被系统保留或被占用，用 `PORT=8080` 等更换；检查防火墙 |
| 登录后立刻掉线 | 检查是否 HTTPS + `COOKIE_SECURE=1` 不匹配；反向代理需透传 `Host`/`X-Forwarded-Proto` |
| 登录提示“尝试过于频繁” | 等待窗口结束，或调整 `LOGIN_MAX_FAILURES`/`LOGIN_WINDOW_SECONDS`；代理部署设置 `TRUST_PROXY_HOPS` |
| 备份报“未配置 BACKUP_DIR” | 在 `.env` 设置 `BACKUP_DIR`（必须在 `DATA_DIR` 外）并确保进程有写权限 |
| 分享链接打不开 | 链接已过期/撤销或 token 错误；重新在成长报告生成新链接 |
| 学生申报链接打不开 | 链接过期/被撤销；重新生成班级申报链接 |
| 磁盘空间不足 | 清理旧备份与证据文件；检查 `EVIDENCE_MAX_MB` 与 `DATA_DIR` 所在磁盘 |

## 8. 安全清单（部署前）

- [ ] `APP_SECRET` 为随机长字符串，未提交到仓库
- [ ] 生产环境使用 HTTPS，`COOKIE_SECURE=1`、`APP_ORIGIN` 配置正确
- [ ] 关闭演示数据/演示账号；使用 `admin:create` 创建正式管理员
- [ ] 家长分享链接只发给已核验身份的家长，离开学校时撤销
- [ ] 定期备份并验证可恢复，备份文件访问权限受控
- [ ] 系统管理员账号数量受控，开启审计日志定期检查
- [ ] 服务器仅开放必要端口，数据库/证据目录不通过静态服务器暴露
- [ ] 按学校制度向师生家长说明数据用途、保存期限与查询更正渠道

更多安全设计见 [SECURITY.md](SECURITY.md)。
