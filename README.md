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
# 随机key长度
keyLength = 6
# mysql dsn
mysqDsn = "root:LuXXX@tcp(hXXX:3306)/XXX?charset=utf8mb4&parseTime=true&loc=Local"
```


示例图:

![img](https://raw.githubusercontent.com/cute-angelia/notepad-online/main/s1.jpg)

### 参考
1. [Sunbalcony note](https://github.com/Sunbalcony/note)
2. [notepad.pw](https://notepad.pw)
