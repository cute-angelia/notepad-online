package notepad

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"note/model"
)

func (s *Server) Raw(c *gin.Context) {
	if n, ok := s.find(c); ok {
		now := s.Now()
		normalizeLock(&n, now)
		if n.Locked > now.Unix() {
			lockedReply(c, n.Locked)
			return
		}

		if n.IsPrivate == 1 {
			allowed, err := s.authorizedViewer(s.DB, c, n)
			if err != nil {
				serverError(c)
				return
			}
			viewPwd := c.Query("view_pwd")
			pwd := c.Query("pwd")
			hasInput := viewPwd != "" || pwd != ""
			if !allowed && viewPwd != "" && n.ViewSecret != "" && verifySecret(n.ViewSecret, viewPwd) {
				token, err := s.browser(c, true)
				if err == nil {
					_ = s.grant(s.DB, n, token, n.ViewSecret)
					allowed = true
				}
			}
			if !allowed && pwd != "" && verifySecret(n.Secret, pwd) {
				token, err := s.browser(c, true)
				if err == nil {
					_ = s.grant(s.DB, n, token, n.Secret)
					allowed = true
				}
			}
			if !allowed {
				if hasInput {
					_ = s.DB.Transaction(func(tx *gorm.DB) error {
						var latest model.NotepadModel
						if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("slug = ?", n.Slug).First(&latest).Error; err != nil {
							return err
						}
						normalizeLock(&latest, now)
						recordFailure(&latest, now)
						return tx.Model(&latest).Updates(lockFields(latest)).Error
					})
				}
				c.AbortWithStatusJSON(403, gin.H{"error": "私密文档，需要输入秘钥访问"})
				return
			}
		}
		noCache(c)
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Header("X-Content-Type-Options", "nosniff")
		c.String(200, n.Text)
	}
}
