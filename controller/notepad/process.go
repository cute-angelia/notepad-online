package notepad

import (
	"errors"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"note/model"
)

func validateNote(n model.NotepadModel) string {
	if len([]rune(n.Text)) > 100000 {
		return "正文不能超过 100,000 个字符"
	}
	if len([]rune(n.Title)) > 200 {
		return "标题不能超过 200 个字符"
	}
	if n.DocumentType != "text" && n.DocumentType != "markdown" && n.DocumentType != "code" {
		return "请选择纯文本、Markdown 或代码模式"
	}
	return ""
}
func (s *Server) Save(c *gin.Context) {
	if !validSlug(c.Param("id")) {
		status := 404
		if len([]rune(c.Param("id"))) > 32 {
			status = 400
		}
		c.Status(status)
		return
	}
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(400, gin.H{"error": "无效请求"})
		return
	}
	if len([]rune(c.PostForm("text"))) > 100000 {
		c.JSON(400, gin.H{"error": "正文不能超过 100,000 个字符"})
		return
	}
	secret := c.PostForm("secret")
	if secret != "" && !validSecret(secret) {
		c.JSON(400, gin.H{"error": "秘钥至少 4 个字符，最多 72 字节"})
		return
	}
	status := 200
	var until int64
	var savedVersion int64
	message := ""
	err := s.DB.Transaction(func(tx *gorm.DB) error {
		var n model.NotepadModel
		if e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("slug = ?", c.Param("id")).First(&n).Error; e != nil {
			if errors.Is(e, gorm.ErrRecordNotFound) {
				status = 404
				return nil
			}
			return e
		}
		now := s.Now()
		normalizeLock(&n, now)
		if n.Locked > now.Unix() {
			status = 423
			until = n.Locked
			return nil
		}
		allowed, e := s.authorized(tx, c, n)
		if e != nil {
			return e
		}
		if !allowed {
			status = 403
			return nil
		}
		if c.PostForm("version") == "" {
			status = 428
			return nil
		}
		version, err := strconv.ParseInt(c.PostForm("version"), 10, 64)
		if err != nil || version < 1 {
			status = 400
			message = "文档版本无效，请保留当前修改后刷新页面"
			return nil
		}
		if version != n.Version {
			status = 409
			return nil
		}
		if _, ok := c.Request.PostForm["text"]; ok {
			n.Text = c.PostForm("text")
		}
		if _, ok := c.Request.PostForm["title"]; ok {
			n.Title = c.PostForm("title")
		}
		if _, ok := c.Request.PostForm["document_type"]; ok {
			n.DocumentType = c.PostForm("document_type")
		}
		if val, ok := c.Request.PostForm["is_private"]; ok {
			if len(val) > 0 && val[0] == "1" {
				n.IsPrivate = 1
			} else {
				n.IsPrivate = 0
			}
		}
		if val, ok := c.Request.PostForm["view_secret"]; ok {
			n.ViewSecret = val[0]
		}
		if message = validateNote(n); message != "" {
			status = 400
			return nil
		}
		secretChanged := secret != "" && !verifySecret(n.Secret, secret)
		if secretChanged {
			n.Secret = secret
		}
		updates := lockFields(n)
		updates["text"] = n.Text
		updates["title"] = n.Title
		updates["document_type"] = n.DocumentType
		updates["is_private"] = n.IsPrivate
		updates["view_secret"] = n.ViewSecret
		updates["secret"] = n.Secret
		updates["update_time"] = s.Now().Format("2006-01-02 15:04:05")
		updates["version"] = gorm.Expr("version + 1")
		// Compare and increment in the same write, even on databases without row locks.
		result := tx.Model(&n).Where("version = ?", version).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			status = 409
			return nil
		}
		savedVersion = version + 1
		if e = model.SyncNoteLinks(tx, n); e != nil {
			return e
		}
		if secretChanged {
			token, e := s.browser(c, true)
			if e != nil {
				return e
			}
			if e = tx.Where("note_id = ?", n.Id).Delete(&model.BrowserGrant{}).Error; e != nil {
				return e
			}
			return s.grant(tx, n, token, n.Secret)
		}
		return nil
	})
	if err != nil {
		serverError(c)
		return
	}
	switch status {
	case 409:
		c.JSON(409, gin.H{"error": "文档已在其他页面或设备更新，本次修改未保存", "code": "version_conflict"})
	case 428:
		c.JSON(428, gin.H{"error": "缺少文档版本，请保留当前修改后刷新页面", "code": "version_required"})
	case 423:
		lockedReply(c, until)
	case 403:
		c.JSON(403, gin.H{"error": "编辑授权已失效，请重新输入秘钥"})
	case 404:
		c.Status(404)
	case 400:
		c.JSON(400, gin.H{"error": message})
	default:
		c.JSON(200, gin.H{"status": "ok", "version": savedVersion})
	}
}
