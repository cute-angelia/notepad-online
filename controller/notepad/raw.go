package notepad

import (
	"net/http"
	"strings"

	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/gin-gonic/gin"
	"note/model"
)

func RawHandle(ctx *gin.Context) {
	tag := strings.TrimSpace(ctx.Param("id"))
	if tag == "" || tag == "favicon.ico" || tag == "robots.txt" {
		ctx.Status(http.StatusNotFound)
		return
	}

	orm, err := igorm.GetGormMysql("notepad")
	if err != nil || orm == nil {
		ctx.Status(http.StatusInternalServerError)
		return
	}
	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)

	ctx.Header("Content-Type", "text/plain; charset=utf-8")
	ctx.Header("X-Content-Type-Options", "nosniff")
	ctx.String(http.StatusOK, msg.Text)
}
