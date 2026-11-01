package notepad

import (
	"html/template"
	"net/http"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"note/model"
)

// Opt-in fixture uses an in-memory DB and fake storage; it never touches MinIO.
func TestAttachmentReviewBrowserLocal(t *testing.T) {
	if os.Getenv("NOTEPAD_ATTACHMENT_REVIEW_BROWSER") != "1" {
		t.Skip("browser-only local fixture")
	}
	s, r, f, _ := mediaServer(t)
	r.SetHTMLTemplate(template.Must(template.ParseFiles("../../templates/index.html")))
	s.Media.Config.PublicURL = "http://127.0.0.1:18790/media"
	seedReviewAttachment(t, s, "unused-browser", true)
	used := seedReviewAttachment(t, s, "used-browser", true)
	source := "# 附件整理测试\n\n![已使用图片](" + s.Media.URL(used.ObjectKey) + ")\n\n可以剪切上方图片，再粘贴到这里。"
	if err := s.DB.Model(&model.NotepadModel{}).Where("slug = ?", "media-note").Updates(map[string]any{"text": source, "title": "附件整理测试"}).Error; err != nil {
		t.Fatal(err)
	}
	r.Static("/static", "../../static")
	r.GET("/media/*key", func(c *gin.Context) { c.File("../../docs/images/1.jpg") })
	r.GET("/__media_counts", func(c *gin.Context) {
		c.JSON(200, gin.H{"removed": f.removed, "aborted": f.aborted})
	})
	if err := http.ListenAndServe("127.0.0.1:18790", r); err != nil {
		t.Fatal(err)
	}
}
