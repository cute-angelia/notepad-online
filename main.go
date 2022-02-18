package main

import (
	_ "embed"
	"github.com/cute-angelia/go-utils/conf"
	"github.com/cute-angelia/go-utils/db/igorm"
	"github.com/cute-angelia/go-utils/logger"
	"github.com/gin-gonic/gin"
	"github.com/spf13/viper"
	"note/controller/notepad"
	"note/model"
)

//go:embed config.toml
var configToml []byte

func main() {
	// 加载配置
	conf.MustLoadConfigByte(configToml, "toml")

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
	r.POST("/:id", notepad.ProcessHandle)
	r.GET("/:id", notepad.ProcessHandle)
	r.GET("/:id/md", notepad.MarkdownHandle)

	//apiRouter := r.Group("/api")
	//api := note.NewNoteApi()
	//apiRouter.POST("/create", api.Create)
	//apiRouter.POST("/update", api.Update)

	r.Static("./static", "./static")
	// r.LoadHTMLGlob("./static/*")
	r.LoadHTMLGlob("./static/*.html")

	port := viper.GetString("note.serverPort")
	if port != "" {
		if err := r.Run(":" + port); err != nil {
			panic(err)
		}
	}
}
