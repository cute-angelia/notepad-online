package notepad
import("net/http";"os";"testing";"note/model")
func TestLocalPreview(t *testing.T){if os.Getenv("NOTEPAD_LOCAL_PREVIEW")!="1"{t.Skip("local preview")};s,r:=testServer(t);s.DB.Create(&model.NotepadModel{Slug:"outline",Title:"一份有条理的随记",Text:"## 开始记录\n\n把零散的想法记下来。\n\n### 整理成表格\n\n| 项目 | 状态 |\n| --- | --- |\n| 编辑目录 | 已支持 |\n| 查看目录 | 已支持 |\n\n### 分享给朋友\n\n只读链接，让分享更简单。\n\n## 下一步\n\n继续写下新的想法。",DocumentType:"markdown"});if err:=model.Migrate(s.DB);err!=nil{t.Fatal(err)};r.Static("/static","../../static");if err:=http.ListenAndServe("127.0.0.1:18787",r);err!=nil{t.Fatal(err)}}
