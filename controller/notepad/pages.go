package notepad

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"note/model"
	"note/pkg/middleware"
)

type pageSummary struct {
	ID    int32  `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

func summarizePage(n model.NotepadModel) pageSummary {
	return pageSummary{ID: n.Id, Title: noteTitle(n), URL: "/api/pages/" + strconv.FormatInt(int64(n.Id), 10) + "/view"}
}

func parsePageID(value string) (int32, bool) {
	id, err := strconv.ParseInt(value, 10, 32)
	return int32(id), err == nil && id > 0 && strconv.FormatInt(id, 10) == value
}

func (s *Server) findPage(c *gin.Context, resolve bool) (model.NotepadModel, bool) {
	noCache(c)
	var note model.NotepadModel
	query := s.DB
	if resolve && c.Query("slug") != "" {
		if !validSlug(c.Query("slug")) {
			c.Status(404)
			return note, false
		}
		query = query.Where("slug = ?", c.Query("slug"))
	} else {
		value := c.Param("pageID")
		if resolve {
			value = c.Query("id")
		}
		id, ok := parsePageID(value)
		if !ok {
			c.Status(404)
			return note, false
		}
		query = query.Where("id = ?", id)
	}
	if err := query.First(&note).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			middleware.ExpectedResourceMiss(c)
		} else {
			serverError(c)
		}
		return note, false
	}
	return note, true
}

func (s *Server) readablePage(c *gin.Context, note model.NotepadModel) (bool, error) {
	if note.IsPrivate != 1 {
		return true, nil
	}
	return s.authorizedViewer(s.DB, c, note)
}

func (s *Server) pageRead(c *gin.Context, resolve bool) {
	note, ok := s.findPage(c, resolve)
	if !ok {
		return
	}
	allowed, err := s.readablePage(c, note)
	if err != nil {
		serverError(c)
		return
	}
	if !allowed {
		c.Status(http.StatusForbidden)
		return
	}
	c.JSON(200, struct {
		pageSummary
		Text         string `json:"text"`
		DocumentType string `json:"document_type"`
	}{summarizePage(note), note.Text, note.DocumentType})
}

func (s *Server) ReadPage(c *gin.Context)    { s.pageRead(c, false) }
func (s *Server) ResolvePage(c *gin.Context) { s.pageRead(c, true) }

func (s *Server) PageView(c *gin.Context) {
	if note, ok := s.findPage(c, false); ok {
		s.viewInternal(c, note, "")
	}
}

func (s *Server) PageBacklinks(c *gin.Context) {
	note, ok := s.findPage(c, false)
	if !ok {
		return
	}
	allowed, err := s.readablePage(c, note)
	if err != nil {
		serverError(c)
		return
	}
	if !allowed {
		c.Status(http.StatusForbidden)
		return
	}
	var sources []model.NotepadModel
	// The unique source subquery deduplicates link + embed edges from one page.
	query := s.DB.Model(&model.NotepadModel{}).Select("id", "title").Where("id IN (?)", s.DB.Model(&model.NoteLink{}).Select("source_note_id").Where("target_note_id = ?", note.Id))
	token, err := s.browser(c, false)
	if err != nil {
		serverError(c)
		return
	}
	if token == "" {
		query = query.Where("is_private <> ?", 1)
	} else {
		grants := s.DB.Model(&model.BrowserGrant{}).Select("1").Where("note_id = notepad.id AND browser_hash = ? AND expires_at > ?", hashToken(token), s.Now().Unix()).Where("secret_hash = notepad.secret OR (notepad.view_secret <> '' AND secret_hash = notepad.view_secret)")
		query = query.Where("is_private <> ? OR EXISTS (?)", 1, grants)
	}
	err = query.Order("id DESC").Limit(100).Find(&sources).Error
	if err != nil {
		serverError(c)
		return
	}
	result := make([]pageSummary, 0)
	for _, source := range sources {
		result = append(result, summarizePage(source))
	}
	c.JSON(200, gin.H{"backlinks": result})
}
