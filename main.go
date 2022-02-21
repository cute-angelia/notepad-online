package main

import (
	"embed"
	_ "embed"
	"github.com/cute-angelia/go-utils/conf"
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/cute-angelia/go-utils/logger"
	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"html/template"
	"log"
	"mime"
	"net/http"
	"note/controller/notepad"
	"note/model"
	"path"
	"path/filepath"
	"strings"
	"time"
)

//go:embed static/* templates/*
var staticFS embed.FS

func main() {
	// 加载配置
	conf.MustLoadConfigFile("config.toml")

	// 日志
	logger.NewLogger("notepad", viper.GetBool("note.wirteLogFile"))

	// 初始化数据库
	igorm.Load("notepad").Build(
		igorm.WithDsn(viper.GetString("note.mysqDsn")),
		igorm.WithMaxIdleConns(0),
		igorm.WithMaxOpenConnss(10),
	).MustInitMysql()

	// 初始化表结构
	orm, _ := igorm.GetGormMysql("notepad")
	orm.AutoMigrate(&model.NotepadModel{})

	// Gin
	r := gin.Default()
	// gin.SetMode(gin.ReleaseMode)

	// router
	r.GET("/", notepad.Index)
	r.GET("/robots.txt", notepad.RobotsHandle)
	r.POST("/:id", notepad.ProcessHandle)
	r.GET("/:id", notepad.ProcessHandle)
	r.GET("/:id/md", notepad.MarkdownHandle)
	r.GET("/:id/raw", notepad.RawHandle)

	//apiRouter := r.Group("/api")
	//api := note.NewNoteApi()
	//apiRouter.POST("/create", api.Create)
	//apiRouter.POST("/update", api.Update)
	// r.Static("./static", "./static")

	// 设置模板
	templ := template.Must(template.New("").ParseFS(staticFS, "templates/*.html"))
	r.SetHTMLTemplate(templ)
	// r.LoadHTMLGlob("./static/*.html")

	// 静态文件
	// r.StaticFS("/static", http.FS(staticFS))
	r.GET("/static/*filepath", func(c *gin.Context) {
		contentType := mime.TypeByExtension(filepath.Ext(c.Request.URL.Path))
		c.Header("Cache-Type", contentType)
		c.Header("Cache-Control", "public, max-age=31536000")

		etag := time.Now().Format("20060102150405")
		c.Header("ETag", etag)
		if match := c.GetHeader("If-None-Match"); match != "" {
			if strings.Contains(match, etag) {
				c.Status(http.StatusNotModified)
				return
			}
		}

		c.FileFromFS(path.Join("/", c.Request.URL.Path), http.FS(staticFS))
	})

	port := viper.GetString("note.serverPort")
	log.Println("run: http://127.0.0.1:" + port)
	if err := r.Run(":" + port); err != nil {
		panic(err)
	}
}
