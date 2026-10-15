package notepad

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"note/model"
)

type Server struct {
	DB  *gorm.DB
	Now func() time.Time
}

func NewServer(db *gorm.DB) *Server { return &Server{DB: db, Now: time.Now} }
func (s *Server) RegisterRoutes(r gin.IRouter) {
	r.GET("/", s.Index)
	r.POST("/api/notes", writeGuard, s.Create)
	r.GET("/api/secret", s.RandomSecret)
	r.GET("/:id", s.View)
	r.GET("/:id/edit", s.Edit)
	r.GET("/:id/md", s.Markdown)
	r.GET("/:id/raw", s.Raw)
	r.POST("/:id", writeGuard, s.Save)
	r.POST("/:id/unlock", writeGuard, s.Unlock)
}
func writeGuard(c *gin.Context) {
	if c.GetHeader("X-Notepad-Request") != "1" {
		c.AbortWithStatusJSON(403, gin.H{"error": "请从本站页面操作"})
		return
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !strings.EqualFold(u.Host, c.Request.Host) {
			c.AbortWithStatusJSON(403, gin.H{"error": "不允许跨站修改文档"})
			return
		}
	}
	if site := c.GetHeader("Sec-Fetch-Site"); site == "cross-site" {
		c.AbortWithStatusJSON(403, gin.H{"error": "不允许跨站修改文档"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Next()
}
func validTag(tag string) bool {
	if tag == "" || tag == "favicon.ico" || tag == "robots.txt" || len([]rune(tag)) > 128 {
		return false
	}
	if strings.TrimSpace(tag) != tag || tag == "." || tag == ".." {
		return false
	}
	for _, r := range tag {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func (s *Server) find(c *gin.Context) (model.NotepadModel, bool) {
	var n model.NotepadModel
	tag := c.Param("id")
	if !validTag(tag) {
		status := 404
		if len([]rune(tag)) > 128 {
			status = 400
		}
		c.AbortWithStatus(status)
		return n, false
	}
	err := s.DB.Where("tag = ?", tag).First(&n).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.AbortWithStatus(404)
		return n, false
	}
	if err != nil {
		serverError(c)
		return n, false
	}
	return n, true
}
func serverError(c *gin.Context) {
	c.JSON(500, gin.H{"error": "保存服务暂不可用，请稍后重试"})
}
func noCache(c *gin.Context) {
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Header("Pragma", "no-cache")
	c.Header("Expires", "0")
}
func notePath(tag string) string { return "/" + url.PathEscape(tag) }

func noteTitle(n model.NotepadModel) string {
	if strings.TrimSpace(n.Title) == "" {
		return "未命名文档"
	}
	return n.Title
}
func (s *Server) render(c *gin.Context, n model.NotepadModel, editable, newNote bool, initialSecret, forcedType string) {
	noCache(c)
	kind := n.DocumentType
	if forcedType != "" {
		kind = forcedType
	}
	c.HTML(http.StatusOK, "index.html", gin.H{
		"title": noteTitle(n), "note": n, "editable": editable,
		"newNote": newNote, "initialSecret": initialSecret, "kind": kind,
		"locked": n.Locked > s.Now().Unix(), "lockedUntil": n.Locked,
		"editURL":     notePath(n.Tag) + "/edit",
		"requestEdit": strings.HasSuffix(c.Request.URL.Path, "/edit") && !editable,
	})
}
func (s *Server) View(c *gin.Context) {
	if n, ok := s.find(c); ok {
		s.render(c, n, false, false, "", "")
	}
}
func (s *Server) Edit(c *gin.Context) {
	if n, ok := s.find(c); ok {
		allowed, err := s.authorized(s.DB, c, n)
		if err != nil {
			serverError(c)
			return
		}
		s.render(c, n, allowed, false, "", "")
	}
}
