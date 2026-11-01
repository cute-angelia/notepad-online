package model

import (
	"path/filepath"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAttachmentRetentionSurvivesDatabaseReopen(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "retention.db")
	open := func() *gorm.DB {
		t.Helper()
		db, err := gorm.Open(sqlite.Open(filename), &gorm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		sqlDB, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { sqlDB.Close() })
		if err := Migrate(db); err != nil {
			t.Fatal(err)
		}
		return db
	}
	db := open()
	if err := db.Create(&Attachment{ID: "kept", NoteID: 1, Complete: true}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&Attachment{}).Where("id = ?", "kept").Update("retained", true).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := open()
	var attachment Attachment
	if err := reopened.First(&attachment, "id = ?", "kept").Error; err != nil {
		t.Fatal(err)
	}
	if !attachment.Retained {
		t.Fatal("retention was not persisted to the database file")
	}
}
