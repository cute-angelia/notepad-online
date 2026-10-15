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
	"note/pkg/middleware"
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
	orm, err := igorm.GetGormMysql("notepad")
	if err != nil || orm == nil {
		log.Fatal("database service unavailable")
	}
	if err := model.Migrate(orm); err != nil {
		log.Fatalf("database migration failed: %v", err)
	}

	// Gin
	r := gin.Default()
	// gin.SetMode(gin.ReleaseMode)

	// 全局安全中间件：安全响应头、最大请求体限制 (5MB)
	r.Use(middleware.SecurityHeaders())
	r.Use(middleware.MaxBodySize(5 << 20))

	// 动态路由限流：每个 IP 每分钟最多 120 次请求（兼顾正常编辑与防暴力枚举）
	limiter := middleware.NewIPRateLimiter(120, time.Minute)

	// 静态及基础设施路由
	r.GET("/robots.txt", notepad.RobotsHandle)
	r.GET("/favicon.ico", func(c *gin.Context) {
		c.FileFromFS("/static/favicon.ico", http.FS(staticFS))
	})

	// 记事本业务路由
	noteGroup := r.Group("/")
	noteGroup.Use(limiter.Middleware())
	{
		notepad.NewServer(orm).RegisterRoutes(noteGroup)
	}

	// 设置模板
	templ := template.Must(template.New("").ParseFS(staticFS, "templates/*.html"))
	r.SetHTMLTemplate(templ)

	// 静态文件
	r.GET("/static/*filepath", func(c *gin.Context) {
		contentType := mime.TypeByExtension(filepath.Ext(c.Request.URL.Path))
		if contentType != "" {
			c.Header("Content-Type", contentType)
		}
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
