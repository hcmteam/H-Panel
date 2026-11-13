package controller

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/mhsanaei/3x-ui/v3/internal/database"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"gorm.io/gorm"
)

type planConfigPayload struct {
	Plans   json.RawMessage `json:"plans"`
	Clients json.RawMessage `json:"clients"`
}

// getPlanConfig returns panel-wide plans and client assignments from the VPS database.
func (a *ClientController) getPlanConfig(c *gin.Context) {
	var cfg model.PanelPlanConfig
	err := database.GetDB().First(&cfg, 1).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		jsonObj(c, nil, err)
		return
	}
	plans := json.RawMessage(cfg.Plans)
	clients := json.RawMessage(cfg.Clients)
	if len(plans) == 0 {
		plans = json.RawMessage(`[]`)
	}
	if len(clients) == 0 {
		clients = json.RawMessage(`[]`)
	}
	jsonObj(c, gin.H{"plans": plans, "clients": clients, "configured": err == nil}, nil)
}

// savePlanConfig persists plan definitions and client links across browsers and restarts.
func (a *ClientController) savePlanConfig(c *gin.Context) {
	var req planConfigPayload
	if err := c.ShouldBindJSON(&req); err != nil {
		jsonObj(c, nil, err)
		return
	}
	if len(req.Plans) == 0 || !json.Valid(req.Plans) || len(req.Clients) == 0 || !json.Valid(req.Clients) {
		pureJsonMsg(c, http.StatusBadRequest, false, "Invalid plan configuration")
		return
	}
	cfg := model.PanelPlanConfig{ID: 1, Plans: string(req.Plans), Clients: string(req.Clients)}
	if err := database.GetDB().Save(&cfg).Error; err != nil {
		jsonObj(c, nil, err)
		return
	}
	jsonObj(c, gin.H{"plans": req.Plans, "clients": req.Clients}, nil)
}
