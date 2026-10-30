package notepad

import (
    "html/template"
    "net/http"
    "os"
    "testing"

    "github.com/gin-gonic/gin"
)

func TestMediaBrowserLocal(t *testing.T) {
    if os.Getenv("NOTEPAD_MEDIA_BROWSER") != "1" { t.Skip("browser-only local fixture") }
    s,r,f,_ := mediaServer(t)
    r.SetHTMLTemplate(template.Must(template.ParseFiles("../../templates/index.html")))
    s.Media.Config.PublicURL = "http://127.0.0.1:18788/media"
    r.Static("/static", "../../static")
    r.GET("/media/*key", func(c *gin.Context) { c.File("../../docs/images/1.jpg") })
    r.GET("/__media_counts",func(c *gin.Context) {c.JSON(200,gin.H{"started":f.started,"completed":f.completed,"removed":f.removed,"aborted":f.aborted})})
    if err := http.ListenAndServe("127.0.0.1:18788",r); err != nil { t.Fatal(err) }
}
