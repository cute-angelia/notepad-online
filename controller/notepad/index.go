package notepad

import (
	"crypto/rand"
	"math/big"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"note/model"
)

const slugCharset = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

func randomSlug(length int) (string, error) {
	b := make([]byte, length)
	for i := range b {
		num, err := rand.Int(rand.Reader, big.NewInt(int64(len(slugCharset))))
		if err != nil {
			return "", err
		}
		b[i] = slugCharset[num.Int64()]
	}
	return string(b), nil
}

func (s *Server) generateSlug() (string, error) {
	for i := 0; i < 5; i++ {
		slug, err := randomSlug(6)
		if err != nil {
			return "", err
		}
		var count int64
		if err := s.DB.Model(&model.NotepadModel{}).Where("slug = ?", slug).Count(&count).Error; err == nil && count == 0 {
			return slug, nil
		}
	}
	return randomSlug(8)
}

// Opening a draft does not claim an existing document or write an empty row.
func (s *Server) Index(c *gin.Context) {
	slug, err := s.generateSlug()
	if err != nil {
		serverError(c)
		return
	}
	word, err := randomWord()
	if err != nil {
		serverError(c)
		return
	}
	viewWord, err := randomWord()
	if err != nil {
		serverError(c)
		return
	}
	s.render(c, model.NotepadModel{Slug: slug, DocumentType: "markdown", IsPrivate: 0, ViewSecret: viewWord}, true, true, word, viewWord, "", false)
}
func (s *Server) Create(c *gin.Context) {
	if err := c.Request.ParseForm(); err != nil {
		c.JSON(400, gin.H{"error": "无效请求"})
		return
	}
	slug, secret := c.PostForm("slug"), c.PostForm("secret")
	viewSecret := c.PostForm("view_secret")
	if slug == "" {
		slug = c.PostForm("tag")
	}
	isPrivate := 0
	if c.PostForm("is_private") == "1" {
		isPrivate = 1
	}
	n := model.NotepadModel{Slug: slug, Title: c.PostForm("title"), Text: c.PostForm("text"), DocumentType: c.PostForm("document_type"), IsPrivate: isPrivate, ViewSecret: viewSecret}
	if !validSlug(slug) || !validSecret(secret) {
		c.JSON(400, gin.H{"error": "秘钥至少 4 个字符，最多 72 字节；文档地址必须有效"})
		return
	}
	if message := validateNote(n); message != "" {
		c.JSON(400, gin.H{"error": message})
		return
	}
	n.Secret = secret
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
		return s.grant(tx, n, token, n.Secret)
	})
	if err != nil {
		var count int64
		if e := s.DB.Model(&model.NotepadModel{}).Where("slug = ?", slug).Count(&count).Error; e == nil && count > 0 {
			c.JSON(409, gin.H{"error": "文档地址已存在，请重新新建文档"})
			return
		}
		serverError(c)
		return
	}
	c.JSON(201, gin.H{"view_url": notePath(slug), "edit_url": notePath(slug) + "/edit"})
}
