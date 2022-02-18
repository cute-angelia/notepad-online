package notepad

import (
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/gin-gonic/gin"
	"note/model"
	"strings"
)

func RawHandle(ctx *gin.Context) {
	tag := strings.Split(ctx.Request.URL.EscapedPath(), "/")[1]

	orm, _ := igorm.GetGormMysql("notepad")
	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)

	ctx.Writer.WriteString(msg.Text)
}
