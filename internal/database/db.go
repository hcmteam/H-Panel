Warning: truncated output (original token count: 27617)
Total output lines: 3705

package database

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/mhsanaei/3x-ui/v3/internal/config"
	"github.com/mhsanaei/3x-ui/v3/internal/database/model"
	"github.com/mhsanaei/3x-ui/v3/internal/util/crypto"
	"github.com/mhsanaei/3x-ui/v3/internal/util/maskcompat"
	"github.com/mhsanaei/3x-ui/v3/internal/util/random"
	"github.com/mhsanaei/3x-ui/v3/internal/xray"

	"github.com/mattn/go-sqlite3"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

var db *gorm.DB

var backupSQLiteTimeout = 2 * time.Minute

const (
	DialectSQLite   = "sqlite"
	DialectPostgres = "postgres"
)

func IsPostgres() bool {
	if db == nil {
		return config.GetDBKind() == "postgres"
	}
	return db.Name() == "postgres"
}

func Dialect() string {
	if db == nil {
		return ""
	}
	return db.Name()
}

const sqliteBackupDirPrefix = ".x-ui-backup-"

func allModels() []any {
	return []any{
		&model.User{},
		&model.Inbound{},
		&model.OutboundTraffics{},
		&model.Setting{},
		&model.InboundClientIps{},
		&xray.ClientTraffic{},
		&model.HistoryOfSeeders{},
		&model.Node{},
		&model.ApiToken{},
		&model.ClientRecord{},
		&model.ClientInbound{},
		&model.ClientHwid{},
		&model.ClientExternalLink{},
		&model.ClientGroup{},
		&model.PanelPlanConfig{},
		&model.InboundFallback{},
		&model.Host{},
		&model.HostTombstone{},
		&model.NodeClientTraffic{},
		&model.NodeClientIp{},
		&model.ClientGlobalTraffic{},
		&model.NodePendingReset{},
		&model.OutboundSubscription{},
		&model.SubBalancer{},
		&model.TuicTrafficReceipt{},
	}
}

func migrateClientTrafficLastSubFetchColumn() error {
	migrator := db.Migrator()
	if !migrator.HasTable(&xray.ClientTraffic{}) || migrator.HasColumn(&xray.ClientTraffic{}, "last_sub_fetch") {
		return nil
	}
	return migrator.AddColumn(&xray.ClientTraffic{}, "LastSubFetch")
}

func migrateOutboundSubscriptionUserAgentColumn() error {
	migrator := db.Migrator()
	if !migrator.HasTable(&model.OutboundSubscription{}) || migrator.HasColumn(&model.OutboundSubscription{}, "user_agent") {
		return nil
	}
	return migrator.AddColumn(&model.OutboundSubscription{}, "UserAgent")
}

func migrateInboundExcludeFromSubColumn() error {
	migrator := db.Migrator()
	if !migrator.HasTable(&model.Inbound{}) || migrator.HasColumn(&model.Inbound{}, "exclude_from_sub") {
		return nil
	}
	return migrator.AddColumn(&model.Inbound{}, "ExcludeFromSub")
}

func migrateClientKeepAliveRangeColumn() error {
	migrator := db.Migrator()
	if !migrator.HasTable(&model.ClientRecord{}) || migrator.HasColumn(&model.ClientRecord{}, "wg_keep_alive_range") {
		return nil
	}
	return migrator.AddColumn(&model.ClientRecord{}, "KeepAliveRange")
}

func initModels() error {
	if err := migrateClientKeepAliveRangeColumn(); err != nil {
		return err
	}
	if err := migrateClientTrafficLastSubFetchColumn(); err != nil {
		return err
	}
	if err := migrateOutboundSubscriptionUserAgentColumn(); err != nil {
		return err
	}
	if err := migrateInboundExcludeFromSubColumn(); err != nil {
		return err
	}
	models := allModels()
	for _, mdl := range models {
		if IsPostgres() && postgresModelSettled(mdl) {
			continue
		}
		if err := db.AutoMigrate(mdl); err != nil {
			if isIgnorableDuplicateColumnErr(db, err, mdl) {
				log.Printf("Ignoring duplicate column during auto migration for %T: %v", mdl, err)
				continue
			}
			log.Printf("Error auto migrating model: %v", err)
			return err
		}
	}
	if err := dropLegacyInboundPortUnique(); err != nil {
		return err
	}
	if err := migrateHostVerifyPeerCertByNameColumn(); err != nil {
		return err
	}
	if err := normalizeApiTokenCreatedAtSeconds(); err != nil {
		return err
	}
	if err := migrateApiTokenScopeAndExpiry(); err != nil {
		return err
	}
	if err := dropLegacyForeignKeys(); err != nil {
		return err
	}
	if err := pruneOrphanedClientInbounds(); err != nil {
		return err
	}
	if err := pruneOrphanedHosts(); err != nil {
		return err
	}
	if err := normalizeInboundSubSortIndex(); err != nil {
		return err
	}
	if err := normalizeClientExternalLinkEnable(); err != nil {
		return err
	}
	if err := normalizeClientExternalLinkTimestamps(); err != nil {
		return err
	}
	if err := repairOverflowedTrafficCounters(); err != nil {
		return err
	}
	if err := dedupeInboundSettingsClients(); err != nil {
		return err
	}
	if err := migrateLegacySocksInboundsToMixed(); err != nil {
		return err
	}
	if err := migrateShadowsocksRemovedCiphers(); err != nil {
		return err
	}
	if err := migrateShadowsocks2022ChachaInbounds(); err != nil {
		return err
	}
	if err := repairShadowsocks2022ServerKeys(); err != nil {
		return err
	}
	if err := migrateVmessRemovedSecurities(); err != nil {
		return err
	}
	if err := migrateTgIDIndex(); err != nil {
		return err
	}
	if err := migrateClientTrafficResetColumns(); err != nil {
		return err
	}
	if err := migrateClientResetWeekdayColumns(); err != nil {
		return err
	}
	if err := migrateSyncOrphanColumns(); err != nil {
		return err
	}
	if err := migrateClientEmailLowerIndex(); err != nil {
		return err
	}
	if IsPostgres() {
		if err := resyncPostgresSequences(db, models); err != nil {
			log.Printf("Error resyncing postgres sequences: %v", err)
			return err
		}
	}
	return nil
}

func postgresModelSettled(mdl any) bool {
	migrator := db.Migrator()
	if !migrator.HasTable(mdl) {
		return false
	}
	stmt := &gorm.Statement{DB: db}
	if err := stmt.Parse(mdl); err != nil || stmt.Schema == nil {
		return false
	}
	for _, dbName := range stmt.Schema.DBNames {
		if !migrator.HasColumn(mdl, dbName) {
			return false
		}
	}
	for _, idx := range stmt.Schema.ParseIndexes() {
		if !migrator.HasIndex(mdl, idx.Name) {
			return false
		}
	}
	return true
}

func dropLegacyForeignKeys() error {
	if !IsPostgres() {
		return nil
	}
	if err := db.Exec("ALTER TABLE client_traffics DROP CONSTRAINT IF EXISTS fk_inbounds_client_stats").Error; err != nil {
		log.Printf("Error dropping legacy foreign key fk_inbounds_client_stats: %v", err)
		return err
	}
	return nil
}

type sqliteIndexListRow struct {
	Name   string `gorm:"column:name"`
	Unique int    `gorm:"column:unique"`
	Origin string `gorm:"column:origin"`
}

func sqliteUniquePortIndexes() (autoIndexes, explicitIndexes []string, err error) {
	var list []sqliteIndexListRow
	if err = db.Raw(`PRAGMA index_list('inbounds')`).Scan(&list).Error; err != nil {
		return nil, nil, err
	}
	for _, idx := range list {
		if idx.Unique != 1 {
			continue
		}
		var cols []struct {
			Name string `gorm:"column:name"`
		}
		if err = db.Raw(`PRAGMA index_info("` + idx.Name + `")`).Scan(&cols).Error; err != nil {
			return nil, nil, err
		}
		if len(cols) != 1 || cols[0].Name != "port" {
			continue
		}
		if idx.Origin == "c" {
			explicitIndexes = append(explicitIndexes, idx.Name)
		} else {
			autoIndexes = append(autoIndexes, idx.Name)
		}
	}
	return autoIndexes, explicitIndexes, nil
}

// dropLegacyInboundPortUnique removes the pre-multi-node UNIQUE on inbounds.port,
// which AutoMigrate never drops and which blocks cross-node port reuse on old SQLite DBs.
func dropLegacyInboundPortUnique() error {
	if IsPostgres() {
		return nil
	}
	autoIndexes, explicitIndexes, err := sqliteUniquePortIndexes()
	if err != nil {
		return err
	}
	for _, name := range explicitIndexes {
		if err := db.Exec(`DROP INDEX IF EXISTS "` + name + `"`).Error; err != nil {
			return err
		}
	}
	if len(autoIndexes) == 0 {
		return nil
	}
	log.Printf("Rebuilding inbounds table to drop the legacy UNIQUE constraint on port")
	return rebuildInboundsWithoutInlineUniquePort()
}

func sqliteTableColumns(tx *gorm.DB, table string) ([]string, error) {
	var rows []struct {
		Name string `gorm:"column:name"`
	}
	if err := tx.Raw(`PRAGMA table_info("` + table + `")`).Scan(&rows).Error; err != nil {
		return nil, err
	}
	cols := make([]string, 0, len(rows))
	for _, r := range rows {
		cols = append(cols, r.Name)
	}
	return cols, nil
}

func rebuildInboundsWithoutInlineUniquePort() error {
	return db.Transaction(func(tx *gorm.DB) error {
		var list []sqliteIndexListRow
		if err := tx.Raw(`PRAGMA index_list('inbounds')`).Scan(&list).Error; err != nil {
			return err
		}
		for _, idx := range list {
			if idx.Origin != "c" {
				continue
			}
			if err := tx.Exec(`DROP INDEX IF EXISTS "` + idx.Name + `"`).Error; err != nil {
				return err
			}
		}
		if err := tx.Exec(`ALTER TABLE inbounds RENAME TO inbounds_legacy_rebuild`).Error; err != nil {
			return err
		}
		if err := tx.Migrator().CreateTable(&model.Inbound{}); err != nil {
			return err
		}
		newCols, err := sqliteTableColumns(tx, "inbounds")
		if err != nil {
			return err
		}
		oldCols, err := sqliteTableColumns(tx, "inbounds_legacy_rebuild")
		if err != nil {
			return err
		}
		oldSet := make(map[string]struct{}, len(oldCols))
		for _, c := range oldCols {
			oldSet[c] = struct{}{}
		}
		shared := make([]string, 0, len(newCols))
		for _, c := range newCols {
			if _, ok := oldSet[c]; ok {
				shared = append(shared, `"`+c+`"`)
			}
		}
		colList := strings.Join(shared, ", ")
		if err := tx.Exec(`INSERT INTO inbounds (` + colList + `) SELECT ` + colList + ` FROM inbounds_legacy_rebuild`).Error; err != nil {
			return err
		}
		return tx.Exec(`DROP TABLE inbounds_legacy_rebuild`).Error
	})
}

// AutoMigrate adds the columns; an older SQLite ALTER TABLE leaves them NULL,
// and a NULL traffic_reset fails every ClientRecord scan, not just the new query.
func migrateClientTrafficResetColumns() error {
	if db.Migrator().HasColumn(&model.ClientRecord{}, "traffic_reset") {
		if err := db.Exec("UPDATE clients SET traffic_reset = 'never' WHERE traffic_reset IS NULL").Error; err != nil {
			return err
		}
	}
	if db.Migrator().HasColumn(&model.ClientRecord{}, "traffic_reset_day") {
		if err := db.Exec("UPDATE clients SET traffic_reset_day = 1 WHERE traffic_reset_day IS NULL").Error; err != nil {
			return err
		}
	}
	return nil
}

// Existing clients keep weekly renewal disabled, including nullable columns
// left by an earlier ALTER TABLE; configured nonzero weekdays are preserved.
func migrateClientResetWeekdayColumns() error {
	for _, table := range []string{"clients", "client_traffics"} {
		if err := db.Table(table).Where("reset_weekday IS NULL").UpdateColumn("reset_weekday", 0).Error; err != nil {
			return err
		}
	}
	return nil
}

// AutoMigrate adds the column; this only backfills the NULLs an older SQLite
// ALTER TABLE leaves behind, so the reaper's predicate never compares to NULL.
func migrateSyncOrphanColumns() error {
	if !db.Migrator().HasColumn(&model.ClientRecord{}, "sync_orphaned_at") {
		return nil
	}
	if err := db.Exec("UPDATE clients SET sync_orphaned_at = 0 WHERE sync_orphaned_at IS NULL").Error; err != nil {
		return err
	}
	return db.Exec("UPDATE clients SET sync_orphaned_by = 0 WHERE sync_orphaned_by IS NULL").Error
}

// The client identity checks match emails case-insensitively; without an
// expression index (which no GORM struct tag can declare) they seq-scan.
func migrateClientEmailLowerIndex() error {
	if db.Migrator().HasIndex(&model.ClientRecord{}, "idx_clients_email_lower") {
		return nil
	}
	return db.Exec("CREATE INDEX IF NOT EXISTS idx_clients_email_lower ON clients (LOWER(email))").Error
}

func migrateHostVerifyPeerCertByNameColumn() error {
	if !db.Migrator().HasColumn(&model.Host{}, "verify_peer_cert_by_name") {
		return nil
	}
	if IsPostgres() {

		var dataType string
		if err := db.Raw(
			`SELECT data_type FROM information_schema.columns WHERE table_name = 'hosts' AND column_name = 'verify_peer_cert_by_name'`,
		).Scan(&dataType).Error; err != nil {
			return err
		}
		if dataType != "boolean" {
			return nil
		}
		if err := db.Exec(`ALTER TABLE hosts ALTER COLUMN verify_peer_cert_by_name DROP DEFAULT`).Error; err != nil {
			return err
		}
		return db.Exec(`ALTER TABLE hosts ALTER COLUMN verify_peer_cert_by_name TYPE text USING ''`).Error
	}

	return db.Exec(`UPDATE hosts SET verify_peer_cert_by_name = '' WHERE verify_peer_cert_by_name IS NULL OR typeof(verify_peer_cert_by_name) <> 'text'`).Error
}

// mihomo_x25519 was saved but ignored until it began dropping ML-KEM, so rows set
// back then are cleared once rather than silently changing their subscriptions.
func resetPreexistingMihomoX25519() error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Host{}).Where("mihomo_x25519 = ?", true).Update("mihomo_x25519", false).Error; err != nil {
			return err
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "HostMihomoX25519Reset"}).Error
	})
}

// AutoMigrate casts the boolean-era column to text before the migration above runs,
// so a saved false/true reads back as the cert name "0"/"false"/"1"/"true".
func blankLegacyBoolVerifyPeerCertByName() error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Host{}).
			Where("verify_peer_cert_by_name IN ?", []string{"0", "1", "false", "true"}).
			Update("verify_peer_cert_by_name", "").Error; err != nil {
			return err
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "HostVerifyPeerCertByNameBoolFix"}).Error
	})
}

func seedHostsFromExternalProxy() error {
	var history []string
	if err := db.Model(&model.HistoryOfSeeders{}).Pluck("seeder_name", &history).Error; err != nil {
		return err
	}
	if slices.Contains(history, "HostsFromExternalProxy") {
		return nil
	}

	var inbounds []model.Inbound
	if err := db.Find(&inbounds).Error; err != nil {
		return err
	}

	return db.Transaction(func(tx *gorm.DB) error {
		for _, inbound := range inbounds {
			if _, err := CreateHostsFromExternalProxy(tx, inbound.Id, inbound.StreamSettings); err != nil {
				return err
			}
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "HostsFromExternalProxy"}).Error
	})
}

func seedMtprotoCustomShareAddrToHosts() error {
	const seederName = "MtprotoCustomShareAddrToHosts"
	var count int64
	if err := db.Model(&model.HistoryOfSeeders{}).Where("seeder_name = ?", seederName).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	return db.Transaction(func(tx *gorm.DB) error {
		var inbounds []model.Inbound
		if err := tx.Where("protocol = ? AND TRIM(COALESCE(share_addr_strategy, '')) = ?", string(model.MTProto), "custom").Find(&inbounds).Error; err != nil {
			return err
		}
		for _, inbound := range inbounds {
			if err := CreateHostFromMtprotoCustomShareAddr(tx, inbound.Id, inbound.ShareAddr); err != nil {
				return err
			}
			if err := tx.Model(&model.Inbound{}).Where("id = ?", inbound.Id).Updates(map[string]any{
				"share_addr_strategy": "listen",
				"share_addr":          "",
			}).Error; err != nil {
				return err
			}
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: seederName}).Error
	})
}

func CreateHostFromMtprotoCustomShareAddr(tx *gorm.DB, inboundId int, rawAddress string) error {
	address := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(rawAddress), "]"), "[")
	if address == "" {
		return nil
	}
	var sameAddress []model.Host
	if err := tx.Where("inbound_id = ? AND address = ? AND is_disabled = ?", inboundId, address, false).
		Find(&sameAddress).Error; err != nil {
		return err
	}
	for _, host := range sameAddress {
		if !slices.Contains(host.ExcludeFromSubTypes, "raw") {
			return nil
		}
	}
	return tx.Create(&model.Host{
		GroupId: random.NumLower(16), InboundId: inboundId,
		Remark: address, Address: address, Security: "same",
	}).Error
}

func seedWireguardPeersToClients() error {
	var history []string
	if err := db.Model(&model.HistoryOfSeeders{}).Pluck("seeder_name", &history).Error; err != nil {
		return err
	}
	if slices.Contains(history, "WireguardPeersToClients") {
		return nil
	}

	var inbounds []model.Inbound
	if err := db.Where("protocol = ?", string(model.WireGuard)).Find(&inbounds).Error; err != nil {
		return err
	}

	return db.Transaction(func(tx *gorm.DB) error {
		usedEmails := map[string]struct{}{}
		var existingEmails []string
		if err := tx.Model(&model.ClientRecord{}).Pluck("email", &existingEmails).Error; err != nil {
			return err
		}
		for _, e := range existingEmails {
			usedEmails[e] = struct{}{}
		}

		for _, inbound := range inbounds {
			if strings.TrimSpace(inbound.Settings) == "" {
				continue
			}
			var settings map[string]any
			if err := json.Unmarshal([]byte(inbound.Settings), &settings); err != nil {
				log.Printf("WireguardPeersToClients: skip inbound %d (invalid settings json): %v", inbound.Id, err)
				continue
			}
			peers, ok := settings["peers"].([]any)
			if !ok || len(peers) == 0 {
				continue
			}

			var linkCount int64
			if err := tx.Model(&model.ClientInbound{}).Where("inbound_id = ?", inbound.Id).Count(&linkCount).Error; err != nil {
				return err
			}
			if linkCount > 0 {
				continue
			}

			clientObjs := make([]any, 0, len(peers))
			for i, raw := range peers {
				obj, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				email := wireguardPeerEmail(inbound.Remark, obj, i, usedEmails)
				usedEmails[email] = struct{}{}
				obj["email"] = email
				if sub, _ := obj["subId"].(string); strings.TrimSpace(sub) == "" {
					obj["subId"] = random.NumLower(16)
				}
				if _, ok := obj["enable"]; !ok {
					obj["enable"] = true
				}

				blob, err := json.Marshal(obj)
				if err != nil {
					continue
				}
				var c model.Client
				if err := json.Unmarshal(blob, &c); err != nil {
					log.Printf("WireguardPeersToClients: skip peer in inbound %d: %v", inbound.Id, err)
					continue
				}
				c.Email = email

				incoming := c.ToRecord()
				var row model.ClientRecord
				err = tx.Where("email = ?", email).First(&row).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					if err := tx.Create(incoming).Error; err != nil {
						return err
					}
					row = *incoming
				} else if err != nil {
					return err
				} else {
					model.MergeClientRecord(&row, incoming)
					if err := tx.Save(&row).Error; err != nil {
						return err
					}
				}

				link := model.ClientInbound{ClientId: row.Id, InboundId: inbound.Id}
				if err := tx.Where("client_id = ? AND inbound_id = ?", row.Id, inbound.Id).
					FirstOrCreate(&link).Error; err != nil {
					return err
				}

				clientObjs = append(clientObjs, obj)
			}

			delete(settings, "peers")
			settings["clients"] = clientObjs
			newSettings, err := json.Marshal(settings)
			if err != nil {
				return err
			}
			if err := tx.Model(&model.Inbound{}).Where("id = ?", inbound.Id).
				Update("settings", string(newSettings)).Error; err != nil {
				return err
			}
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "WireguardPeersToClients"}).Error
	})
}

func wireguardPeerEmail(remark string, peer map[string]any, index int, used map[string]struct{}) string {
	base := strings.TrimSpace(remark)
	if base == "" {
		base = "wg"
	}
	suffix := strconv.Itoa(index + 1)
	if c, ok := peer["comment"].(string); ok && strings.TrimSpace(c) != "" {
		suffix = strings.TrimSpace(c)
	}
	email := strings.ReplaceAll(base+"-"+suffix, " ", "-")
	candidate := email
	for n := 2; ; n++ {
		if _, taken := used[candidate]; !taken {
			return candidate
		}
		candidate = email + "-" + strconv.Itoa(n)
	}
}

// seedMtprotoSecretsToClients converts each legacy single-secret mtproto inbound
// into a one-client inbound so MTProto joins the shared multi-client model: the
// inbound-level secret becomes the first client's FakeTLS secret, and a
// ClientRecord + client_inbounds link are created so per-client traffic, limits,
// and share links work exactly like every other protocol. One-time, self-gated
// on the "MtprotoSecretsToClients" seeder row. Mirrors seedWireguardPeersToClients.
func seedMtprotoSecretsToClients() error {
	var history []string
	if err := db.Model(&model.HistoryOfSeeders{}).Pluck("seeder_name", &history).Error; err != nil {
		return err
	}
	if slices.Contains(history, "Mtprot…17617 tokens truncated…e
		}
		settings, ok := obj["settings"].(map[string]any)
		if !ok {
			continue
		}
		if !isLegacyPrivateOnlyFinalRules(settings["finalRules"]) {
			continue
		}
		settings["finalRules"] = []any{map[string]any{"action": "allow"}}
		changed = true
	}
	if !changed {
		return raw, false, nil
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return raw, false, err
	}
	return string(out), true, nil
}

func isLegacyPrivateOnlyFinalRules(v any) bool {
	rules, ok := v.([]any)
	if !ok || len(rules) != 1 {
		return false
	}
	rule, ok := rules[0].(map[string]any)
	if !ok {
		return false
	}
	if action, _ := rule["action"].(string); action != "allow" {
		return false
	}
	ips, ok := rule["ip"].([]any)
	if !ok || len(ips) != 1 {
		return false
	}
	if s, _ := ips[0].(string); s != "geoip:private" {
		return false
	}
	for k := range rule {
		if k != "action" && k != "ip" {
			return false
		}
	}
	return true
}

func isUnrestrictedFreedomFinalRules(v any, present bool) bool {
	if !present || v == nil {
		return true
	}
	rules, ok := v.([]any)
	return ok && len(rules) == 0
}

func hardenFreedomFinalRules() error {
	var setting model.Setting
	err := db.Model(model.Setting{}).Where("key = ?", "xrayTemplateConfig").First(&setting).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return db.Create(&model.HistoryOfSeeders{SeederName: "FreedomFinalRulesPrivateEgressBlock"}).Error
	}
	if err != nil {
		return err
	}

	updated, changed, rErr := rewriteFreedomFinalRulesPrivateEgress(setting.Value)
	if rErr != nil {
		log.Printf("FreedomFinalRulesPrivateEgressBlock: skip (invalid xrayTemplateConfig json): %v", rErr)
		return db.Create(&model.HistoryOfSeeders{SeederName: "FreedomFinalRulesPrivateEgressBlock"}).Error
	}

	return db.Transaction(func(tx *gorm.DB) error {
		if changed {
			if err := tx.Model(&model.Setting{}).Where("key = ?", "xrayTemplateConfig").
				Update("value", updated).Error; err != nil {
				return err
			}
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "FreedomFinalRulesPrivateEgressBlock"}).Error
	})
}

func rewriteFreedomFinalRulesPrivateEgress(raw string) (string, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return raw, false, nil
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return raw, false, err
	}
	outbounds, ok := cfg["outbounds"].([]any)
	if !ok {
		return raw, false, nil
	}
	changed := false
	for _, ob := range outbounds {
		obj, ok := ob.(map[string]any)
		if !ok {
			continue
		}
		if proto, _ := obj["protocol"].(string); !strings.EqualFold(proto, "freedom") {
			continue
		}
		settings, ok := obj["settings"].(map[string]any)
		if !ok {
			continue
		}
		finalRules, present := settings["finalRules"]
		if !isUnrestrictedFreedomFinalRules(finalRules, present) &&
			!isAllowOnlyFinalRules(finalRules) &&
			!isLegacyPrivateOnlyFinalRules(finalRules) {
			continue
		}
		settings["finalRules"] = []any{
			map[string]any{"action": "block", "ip": []any{"geoip:private"}},
			map[string]any{"action": "allow"},
		}
		changed = true
	}
	if !changed {
		return raw, false, nil
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return raw, false, err
	}
	return string(out), true, nil
}

func fixUppercaseFreedomFinalRules() error {
	var setting model.Setting
	err := db.Model(model.Setting{}).Where("key = ?", "xrayTemplateConfig").First(&setting).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return db.Create(&model.HistoryOfSeeders{SeederName: "UppercaseFreedomFinalRulesFix"}).Error
	}
	if err != nil {
		return err
	}

	updated, changed, rErr := rewriteUppercaseFreedomFinalRules(setting.Value)
	if rErr != nil {
		log.Printf("UppercaseFreedomFinalRulesFix: skip (invalid xrayTemplateConfig json): %v", rErr)
		return db.Create(&model.HistoryOfSeeders{SeederName: "UppercaseFreedomFinalRulesFix"}).Error
	}

	return db.Transaction(func(tx *gorm.DB) error {
		if changed {
			if err := tx.Model(&model.Setting{}).Where("key = ?", "xrayTemplateConfig").
				Update("value", updated).Error; err != nil {
				return err
			}
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "UppercaseFreedomFinalRulesFix"}).Error
	})
}

// Re-runs both finalRules rewrites, because the rows of the two seeders above it
// already exist on any panel that walked past a differently spelled outbound.
func rewriteUppercaseFreedomFinalRules(raw string) (string, bool, error) {
	if !hasNonLowercaseFreedomOutbound(raw) {
		return raw, false, nil
	}
	reversed, reversedChanged, err := rewriteFreedomFinalRules(raw)
	if err != nil {
		return raw, false, err
	}
	hardened, hardenedChanged, err := rewriteFreedomFinalRulesPrivateEgress(reversed)
	if err != nil {
		return raw, false, err
	}
	if !reversedChanged && !hardenedChanged {
		return raw, false, nil
	}
	return hardened, true, nil
}

func hasNonLowercaseFreedomOutbound(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return false
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return false
	}
	outbounds, ok := cfg["outbounds"].([]any)
	if !ok {
		return false
	}
	for _, ob := range outbounds {
		obj, ok := ob.(map[string]any)
		if !ok {
			continue
		}
		if proto, _ := obj["protocol"].(string); strings.EqualFold(proto, "freedom") && proto != "freedom" {
			return true
		}
	}
	return false
}

func stripRealityFinalmaskTcp() error {
	var inbounds []model.Inbound
	if err := db.Find(&inbounds).Error; err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for i := range inbounds {
			updated, changed := stripRealityFinalmaskTcpFromStream(inbounds[i].StreamSettings)
			if !changed {
				continue
			}
			if err := tx.Model(&model.Inbound{}).Where("id = ?", inbounds[i].Id).
				Update("stream_settings", updated).Error; err != nil {
				return err
			}
			log.Printf("InboundRealityFinalmaskTcpStrip: removed finalmask.tcp from REALITY inbound %d (%s)", inbounds[i].Id, inbounds[i].Tag)
		}
		return tx.Create(&model.HistoryOfSeeders{SeederName: "InboundRealityFinalmaskTcpStrip"}).Error
	})
}

func stripRealityFinalmaskTcpFromStream(raw string) (string, bool) {
	if strings.TrimSpace(raw) == "" {
		return raw, false
	}
	var stream map[string]any
	if err := json.Unmarshal([]byte(raw), &stream); err != nil {
		return raw, false
	}
	if sec, _ := stream["security"].(string); sec != "reality" {
		return raw, false
	}
	finalmask, ok := stream["finalmask"].(map[string]any)
	if !ok {
		return raw, false
	}
	if tcp, _ := finalmask["tcp"].([]any); len(tcp) == 0 {
		return raw, false
	}
	delete(finalmask, "tcp")
	if len(finalmask) == 0 {
		delete(stream, "finalmask")
	}
	out, err := json.Marshal(stream)
	if err != nil {
		return raw, false
	}
	return string(out), true
}

func isAllowOnlyFinalRules(v any) bool {
	rules, ok := v.([]any)
	if !ok || len(rules) != 1 {
		return false
	}
	rule, ok := rules[0].(map[string]any)
	if !ok {
		return false
	}
	if action, _ := rule["action"].(string); action != "allow" {
		return false
	}
	for k := range rule {
		if k != "action" {
			return false
		}
	}
	return true
}

func seedClientsFromInboundJSON() error {
	var inbounds []model.Inbound
	if err := db.Find(&inbounds).Error; err != nil {
		return err
	}

	return db.Transaction(func(tx *gorm.DB) error {
		byEmail := map[string]*model.ClientRecord{}

		var existing []model.ClientRecord
		if err := tx.Find(&existing).Error; err != nil {
			return err
		}
		for i := range existing {
			byEmail[existing[i].Email] = &existing[i]
		}

		for _, inbound := range inbounds {
			if strings.TrimSpace(inbound.Settings) == "" {
				continue
			}
			var settings map[string]any
			if err := json.Unmarshal([]byte(inbound.Settings), &settings); err != nil {
				log.Printf("ClientsTable seed: skip inbound %d (invalid settings json): %v", inbound.Id, err)
				continue
			}
			rawList, ok := settings["clients"].([]any)
			if !ok {
				continue
			}

			for _, raw := range rawList {
				obj, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				model.NormalizeLegacyClientFields(obj)
				// Releases before 3.1.0 served a client whose JSON carries no
				// switch; only an explicit false means disabled.
				if obj["enable"] == nil {
					obj["enable"] = true
				}
				blob, err := json.Marshal(obj)
				if err != nil {
					continue
				}
				var c model.Client
				if err := json.Unmarshal(blob, &c); err != nil {
					log.Printf("ClientsTable seed: skip client in inbound %d (unmarshal failed): %v; payload=%s",
						inbound.Id, err, string(blob))
					continue
				}
				email := strings.TrimSpace(c.Email)
				if email == "" {
					continue
				}
				incoming := c.ToRecord()

				row, dup := byEmail[email]
				if !dup {
					if err := tx.Create(incoming).Error; err != nil {
						return err
					}
					// gorm default:true drops enable=false on Create — restate (#6478).
					if !c.Enable {
						if err := tx.Model(&model.ClientRecord{}).Where("id = ?", incoming.Id).
							UpdateColumn("enable", false).Error; err != nil {
							return err
						}
						incoming.Enable = false
					}
					byEmail[email] = incoming
					row = incoming
				} else {
					conflicts := model.MergeClientRecord(row, incoming)
					for _, x := range conflicts {
						log.Printf("client merge: email=%s conflict on %s old=%v new=%v kept=%v",
							email, x.Field, x.Old, x.New, x.Kept)
					}
					if err := tx.Save(row).Error; err != nil {
						return err
					}
				}

				link := model.ClientInbound{
					ClientId:     row.Id,
					InboundId:    inbound.Id,
					FlowOverride: c.Flow,
				}
				if err := tx.Where("client_id = ? AND inbound_id = ?", row.Id, inbound.Id).
					FirstOrCreate(&link).Error; err != nil {
					return err
				}
			}
		}

		return tx.Create(&model.HistoryOfSeeders{SeederName: "ClientsTable"}).Error
	})
}

func seedApiTokens() error {
	empty, err := isTableEmpty("api_tokens")
	if err != nil {
		return err
	}
	if empty {
		var legacy model.Setting
		err := db.Model(model.Setting{}).Where("key = ?", "apiToken").First(&legacy).Error
		if err == nil && legacy.Value != "" {
			row := &model.ApiToken{
				Name:    "default",
				Token:   legacy.Value,
				Enabled: true,
			}
			if err := db.Create(row).Error; err != nil {
				log.Printf("Error migrating legacy apiToken: %v", err)
				return err
			}
		}
	}
	return db.Create(&model.HistoryOfSeeders{SeederName: "ApiTokensTable"}).Error
}

func hashExistingApiTokens() error {
	var rows []*model.ApiToken
	if err := db.Find(&rows).Error; err != nil {
		return err
	}
	for _, r := range rows {
		if crypto.IsSHA256Hex(r.Token) {
			continue
		}
		hashed := crypto.HashTokenSHA256(r.Token)
		if err := db.Model(model.ApiToken{}).Where("id = ?", r.Id).Update("token", hashed).Error; err != nil {
			log.Printf("Error hashing api token %d: %v", r.Id, err)
			return err
		}
	}
	return db.Create(&model.HistoryOfSeeders{SeederName: "ApiTokensHash"}).Error
}

func isTableEmpty(tableName string) (bool, error) {
	var count int64
	err := db.Table(tableName).Count(&count).Error
	return count == 0, err
}

func InitDB(dbPath string) error {
	var gormLogger logger.Interface
	if config.IsDebug() {
		gormLogger = logger.New(
			log.New(os.Stdout, "\r\n", log.LstdFlags),
			logger.Config{
				SlowThreshold:             time.Second,
				LogLevel:                  logger.Info,
				IgnoreRecordNotFoundError: true,
				Colorful:                  true,
			},
		)
	} else {
		gormLogger = logger.Discard
	}
	c := &gorm.Config{Logger: gormLogger, DisableForeignKeyConstraintWhenMigrating: true}

	// Reopening replaces the process pool; the replaced one would keep its file open.
	if err := CloseDB(); err != nil {
		log.Printf("close the replaced database pool: %v", err)
	}

	var err error
	switch config.GetDBKind() {
	case "postgres":
		dsn := config.GetDBDSN()
		if dsn == "" {
			return errors.New("XUI_DB_TYPE=postgres but XUI_DB_DSN is empty")
		}
		db, err = openPostgresWithRetry(dsn, c)
		if err != nil {
			return err
		}
	default:
		dir := path.Dir(dbPath)
		if err = os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if err = cleanupSQLiteBackupDirs(filepath.Dir(dbPath)); err != nil {
			log.Printf("clean SQLite backup directories: %v", err)
		}

		sync := sqliteSynchronous()
		journal := sqliteJournalMode()
		dsn := dbPath + "?_journal_mode=" + journal + "&_busy_timeout=10000&_synchronous=" + sync + "&_txlock=immediate"
		db, err = gorm.Open(sqlite.Open(dsn), c)
		if err != nil {
			return err
		}
		if err := restrictSQLiteFilePerms(dbPath); err != nil {
			log.Printf("restrict SQLite file permissions: %v", err)
		}
		sqlDB, err := db.DB()
		if err != nil {
			return err
		}

		pragmas := []string{
			"PRAGMA journal_mode=" + journal,
			"PRAGMA busy_timeout=10000",
			"PRAGMA synchronous=" + sync,
			fmt.Sprintf("PRAGMA cache_size=-%d", envInt("XUI_DB_CACHE_MB", 32)*1024),
			fmt.Sprintf("PRAGMA mmap_size=%d", int64(envInt("XUI_DB_MMAP_MB", 256))*1024*1024),
			"PRAGMA temp_store=MEMORY",
		}
		for _, p := range pragmas {
			if _, err := sqlDB.ExecContext(context.Background(), p); err != nil {
				return err
			}
		}
	}

	sqlDB, err := db.DB()
	if err != nil {
		return err
	}
	var maxOpen, maxIdle int
	switch config.GetDBKind() {
	case "postgres":
		maxOpen = envInt("XUI_DB_MAX_OPEN_CONNS", 25)
		maxIdle = envInt("XUI_DB_MAX_IDLE_CONNS", 25)
	default:
		maxOpen = envInt("XUI_DB_MAX_OPEN_CONNS", 8)
		maxIdle = envInt("XUI_DB_MAX_IDLE_CONNS", 4)
	}
	sqlDB.SetMaxOpenConns(maxOpen)
	sqlDB.SetMaxIdleConns(maxIdle)
	sqlDB.SetConnMaxLifetime(time.Hour)
	sqlDB.SetConnMaxIdleTime(30 * time.Minute)

	if err := initModels(); err != nil {
		return err
	}

	isUsersEmpty, err := isTableEmpty("users")
	if err != nil {
		return err
	}
	if isUsersEmpty {
		if err := seedRandomSubscriptionPaths(); err != nil {
			return err
		}
	}
	return runSeeders(isUsersEmpty)
}

func normalizeApiTokenCreatedAtSeconds() error {
	return db.Model(&model.ApiToken{}).
		Where("created_at >= ?", model.ApiTokenUnixMillisecondsThreshold).
		UpdateColumn("created_at", gorm.Expr("created_at / ?", 1000)).Error
}

func migrateApiTokenScopeAndExpiry() error {
	m := db.Migrator()
	if !m.HasColumn(&model.ApiToken{}, "Scope") {
		if err := m.AddColumn(&model.ApiToken{}, "Scope"); err != nil {
			return err
		}
	}
	if !m.HasColumn(&model.ApiToken{}, "ExpiresAt") {
		if err := m.AddColumn(&model.ApiToken{}, "ExpiresAt"); err != nil {
			return err
		}
	}
	return db.Model(&model.ApiToken{}).Where("scope IS NULL OR TRIM(scope) = ''").
		Updates(map[string]any{"scope": model.ApiScopeAdmin, "expires_at": 0}).Error
}

// openPostgresWithRetry retries the initial PostgreSQL connection with
// backoff so a database that starts slower than the panel (or drops out
// briefly) does not immediately kill the process and trip systemd's
// restart loop. Every failed attempt logs the real driver error, which
// used to be buried behind a generic startup failure.
func openPostgresWithRetry(dsn string, c *gorm.Config) (*gorm.DB, error) {
	delays := []time.Duration{0, 2 * time.Second, 5 * time.Second, 10 * time.Second, 20 * time.Second, 30 * time.Second}
	var lastErr error
	for i, delay := range delays {
		if delay > 0 {
			time.Sleep(delay)
		}
		conn, err := gorm.Open(postgres.Open(dsn), c)
		if err == nil {
			if i > 0 {
				log.Printf("postgres connection established on attempt %d/%d", i+1, len(delays))
			}
			return conn, nil
		}
		lastErr = err
		log.Printf("postgres connection attempt %d/%d failed: %v", i+1, len(delays), err)
	}
	return nil, fmt.Errorf("postgres unreachable after %d attempts: %w", len(delays), lastErr)
}

// The store holds client secrets, so it and its WAL/SHM side files stay
// owner-only. Best effort: a store the panel cannot chmod still opens.
func restrictSQLiteFilePerms(dbPath string) error {
	for _, name := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if err := os.Chmod(name, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func sqliteJournalMode() string {
	switch strings.ToUpper(strings.TrimSpace(os.Getenv("XUI_DB_JOURNAL_MODE"))) {
	case "DELETE":
		return "DELETE"
	default:
		return "WAL"
	}
}

func backupSQLiteStepPages() int {
	if sqliteJournalMode() == "DELETE" {
		return 128
	}
	return -1
}

func cleanupSQLiteBackupDirs(dir string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), sqliteBackupDirPrefix) {
			if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func sqliteSynchronous() string {
	switch strings.ToUpper(strings.TrimSpace(os.Getenv("XUI_DB_SYNCHRONOUS"))) {
	case "OFF":
		return "OFF"
	case "NORMAL":
		return "NORMAL"
	case "EXTRA":
		return "EXTRA"
	default:
		return "FULL"
	}
}

func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func CloseDB() error {
	if db != nil {
		sqlDB, err := db.DB()
		if err != nil {
			return err
		}
		return sqlDB.Close()
	}
	return nil
}

func GetDB() *gorm.DB {
	return db
}

func IsNotFound(err error) bool {
	return errors.Is(err, gorm.ErrRecordNotFound)
}

func IsSQLiteDB(file io.ReaderAt) (bool, error) {
	signature := []byte("SQLite format 3\x00")
	buf := make([]byte, len(signature))
	_, err := file.ReadAt(buf, 0)
	if err != nil {
		return false, err
	}
	return bytes.Equal(buf, signature), nil
}

func BackupSQLite(dstPath string) (err error) {
	if IsPostgres() {
		return errors.New("sqlite backup is unavailable for PostgreSQL")
	}
	if db == nil {
		return errors.New("database is not initialized")
	}
	if _, err := os.Lstat(dstPath); err == nil {
		return fmt.Errorf("sqlite backup destination already exists: %s", dstPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(dstPath)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), backupSQLiteTimeout)
	defer cancel()

	sourceDB, err := db.DB()
	if err != nil {
		return err
	}
	sourceConn, err := sourceDB.Conn(ctx)
	if err != nil {
		return err
	}
	defer sourceConn.Close()

	destinationDB, err := sql.Open("sqlite3", dstPath)
	if err != nil {
		return err
	}
	defer destinationDB.Close()
	destinationConn, err := destinationDB.Conn(ctx)
	if err != nil {
		return err
	}
	defer destinationConn.Close()

	return sourceConn.Raw(func(sourceDriver any) error {
		source, ok := sourceDriver.(*sqlite3.SQLiteConn)
		if !ok {
			return fmt.Errorf("unexpected SQLite source connection type %T", sourceDriver)
		}
		return destinationConn.Raw(func(destinationDriver any) error {
			destination, ok := destinationDriver.(*sqlite3.SQLiteConn)
			if !ok {
				return fmt.Errorf("unexpected SQLite destination connection type %T", destinationDriver)
			}
			backup, err := destination.Backup("main", source, "main")
			if err != nil {
				return err
			}
			finished := false
			defer func() {
				if !finished {
					_ = backup.Finish()
				}
			}()
			for {
				done, err := backup.Step(backupSQLiteStepPages())
				if err != nil {
					return err
				}
				if done {
					finished = true
					return backup.Finish()
				}
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-time.After(10 * time.Millisecond):
				}
			}
		})
	})
}

func ValidateSQLiteDB(dbPath string) error {
	if _, err := os.Stat(dbPath); err != nil {
		return err
	}
	gdb, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		return err
	}
	sqlDB, err := gdb.DB()
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	var res string
	if err := gdb.Raw("PRAGMA integrity_check;").Scan(&res).Error; err != nil {
		return err
	}
	if res != "ok" {
		return errors.New("sqlite integrity check failed: " + res)
	}
	return nil
}
