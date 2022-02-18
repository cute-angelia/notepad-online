package model

type NotepadModel struct {
	Id         int32  `json:"id" gorm:"primary_key"`
	Tag        string `json:"tag" gorm:"column:tag"`
	Text       string `json:"text" gorm:"column:text"`
	CreateTime string `json:"create_time" gorm:"column:create_time"`
	UpdateTime string `json:"update_time" gorm:"column:update_time"`
}

func (NotepadModel) TableName() string {
	return "notepad"
}
