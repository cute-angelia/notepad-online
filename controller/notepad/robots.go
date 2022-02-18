package notepad

import (
	"github.com/gin-gonic/gin"
)

func RobotsHandle(ctx *gin.Context) {
	ctx.Writer.WriteString(`User-agent: *
Disallow: /`)
}
