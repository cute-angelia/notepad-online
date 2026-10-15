package notepad

import (
	"encoding/base64"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"note/model"
)

// Opening a draft does not claim an existing document or write an empty row.
func (s *Server) Index(c *gin.Context) {
	token, err := randomToken()
	if err != nil {
		serverError(c)
		return
	}
	raw, _ := base64.RawURLEncoding.DecodeString(token)
	tag := base64.RawURLEncoding.EncodeToString(raw[:16])
	word, err := randomWord()
	if err != nil {
		serverError(c)
		return
	}
	s.render(c, model.NotepadModel{Tag: tag, DocumentType: "markdown"}, true, true, word, "")
}
func (s *Server) Create(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(400, gin.H{"error": "无效请求"})
		return
	}
	tag, secret := c.PostForm("tag"), c.PostForm("secret")
	n := model.NotepadModel{Tag: tag, Title: c.PostForm("title"), Text: c.PostForm("text"), DocumentType: c.PostForm("document_type")}
	if !validTag(tag) || !validSecret(secret) {
		c.JSON(400, gin.H{"error": "秘钥至少 4 个字符，最多 72 字节；文档地址必须有效"})
		return
	}
	if message := validateNote(n); message != "" {
		c.JSON(400, gin.H{"error": message})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.DefaultCost)
	if err != nil {
		serverError(c)
		return
	}
	n.Secret = string(hash)
	now := s.Now().Format("2006-01-02 15:04:05")
	n.CreateTime = now
	n.UpdateTime = now
	token, err := s.browser(c, true)
	if err != nil {
		serverError(c)
		return
	}
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&n).Error; e != nil {
			return e
		}
		return s.grant(tx, n, token)
	})
	if err != nil {
		var count int64
		if e := s.DB.Model(&model.NotepadModel{}).Where("tag = ?", tag).Count(&count).Error; e == nil && count > 0 {
			c.JSON(409, gin.H{"error": "文档地址已存在，请重新新建文档"})
			return
		}
		serverError(c)
		return
	}
	c.JSON(201, gin.H{"view_url": notePath(tag), "edit_url": notePath(tag) + "/edit"})
}
