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
	"note/pkg/attachments"
)

type Server struct {
	DB    *gorm.DB
	Now   func() time.Time
	Media *attachments.Service
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
	r.GET("/:id/attachments", writeGuard, s.ListAttachments)
	r.POST("/:id/attachments", writeGuard, s.BeginAttachment)
	r.PUT("/:id/attachments/:attachment/parts/:part", writeGuard, s.UploadAttachmentPart)
	r.POST("/:id/attachments/:attachment/complete", writeGuard, s.CompleteAttachment)
	r.DELETE("/:id/attachments/:attachment", writeGuard, s.DeleteAttachment)
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
func validSlug(slug string) bool {
	if slug == "" || slug == "favicon.ico" || slug == "robots.txt" || slug == "api" || slug == "static" || len([]rune(slug)) > 32 {
		return false
	}
	if strings.TrimSpace(slug) != slug || slug == "." || slug == ".." {
		return false
	}
	for _, r := range slug {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validTag(tag string) bool {
	return validSlug(tag)
}

func (s *Server) find(c *gin.Context) (model.NotepadModel, bool) {
	var n model.NotepadModel
	slug := c.Param("id")
	if !validSlug(slug) {
		status := 404
		if len([]rune(slug)) > 32 {
			status = 400
		}
		c.AbortWithStatus(status)
		return n, false
	}
	err := s.DB.Where("slug = ?", slug).First(&n).Error
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
func notePath(slug string) string { return "/" + url.PathEscape(slug) }

func noteTitle(n model.NotepadModel) string {
	if strings.TrimSpace(n.Title) == "" {
		return "未命名文档"
	}
	return n.Title
}
func (s *Server) render(c *gin.Context, n model.NotepadModel, editable, newNote bool, initialSecret, initialViewSecret, forcedType string, isPrivateLocked bool) {
	noCache(c)
	kind := n.DocumentType
	if forcedType != "" {
		kind = forcedType
	}
	title := noteTitle(n)
	if isPrivateLocked {
		title = "非公开文档"
	}
	c.HTML(http.StatusOK, "index.html", gin.H{
		"title": title, "note": n, "editable": editable,
		"newNote": newNote, "initialSecret": initialSecret, "initialViewSecret": initialViewSecret, "kind": kind,
		"locked": n.Locked > s.Now().Unix(), "lockedUntil": n.Locked,
		"isPrivate": n.IsPrivate == 1, "isPrivateLocked": isPrivateLocked,
		"editURL":     notePath(n.Slug) + "/edit",
		"viewURL":     notePath(n.Slug),
		"requestEdit": strings.HasSuffix(c.Request.URL.Path, "/edit") && !editable,
	})
}
func (s *Server) viewInternal(c *gin.Context, n model.NotepadModel, forcedType string) {
	allowed, err := s.authorized(s.DB, c, n)
	if err != nil {
		serverError(c)
		return
	}
	isViewerAllowed, err := s.authorizedViewer(s.DB, c, n)
	if err != nil {
		serverError(c)
		return
	}

	viewPwd := c.Query("view_pwd")
	pwd := c.Query("pwd")
	if !isViewerAllowed && viewPwd != "" && n.ViewSecret != "" && verifySecret(n.ViewSecret, viewPwd) {
		token, err := s.browser(c, true)
		if err == nil {
			_ = s.grant(s.DB, n, token, n.ViewSecret)
			isViewerAllowed = true
		}
	}
	if !allowed && pwd != "" && verifySecret(n.Secret, pwd) {
		token, err := s.browser(c, true)
		if err == nil {
			_ = s.grant(s.DB, n, token, n.Secret)
			allowed = true
			isViewerAllowed = true
		}
	}

	if n.IsPrivate == 1 && !isViewerAllowed {
		masked := n
		masked.Title = "非公开文档"
		masked.Text = ""
		s.render(c, masked, false, false, "", "", forcedType, true)
		return
	}
	s.render(c, n, false, false, "", "", forcedType, false)
}
func (s *Server) View(c *gin.Context) {
	if n, ok := s.find(c); ok {
		s.viewInternal(c, n, "")
	}
}
func (s *Server) Edit(c *gin.Context) {
	if n, ok := s.find(c); ok {
		allowed, err := s.authorized(s.DB, c, n)
		if err != nil {
			serverError(c)
			return
		}
		pwd := c.Query("pwd")
		if !allowed && pwd != "" && verifySecret(n.Secret, pwd) {
			token, err := s.browser(c, true)
			if err == nil {
				_ = s.grant(s.DB, n, token, n.Secret)
				allowed = true
			}
		}

		if allowed {
			s.render(c, n, true, false, n.Secret, n.ViewSecret, "", false)
			return
		}

		isViewerAllowed, err := s.authorizedViewer(s.DB, c, n)
		if err != nil {
			serverError(c)
			return
		}
		viewPwd := c.Query("view_pwd")
		if !isViewerAllowed && viewPwd != "" && n.ViewSecret != "" && verifySecret(n.ViewSecret, viewPwd) {
			token, err := s.browser(c, true)
			if err == nil {
				_ = s.grant(s.DB, n, token, n.ViewSecret)
				isViewerAllowed = true
			}
		}

		if n.IsPrivate == 1 && !isViewerAllowed {
			masked := n
			masked.Title = "非公开文档"
			masked.Text = ""
			s.render(c, masked, false, false, "", "", "", true)
			return
		}

		s.render(c, n, false, false, "", "", "", false)
	}
}
