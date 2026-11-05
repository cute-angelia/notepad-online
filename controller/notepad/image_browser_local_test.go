package notepad

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
)

// Opt-in, in-memory fixture for checking image layout on desktop and mobile.
func TestImageBrowserLocal(t *testing.T) {
	if os.Getenv("NOTEPAD_IMAGE_BROWSER") != "1" {
		t.Skip("browser-only local fixture")
	}
	_, r := testServer(t)
	owner := createNote(t, r, "image-preview")
	text := "## 横图\n\n![横向图片](/__images/wide)\n\n## 长图\n\n![长截图](/__images/tall)\n\n## 小图\n\n![小图](/__images/small)\n\n## 图片链接\n\n[![链接图片](/__images/small)](/image-preview)\n\n## 加载失败\n\n![失效图片](/__images/missing)"
	w := request(r, http.MethodPost, "/image-preview", url.Values{
		"version": {"1"},
		"text":    {text}, "title": {"图片阅读预览"}, "document_type": {"markdown"},
	}, owner...)
	if w.Code != http.StatusOK {
		t.Fatalf("seed images: %d %s", w.Code, w.Body.String())
	}
	r.Static("/static", "../../static")
	r.GET("/__images/:kind", func(c *gin.Context) {
		width, height := 1600, 900
		switch c.Param("kind") {
		case "tall":
			width, height = 900, 4800
		case "small":
			width, height = 80, 40
		case "wide":
		default:
			c.Status(http.StatusNotFound)
			return
		}
		c.Data(http.StatusOK, "image/svg+xml", []byte(fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#d9e2d5"/><stop offset="1" stop-color="#7e9a8a"/></linearGradient></defs><rect width="100%%" height="100%%" fill="url(#g)"/><path d="M0 %dL%d 0M0 0L%d %d" stroke="#ffffff" stroke-width="4"/><text x="24" y="36" fill="#243b32" font-size="24">%d x %d</text></svg>`, width, height, height, width, width, height, width, height)))
	})
	if err := http.ListenAndServe("127.0.0.1:18789", r); err != nil {
		t.Fatal(err)
	}
}
