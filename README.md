# 一个在线记事本

方便多设备传输使用，屏蔽抓取机器人

多种查看类型：
- 文本
- markdown

### 参考
[Sunbalcony note](https://github.com/Sunbalcony/note)
[notepad.pw](https://notepad.pw)



### develop

```
	contentType := mime.TypeByExtension(filepath.Ext(requestedPath))
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "max-age=864000")
```