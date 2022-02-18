package notepad

import (
	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"net/http"
	"note/pkg/util"
)

func Index(ctx *gin.Context) {
	ctx.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	ctx.Header("Pragma", "no-cache")
	ctx.Header("Expires", "0")
	ctx.Redirect(http.StatusMovedPermanently, ctx.Request.URL.EscapedPath()+util.RandChar(viper.GetInt("note.keylength"))) //url path长度
}
