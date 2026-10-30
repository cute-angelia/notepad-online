package main

import (
	"testing"
	"time"

	"github.com/spf13/viper"
)

func TestMediaConfigDisabledWithoutSettingsAndTimeoutUnits(t *testing.T) {
	viper.Reset()
	t.Cleanup(viper.Reset)
	if cfg := mediaConfig(); cfg.Enabled {
		t.Fatal("media enabled without configuration")
	}
	viper.Set("minio.enabled", true)
	viper.Set("minio.endPoint", "127.0.0.1:9000")
	viper.Set("minio.bucket", "media")
	viper.Set("minio.timeout", 120)
	viper.Set("minio.imageMaxSize", int64(20<<20))
	viper.Set("minio.videoMaxSize", int64(5<<30))
	cfg := mediaConfig()
	if cfg.Timeout != 2*time.Minute || cfg.EndPoint != "127.0.0.1:9000" || cfg.Bucket != "media" || cfg.ImageMaxSize != 20<<20 || cfg.VideoMaxSize != 5<<30 {
		t.Fatalf("configuration mapping incorrect: %+v", cfg)
	}
	viper.Set("minio.timeout", "90s")
	if cfg = mediaConfig(); cfg.Timeout != 90*time.Second {
		t.Fatalf("duration string=%v", cfg.Timeout)
	}
}
