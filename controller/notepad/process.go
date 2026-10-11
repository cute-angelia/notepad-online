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
	tag := strings.TrimSpace(ctx.Param("id"))
	if tag == "" || tag == "favicon.ico" || tag == "robots.txt" {
		ctx.Status(http.StatusNotFound)
		return
	}

	// Tag length validation
	if len([]rune(tag)) > 128 {
		ctx.JSON(http.StatusBadRequest, gin.H{"error": "Tag length cannot exceed 128 characters"})
		return
	}

	if ctx.Request.Method == http.MethodPost {
		text := ctx.Request.FormValue("text")
		// Text length validation (max 100,000 characters)
		if len([]rune(text)) > 100000 {
			ctx.JSON(http.StatusBadRequest, gin.H{"error": "Content exceeds maximum length limit"})
			return
		}

		orm, err := igorm.GetGormMysql("notepad")
		if err != nil || orm == nil {
			ctx.JSON(http.StatusInternalServerError, gin.H{"error": "Database service unavailable"})
			return
		}

		msg := model.NotepadModel{}
		orm.Where("tag = ?", tag).First(&msg)

		now := time.Now().Format("2006-01-02 15:04:05")
		if msg.Id == 0 {
			msg.Tag = tag
			msg.Text = text
			msg.CreateTime = now
			msg.UpdateTime = now
			orm.Create(&msg)
		} else {
			orm.Model(&msg).Updates(map[string]interface{}{
				"text":        text,
				"update_time": now,
			})
		}
		ctx.JSON(http.StatusOK, gin.H{"status": "ok"})
		return
	}

	orm, err := igorm.GetGormMysql("notepad")
	if err != nil || orm == nil {
		ctx.JSON(http.StatusInternalServerError, gin.H{"error": "Database service unavailable"})
		return
	}

	msg := model.NotepadModel{}
	orm.Where("tag = ?", tag).First(&msg)

	if ctx.Request.Method == http.MethodGet {
		ctx.HTML(http.StatusOK, "index.html", gin.H{
			"title": "免登录 可分享 实时保存的记事本",
			"tag":   tag,
			"text":  msg.Text,
		})
	}
}
