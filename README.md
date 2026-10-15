# 在线记事本 (Notepad Online)

轻量、安全、多端自适应的在线记事本服务。支持 Markdown、纯文本及代码三种模式，可方便地在多设备间快速传递文本、代码片段及敏感配置信息。

---

## ✨ 核心特性

- **三种文档模式**：
  - **Markdown 模式**：内置格式工具栏、左右实时预览、数学公式与自动大纲目录（TOC）。
  - **纯文本 (Text) 模式**：极简清爽，专注轻量文本传递。
  - **代码 (Code) 模式**：自带 GitHub 风格浅色高亮、行号引导栏、Tab 智能缩进及一键复制代码。
- **只读与编辑分离**：
  - `/:id` 默认只读分享，提供一键「复制内容」与「复制链接」。
  - `/:id/edit` 为独立编辑入口，未授权浏览器必须校验文档秘钥。
- **完善的安全机制**：
  - **秘钥安全**：采用 bcrypt 哈希单向存储，服务端不存明文；新建时自动生成易记单词秘钥，支持一键随机刷新。
  - **防暴力破解**：单个文档北京时间单日累计输错秘钥 10 次将自动触发当日锁定，次日零点自动恢复。
  - **Cookie 凭据授权**：验证成功后通过 HttpOnly、SameSite 安全 Cookie 维持一年免密编辑。
  - **安全防护**：内置严格安全响应头（X-Frame-Options、HSTS、CSP 等）、请求体大小限制及 IP 级频率限制。
- **协议自适应 (HTTP / HTTPS)**：
  - 基于 `cmux` 实现单端口同时支持 HTTP 与 HTTPS 访问。
  - 自动探测证书文件，本地无证书时自动降级为普通 HTTP，服务器挂载证书时自适应双协议。
- **多端响应式体验**：
  - 移动端自动优化界面排版并隐藏复杂工具栏。
  - 标题长文本智能缩小字号，确保在 PC 端单行水平对齐不折行。

---

## 🖼️ 界面预览

### 1. Markdown 视图
具备左侧大纲目录树、数学公式解析、自适应单行标题以及复制工具栏：
![Markdown 视图](docs/images/1.jpg)

### 2. 纯文本视图
极简清爽的排版，适合设备间快速同步文本与笔记：
![纯文本视图](docs/images/2.jpg)

### 3. 代码视图
代码模式展示，配备行号引导槽、自适应等宽字体以及独立的「复制代码」功能：
![代码视图](docs/images/3.jpg)

---

## 🚀 快速上手

### 1. 下载可执行文件
前往 [Releases](https://github.com/cute-angelia/notepad-online/releases) 页面下载适合你系统的构建产物。

### 2. 配置 `config.toml`
在可执行文件同级目录下创建 `config.toml`：

```toml
[note]
# 是否开启文件日志
wirteLogFile = false

# 服务监听端口
serverPort = 8787

# 文档路径标识符长度
keyLength = 6

# MySQL 数据库连接串
mysqDsn = "user:password@tcp(127.0.0.1:3306)/notepad?charset=utf8mb4&parseTime=true&loc=Local"

# 可选：SSL 证书配置（不配置则默认读取 ssl/ 目录证书，无证书时自动使用纯 HTTP）
[note.ssl]
cert_file = "ssl/fullchain.cer"
key_file = "ssl/home.shixinyi.cn.key"
```

### 3. 运行服务

```bash
# 直接启动
./note

# 或通过 PM2 后台守护
pm2 start pm2_nas.json
```

服务启动时会自动检查并执行数据库迁移。

---

## 🧭 路由规范

| 路径 | 说明 |
| :--- | :--- |
| `/` | 首页：创建新文档（可自选文档类型并自动生成随机秘钥） |
| `/:id` | 公开只读页面：呈现已保存文档内容（支持复制内容与分享链接） |
| `/:id/edit` | 编辑入口：需校验文档秘钥，授权后可实时编辑并自动保存 |
| `/:id/raw` | 纯文本原始内容直出 |
| `/:id/md` | Markdown 纯文本直出 |

---

## 🛡️ 安全与防爆破策略

- **失败锁定规则**：单文档当天（北京时间）累计输错秘钥 10 次，文档将立即进入锁定状态直至次日 00:00，期间禁止任何保存或修改，但只读浏览不受影响。
- **手动应急解锁**：如需立即解除某篇文档的锁定，执行以下 SQL 即可：
  ```sql
  UPDATE notepad SET locked = 0 WHERE tag = '文档ID';
  ```

---

## 🛠️ 本地开发与测试

本项目使用 Go 编写，推荐使用 Go 1.17+ 进行本地构建与测试：

```bash
# 运行全部单元测试（包含鉴权、迁移、中间件及 webserver 多路复用测试）
go test -v ./...

# 静态检查与构建
go vet ./...
go build -o note main.go
```

---

## 📌 致谢与参考

- [Sunbalcony note](https://github.com/Sunbalcony/note)
- [notepad.pw](https://notepad.pw)
