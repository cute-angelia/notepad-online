package notepad

import (
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/gin-gonic/gin"
	"net/http"
	"note/model"
	"strings"
	"time"
)

func ProcessHandle(ctx *gin.Context) {
	if ctx.Request.URL.Path == "/favicon.ico" {
		return
	}
	orm, _ := igorm.GetGormMysql("notepad")

	tag := strings.Split(ctx.Request.URL.EscapedPath(), "/")[1]
	text := ctx.Request.FormValue("text")

	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)

	// log.Println(ijson.Pretty(msg))

	if ctx.Request.Method == http.MethodPost {
		if msg.Id == 0 {
			msg.Tag = tag
			msg.Text = text
			msg.CreateTime = time.Now().Format("2006-01-02 15:04:05")
			orm.Create(&msg)
		} else {
			orm.Model(msg).UpdateColumn("text", text)
		}
	}
	if ctx.Request.Method == http.MethodGet {
		ctx.HTML(http.StatusOK, "index.html", gin.H{
			"title": "免登录 可分享 实时保存的记事本",
			"tag":   tag,
			"text":  msg.Text,
		})
	}
}
