package model

// PanelPlanConfig stores plans and client assignments in the panel database.
type PanelPlanConfig struct {
	ID        uint   `gorm:"primaryKey"`
	Plans     string `gorm:"type:text;not null"`
	Clients   string `gorm:"type:text;not null"`
	UpdatedAt int64  `gorm:"autoUpdateTime"`
}
