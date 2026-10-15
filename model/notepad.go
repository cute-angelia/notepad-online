package model

import (
	"fmt"

	"gorm.io/gorm"
)

type NotepadModel struct {
	Id             int32  `json:"id" gorm:"primary_key"`
	Slug           string `json:"slug" gorm:"column:slug;size:32;uniqueIndex:idx_notepad_slug"`
	Title          string `json:"title" gorm:"size:800;not null;default:''"`
	Text           string `json:"text" gorm:"column:text"`
	DocumentType   string `json:"document_type" gorm:"size:16;not null;default:text"`
	Secret         string `json:"-" gorm:"size:100;not null;default:''"`
	Locked         int64  `json:"locked" gorm:"not null;default:0"`
	FailedAttempts int    `json:"-" gorm:"not null;default:0"`
	FailureDay     string `json:"-" gorm:"size:10;not null;default:''"`
	CreateTime     string `json:"create_time" gorm:"column:create_time"`
	UpdateTime     string `json:"update_time" gorm:"column:update_time"`
}

func (NotepadModel) TableName() string { return "notepad" }

type BrowserGrant struct {
	Id          uint   `gorm:"primaryKey"`
	NoteID      int32  `gorm:"not null;uniqueIndex:idx_note_browser"`
	BrowserHash string `gorm:"size:64;not null;uniqueIndex:idx_note_browser"`
	SecretHash  string `gorm:"size:100;not null"`
	ExpiresAt   int64  `gorm:"not null;index"`
}

// Migrate does not silently discard ambiguous historical records.
func Migrate(db *gorm.DB) error {
	if db.Migrator().HasTable(&NotepadModel{}) {
		if db.Migrator().HasColumn(&NotepadModel{}, "tag") && !db.Migrator().HasColumn(&NotepadModel{}, "slug") {
			if err := db.Migrator().RenameColumn(&NotepadModel{}, "tag", "slug"); err != nil {
				return fmt.Errorf("notepad migration rename tag to slug: %w", err)
			}
		}
		var duplicates int64
		col := "slug"
		if !db.Migrator().HasColumn(&NotepadModel{}, "slug") && db.Migrator().HasColumn(&NotepadModel{}, "tag") {
			col = "tag"
		}
		if err := db.Raw(fmt.Sprintf("SELECT COUNT(*) FROM (SELECT %s FROM notepad GROUP BY %s HAVING COUNT(*) > 1) AS duplicate_slugs", col, col)).Scan(&duplicates).Error; err != nil {
			return err
		}
		if duplicates > 0 {
			return fmt.Errorf("notepad migration: %d duplicate slugs; resolve duplicates before adding unique index", duplicates)
		}
	}
	if err := db.AutoMigrate(&NotepadModel{}, &BrowserGrant{}); err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&NotepadModel{}).Where("secret = ? OR secret IS NULL", "").Update("secret", "twins").Error; err != nil {
			return err
		}
		return tx.Model(&NotepadModel{}).Where("document_type = ? OR document_type IS NULL", "").Update("document_type", "text").Error
	})
}
