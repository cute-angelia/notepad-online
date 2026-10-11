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

	keyLength := viper.GetInt("note.keylength")
	if keyLength <= 0 {
		keyLength = 6
	}

	ctx.Redirect(http.StatusFound, "/"+util.RandChar(keyLength))
}
