package main

import (
	"embed"
	_ "embed"
	"errors"
	"github.com/cute-angelia/go-xutils/components/igorm"
	"github.com/cute-angelia/go-xutils/components/loggers/logger"
	"github.com/cute-angelia/go-xutils/utils/conf"
	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"html/template"
	"log"
	"mime"
	"net/http"
	"note/controller/notepad"
	"note/model"
	"note/pkg/middleware"
	"note/pkg/webserver"
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
	igorm.New(
		igorm.WithDbName("notepad"),
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

	// 设置模板（需在注册路由前调用）
	templ := template.Must(template.New("").ParseFS(staticFS, "templates/*.html"))
	r.SetHTMLTemplate(templ)

	// 全局安全中间件：安全响应头、最大请求体限制 (5MB)
	r.Use(middleware.SecurityHeaders())
	r.Use(middleware.MaxBodySize(5 << 20))

	// 动态路由限流：每个 IP 每分钟最多 120 次请求（兼顾正常编辑与防暴力枚举）
	limiter := middleware.NewIPRateLimiter(120, time.Minute)
	// 防乱扫路径：1分钟内累计 10 次 404 则封禁 IP 10 分钟
	scanBanLimiter := middleware.NewIPScanBanLimiter(10, time.Minute, 10*time.Minute)

	// 静态及基础设施路由
	r.GET("/robots.txt", notepad.RobotsHandle)
	r.GET("/favicon.ico", func(c *gin.Context) {
		c.FileFromFS("/static/favicon.ico", http.FS(staticFS))
	})

	// 记事本业务路由
	noteGroup := r.Group("/")
	noteGroup.Use(scanBanLimiter.Middleware())
	noteGroup.Use(limiter.Middleware())
	{
		notepad.NewServer(orm).RegisterRoutes(noteGroup)
	}

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
	viper.SetDefault("note.ssl.cert_file", "ssl/fullchain.cer")
	viper.SetDefault("note.ssl.key_file", "ssl/home.shixinyi.cn.key")

	server, err := webserver.New(":"+port, r,
		viper.GetString("note.ssl.cert_file"),
		viper.GetString("note.ssl.key_file"))
	if err != nil {
		log.Fatal(err)
	}

	if server.TLSConfig != nil {
		log.Printf("notepad-online 启动 HTTP + HTTPS, port: %s", port)
	} else {
		log.Printf("notepad-online 启动 HTTP, port: %s", port)
	}

	if err := webserver.ListenAndServe(server); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
