# 在线记事本

一个简单的记事本，可以方便多设备之间传递文本消息

如：有些时候，发布服务后，发现要传递一些秘钥，用这个可以很方便


支持类型：
- 文本
- markdown

### 使用说明

1. 下载：[releases](https://github.com/cute-angelia/notepad-online/releases)
2. 同目录新建 config.toml
        
```toml
[note]
# 文件日志
wirteLogFile = false
# 运行端口号
serverPort = 8787
# 旧版地址长度；新版文档地址使用 128 位随机值
keyLength = 6
# mysql dsn
mysqDsn = "root:LuXXX@tcp(hXXX:3306)/XXX?charset=utf8mb4&parseTime=true&loc=Local"
```


示例图:

![img](https://raw.githubusercontent.com/cute-angelia/notepad-online/main/s1.jpg)

### 参考
1. [Sunbalcony note](https://github.com/Sunbalcony/note)
2. [notepad.pw](https://notepad.pw)

### 编辑与只读分享

- 新建文档默认使用 Markdown，可切换为纯文本，切换不会改写正文。
- 标题、正文和类型自动保存。电脑支持格式工具栏和左右实时预览；手机隐藏工具栏与预览。
- 「复制链接」先完成保存，再复制 `/:id` 只读地址。分享显示最新保存的内容。
- `/:id/edit` 为编辑入口。未授权浏览器需要验证文档秘钥；验证后通过 HttpOnly、SameSite Cookie 记住一年。清理 Cookie 或更换浏览器后需重新验证。
- 新建时自动生成至少 4 个字母的英文单词秘钥，也可自填。已保存或成功验证的秘钥按文档记在当前浏览器的 localStorage，不设过期时间，编辑页重新加载时会回显；清除浏览器站点数据会移除记录。服务器仍只存哈希，公开查看页不会读取本地秘钥。秘钥直接显示，点击即可复制；「随机」生成新单词，手动输入或随机替换后自动保存，仅在秘钥变化时更换；已授权的编辑器无需再次验证旧秘钥。
- 更换秘钥保留当前浏览器的权限，其他浏览器需使用新秘钥重新验证。
- `/:id/raw` 保留原文输出；`/:id/md` 保留 Markdown 查看。旧 `POST /:id` 现在必须提供浏览器授权，不再允许持有公开地址的访客直接修改。

### 数据库升级与锁定

启动会自动迁移表结构，检查错误后才启动 HTTP 服务。建议部署前备份数据库。历史正文和地址保留，文档类型设为 `text`、初始秘钥设为 `twins`；已有新秘钥不会在重启时被覆盖。如果存在重复的 `tag`，启动会报错并停止，需先人工处理重复记录，不会自动删除历史数据。

`notepad` 新增字段：

| 字段 | 用途 |
| --- | --- |
| `title` | 标题，最多 200 个字符 |
| `document_type` | `text` 或 `markdown` |
| `secret` | bcrypt 秘钥哈希，不存明文 |
| `locked` | 锁定截止时间的 Unix 秒时间戳；`0` 表示未锁定 |
| `failed_attempts` | 当天跨访客累计输错次数 |
| `failure_day` | 计数日期，按北京时间 |

另建 `browser_grants` 表，保存浏览器随机凭证的摘要、文档授权及到期时间。

同一文档在北京时间当天累计输错秘钥 10 次，将锁定整篇文档直到次日零点。所有人（包括已授权浏览器）均不能保存或更改秘钥，阅读不受影响。验证成功不会清空当天累计失败次数。

手动解锁指定文档：

```sql
UPDATE notepad SET locked = 0 WHERE tag = '文档ID';
```

后续编辑或秘钥验证会重置已达到上限的失败计数。到次日零点自动恢复编辑；计数保存在数据库中，不会因重启丢失。

### 开发验证

```bash
go test -race ./...
go vet ./...
go build -o /tmp/notepad-online .
node --check static/script.js
node --check static/render.js
```

权限与迁移集成测试使用隔离的内存 SQLite；生产仍使用配置中的 MySQL。
