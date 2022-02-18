package notepad

import (
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/gin-gonic/gin"
	"net/http"
	"note/model"
	"strings"
)

func MarkdownHandle(ctx *gin.Context) {
	tag := strings.Split(ctx.Request.URL.EscapedPath(), "/")[1]

	orm, _ := igorm.GetGormMysql("notepad")
	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)
	
	ctx.HTML(http.StatusOK, "markdown.html", gin.H{"title": "免登录 可分享 实时保存的记事本", "text": msg.Text})
}
