package notepad

import (
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/gin-gonic/gin"
	"net/http"
	"note/model"
	"strings"
)

func MarkdownHandle(ctx *gin.Context) {
	tag := strings.TrimSpace(ctx.Param("id"))
	if tag == "" || tag == "favicon.ico" || tag == "robots.txt" {
		ctx.Status(http.StatusNotFound)
		return
	}

	orm, err := igorm.GetGormMysql("notepad")
	if err != nil || orm == nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "Database service unavailable"})
		return
	}
	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)

	ctx.HTML(http.StatusOK, "markdown.html", gin.H{
		"title": "免登录 可分享 实时保存的记事本",
		"tag":   tag,
		"text":  msg.Text,
	})
}
