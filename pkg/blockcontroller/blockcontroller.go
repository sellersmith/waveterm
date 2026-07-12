// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/hyprlane/policy"
	"github.com/wavetermdev/waveterm/hyprlane/sessionpolicy"
	"github.com/wavetermdev/waveterm/pkg/blocklogger"
	"github.com/wavetermdev/waveterm/pkg/filestore"
	"github.com/wavetermdev/waveterm/pkg/jobcontroller"
	"github.com/wavetermdev/waveterm/pkg/remote"
	"github.com/wavetermdev/waveterm/pkg/remote/conncontroller"
	"github.com/wavetermdev/waveterm/pkg/util/ds"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wslconn"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	BlockController_Shell   = "shell"
	BlockController_Cmd     = "cmd"
	BlockController_Tsunami = "tsunami"
)

const (
	Status_Running = "running"
	Status_Done    = "done"
	Status_Init    = "init"
)

const (
	DefaultTermMaxFileSize = 2 * 1024 * 1024
	DefaultHtmlMaxFileSize = 256 * 1024
	MaxInitScriptSize      = 50 * 1024
)

const DefaultTimeout = 2 * time.Second
const DefaultGracefulKillWait = 400 * time.Millisecond
const processGroupReapSettleWait = 25 * time.Millisecond

type BlockInputUnion struct {
	InputData []byte            `json:"inputdata,omitempty"`
	SigName   string            `json:"signame,omitempty"`
	TermSize  *waveobj.TermSize `json:"termsize,omitempty"`
}

type BlockControllerRuntimeStatus struct {
	BlockId           string `json:"blockid"`
	Version           int64  `json:"version"`
	ShellProcStatus   string `json:"shellprocstatus,omitempty"`
	ShellProcConnName string `json:"shellprocconnname,omitempty"`
	ShellProcExitCode int    `json:"shellprocexitcode"`
	TsunamiPort       int    `json:"tsunamiport,omitempty"`
}

// Controller interface that all block controllers must implement
type Controller interface {
	Start(ctx context.Context, blockMeta waveobj.MetaMapType, rtOpts *waveobj.RuntimeOpts, force bool) error
	Stop(graceful bool, newStatus string, destroy bool)
	GetRuntimeStatus() *BlockControllerRuntimeStatus // does not return nil
	GetConnName() string
	SendInput(input *BlockInputUnion) error
}

// Registry for all controllers
var (
	controllerRegistry           = make(map[string]Controller)
	controllerTabIDs             = make(map[string]string)
	registryLock                 sync.RWMutex
	blockResyncMutexMap          = ds.MakeSyncMap[*sync.Mutex]()
	tabControllerMutexMap        = ds.MakeSyncMap[*sync.RWMutex]()
	localPTYCoordinator          = sessionpolicy.DefaultCoordinator
	embeddedSessionPolicyEnabled = policy.IsEmbedded
)

func getBlockResyncMutex(blockId string) *sync.Mutex {
	return blockResyncMutexMap.GetOrCreate(blockId, func() *sync.Mutex {
		return &sync.Mutex{}
	})
}

func getTabControllerMutex(tabID string) *sync.RWMutex {
	return tabControllerMutexMap.GetOrCreate(tabID, func() *sync.RWMutex {
		return &sync.RWMutex{}
	})
}

// Registry operations
func getController(blockId string) Controller {
	registryLock.RLock()
	defer registryLock.RUnlock()
	return controllerRegistry[blockId]
}

func registerController(tabID string, blockId string, controller Controller) {
	var existingController Controller

	registryLock.Lock()
	existing, exists := controllerRegistry[blockId]
	if exists {
		existingController = existing
	}
	controllerRegistry[blockId] = controller
	controllerTabIDs[blockId] = tabID
	registryLock.Unlock()

	if existingController != nil {
		existingController.Stop(false, Status_Done, true)
		wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
	}
}

func deleteController(blockId string) {
	registryLock.Lock()
	defer registryLock.Unlock()
	delete(controllerRegistry, blockId)
	delete(controllerTabIDs, blockId)
}

func getAllControllers() map[string]Controller {
	registryLock.RLock()
	defer registryLock.RUnlock()
	// Return a copy to avoid lock issues
	result := make(map[string]Controller)
	for k, v := range controllerRegistry {
		result[k] = v
	}
	return result
}

func InitBlockController() {
	if embeddedSessionPolicyEnabled() {
		if err := localPTYCoordinator.SetReapTab(destroyBlockControllersForTab); err != nil {
			log.Printf("[sessionpolicy] configuring tab reaper: %v\n", err)
		}
	}
	rpcClient := wshclient.GetBareRpcClient()
	rpcClient.EventListener.On(wps.Event_BlockClose, handleBlockCloseEvent)
	wshclient.EventSubCommand(rpcClient, wps.SubscriptionRequest{
		Event:     wps.Event_BlockClose,
		AllScopes: true,
	}, nil)
}

func handleBlockCloseEvent(event *wps.WaveEvent) {
	blockId, ok := event.Data.(string)
	if !ok {
		log.Printf("[blockclose] invalid event data type")
		return
	}
	go DestroyBlockController(blockId)
}

// Public API Functions

func ResyncController(ctx context.Context, tabId string, blockId string, rtOpts *waveobj.RuntimeOpts, force bool) error {
	if tabId == "" || blockId == "" {
		return fmt.Errorf("invalid tabId or blockId passed to ResyncController")
	}
	if embeddedSessionPolicyEnabled() {
		if err := validateControllerTabOwnership(tabId, blockId, func(id string) (string, error) {
			return wstore.DBFindTabForBlockId(ctx, id)
		}); err != nil {
			return err
		}
	}
	tabMutex := getTabControllerMutex(tabId)
	tabMutex.RLock()
	defer tabMutex.RUnlock()
	if embeddedSessionPolicyEnabled() {
		if err := localPTYCoordinator.AuthorizeControllerOperation(tabId); err != nil {
			return fmt.Errorf("cannot resync controller for detached tab: %w", err)
		}
	}

	mu := getBlockResyncMutex(blockId)
	mu.Lock()
	defer mu.Unlock()

	blockData, err := wstore.DBMustGet[*waveobj.Block](ctx, blockId)
	if err != nil {
		return fmt.Errorf("error getting block: %w", err)
	}

	controllerName := blockData.Meta.GetString(waveobj.MetaKey_Controller, "")
	connName := blockData.Meta.GetString(waveobj.MetaKey_Connection, "")
	if err := validateControllerPolicy(
		embeddedSessionPolicyEnabled(),
		controllerName,
		connName,
		policy.AllowsController,
	); err != nil {
		return err
	}

	// Get existing controller
	existing := getController(blockId)

	// Check for connection change FIRST - always destroy on conn change
	if existing != nil {
		existingConnName := existing.GetConnName()
		if existingConnName != connName {
			log.Printf("stopping blockcontroller %s due to conn change (from %q to %q)\n", blockId, existingConnName, connName)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// If no controller needed, stop existing if present
	if controllerName == "" {
		if existing != nil {
			DestroyBlockController(blockId)
		}
		return nil
	}

	// Determine if we should use DurableShellController vs ShellController
	shouldUseDurableShellController := controllerName == BlockController_Shell && jobcontroller.IsBlockIdTermDurable(blockId)

	// Check if we need to morph controller type
	if existing != nil {
		needsReplace := false

		switch existing.(type) {
		case *ShellController:
			if controllerName != BlockController_Shell && controllerName != BlockController_Cmd {
				needsReplace = true
			} else if shouldUseDurableShellController {
				needsReplace = true
			}
		case *DurableShellController:
			if !shouldUseDurableShellController {
				needsReplace = true
			}
		case *TsunamiController:
			if controllerName != BlockController_Tsunami {
				needsReplace = true
			}
		}

		if needsReplace {
			log.Printf("stopping blockcontroller %s due to controller type change\n", blockId)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// Force restart if requested
	if force && existing != nil {
		DestroyBlockController(blockId)
		time.Sleep(100 * time.Millisecond)
		existing = nil
	}

	// Destroy done controllers before restarting
	if existing != nil {
		status := existing.GetRuntimeStatus()
		if status.ShellProcStatus == Status_Done {
			log.Printf("destroying blockcontroller %s with done status before restart\n", blockId)
			DestroyBlockController(blockId)
			time.Sleep(100 * time.Millisecond)
			existing = nil
		}
	}

	// Create or restart controller
	var controller Controller
	if existing != nil {
		controller = existing
	} else {
		// Create new controller based on type
		switch controllerName {
		case BlockController_Shell, BlockController_Cmd:
			if shouldUseDurableShellController {
				controller = MakeDurableShellController(tabId, blockId, controllerName, connName)
			} else {
				controller = MakeShellController(tabId, blockId, controllerName, connName)
			}
			registerController(tabId, blockId, controller)

		case BlockController_Tsunami:
			controller = MakeTsunamiController(tabId, blockId, connName)
			registerController(tabId, blockId, controller)

		default:
			return fmt.Errorf("unknown controller type %q", controllerName)
		}
	}

	// Check if we need to start/restart
	status := controller.GetRuntimeStatus()
	if status.ShellProcStatus == Status_Init {
		if err := reserveLocalPTY(tabId, blockId, controllerName, connName); err != nil {
			return fmt.Errorf("cannot start local terminal: %w", err)
		}
		// For shell/cmd, check connection status first (for non-local connections)
		if controllerName == BlockController_Shell || controllerName == BlockController_Cmd {
			if !conncontroller.IsLocalConnName(connName) {
				err = CheckConnStatus(blockId)
				if err != nil {
					return fmt.Errorf("cannot start shellproc: %w", err)
				}
			}
		}

		// Start controller
		err = controller.Start(ctx, blockData.Meta, rtOpts, force)
		if err != nil {
			if usesEmbeddedLocalPTYPolicy(controllerName, connName) {
				localPTYCoordinator.Release(blockId)
			}
			return fmt.Errorf("error starting controller: %w", err)
		}
	}

	return nil
}

func validateControllerPolicy(
	embedded bool,
	controllerName string,
	connName string,
	allowsController func(string) bool,
) error {
	if !embedded || controllerName == "" {
		return nil
	}
	if !allowsController(controllerName) {
		return fmt.Errorf("controller %q denied by host policy", controllerName)
	}
	if !conncontroller.IsLocalConnName(connName) {
		return fmt.Errorf("connection %q denied by host policy", connName)
	}
	return nil
}

func validateControllerTabOwnership(
	tabID string,
	blockID string,
	findTab func(string) (string, error),
) error {
	serverTabID, err := findTab(blockID)
	if err != nil {
		return fmt.Errorf("finding server-owned tab for block: %w", err)
	}
	if serverTabID != tabID {
		return fmt.Errorf("block does not belong to requested tab")
	}
	return nil
}

func GetBlockControllerRuntimeStatus(blockId string) *BlockControllerRuntimeStatus {
	controller := getController(blockId)
	if controller == nil {
		return nil
	}
	return controller.GetRuntimeStatus()
}

func DestroyBlockController(blockId string) {
	if !embeddedSessionPolicyEnabled() {
		controller := getController(blockId)
		if controller == nil {
			return
		}
		controller.Stop(true, Status_Done, true)
		wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
		deleteController(blockId)
		return
	}

	registryLock.Lock()
	controller := controllerRegistry[blockId]
	if controller == nil {
		registryLock.Unlock()
		return
	}
	delete(controllerRegistry, blockId)
	delete(controllerTabIDs, blockId)
	registryLock.Unlock()

	stopEmbeddedController(controller)
	wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockId))
	localPTYCoordinator.Release(blockId)
}

func stopEmbeddedController(controller Controller) {
	controller.Stop(true, Status_Done, true)
	shellController, isShellController := controller.(*ShellController)
	if !isShellController || shellController.RunLock == nil {
		return
	}
	// ShellController.Start schedules process setup asynchronously. If teardown
	// wins just after run() observed Init, the first Stop can complete before the
	// PTY exists. Wait for setup to quiesce and stop once more so a late process
	// cannot escape the tab reap.
	for shellController.RunLock.Load() {
		time.Sleep(5 * time.Millisecond)
	}
	controller.Stop(true, Status_Done, true)
}

func destroyBlockControllersForTab(tabID string) {
	tabMutex := getTabControllerMutex(tabID)
	tabMutex.Lock()
	defer tabMutex.Unlock()
	reapStartedAt := time.Now()
	registryLock.RLock()
	blockIDs := make([]string, 0)
	for blockID, controllerTabID := range controllerTabIDs {
		if controllerTabID == tabID {
			blockIDs = append(blockIDs, blockID)
		}
	}
	registryLock.RUnlock()
	if len(blockIDs) == 0 {
		return
	}
	sort.Strings(blockIDs)
	var waitGroup sync.WaitGroup
	for _, blockID := range blockIDs {
		waitGroup.Add(1)
		go func(id string) {
			defer waitGroup.Done()
			DestroyBlockController(id)
		}(blockID)
	}
	waitGroup.Wait()
	// ShellProc escalates against its captured process group asynchronously.
	// A shell leader can exit before a descendant that ignored HUP, so keep the
	// admission barrier closed until that escalation has had time to run.
	reapDeadline := reapStartedAt.Add(DefaultGracefulKillWait + processGroupReapSettleWait)
	if remaining := time.Until(reapDeadline); remaining > 0 {
		time.Sleep(remaining)
	}
}

func reconcileFinishedLocalPTYs() {
	registryLock.RLock()
	controllers := make(map[string]Controller, len(controllerRegistry))
	for blockID, controller := range controllerRegistry {
		controllers[blockID] = controller
	}
	registryLock.RUnlock()
	for blockID, controller := range controllers {
		if !localPTYCoordinator.HasPTY(blockID) {
			continue
		}
		status := controller.GetRuntimeStatus()
		if status == nil || status.ShellProcStatus == Status_Done {
			localPTYCoordinator.Release(blockID)
		}
	}
}

func reserveLocalPTY(tabID string, blockID string, controllerName string, connName string) error {
	if !usesEmbeddedLocalPTYPolicy(controllerName, connName) {
		return nil
	}
	reconcileFinishedLocalPTYs()
	return localPTYCoordinator.Admit(tabID, blockID)
}

func usesEmbeddedLocalPTYPolicy(controllerName string, connName string) bool {
	return embeddedSessionPolicyEnabled() &&
		(controllerName == BlockController_Shell || controllerName == BlockController_Cmd) &&
		conncontroller.IsLocalConnName(connName)
}

func sendConnMonitorInputNotification(controller Controller) {
	connName := controller.GetConnName()
	if connName == "" || conncontroller.IsLocalConnName(connName) || conncontroller.IsWslConnName(connName) {
		return
	}

	connOpts, parseErr := remote.ParseOpts(connName)
	if parseErr != nil {
		return
	}
	sshConn := conncontroller.MaybeGetConn(connOpts)
	if sshConn != nil {
		monitor := sshConn.GetMonitor()
		if monitor != nil {
			monitor.NotifyInput()
		}
	}
}

func SendInput(blockId string, inputUnion *BlockInputUnion) error {
	controller := getController(blockId)
	if controller == nil {
		return fmt.Errorf("no controller found for block %s", blockId)
	}
	sendConnMonitorInputNotification(controller)
	return controller.SendInput(inputUnion)
}

// only call this on shutdown
func StopAllBlockControllersForShutdown() {
	controllers := getAllControllers()
	for blockId, controller := range controllers {
		status := controller.GetRuntimeStatus()
		if status != nil && status.ShellProcStatus == Status_Running {
			go func(id string, c Controller) {
				c.Stop(true, Status_Done, false)
				wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, id))
			}(blockId, controller)
		}
	}
}

func stopBlockControllersForShutdownAndWait(
	ctx context.Context,
	controllers map[string]Controller,
	cleanup func(string),
	processGroupGracePeriod time.Duration,
) error {
	var waitGroup sync.WaitGroup
	for blockID, controller := range controllers {
		status := controller.GetRuntimeStatus()
		if status == nil || status.ShellProcStatus != Status_Running {
			continue
		}
		waitGroup.Add(1)
		go func(id string, current Controller) {
			defer waitGroup.Done()
			current.Stop(true, Status_Done, false)
			cleanup(id)
		}(blockID, controller)
	}

	controllersStopped := make(chan struct{})
	go func() {
		waitGroup.Wait()
		close(controllersStopped)
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-controllersStopped:
	}

	if processGroupGracePeriod <= 0 {
		return nil
	}
	timer := time.NewTimer(processGroupGracePeriod)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// StopAllBlockControllersForShutdownAndWait stops every running controller and
// keeps the server alive long enough for local PTY process-group escalation.
// The caller owns the shutdown deadline through ctx.
func StopAllBlockControllersForShutdownAndWait(ctx context.Context) error {
	return stopBlockControllersForShutdownAndWait(
		ctx,
		getAllControllers(),
		func(blockID string) {
			wstore.DeleteRTInfo(waveobj.MakeORef(waveobj.OType_Block, blockID))
		},
		DefaultGracefulKillWait,
	)
}

func getBoolFromMeta(meta map[string]any, key string, def bool) bool {
	ival, found := meta[key]
	if !found || ival == nil {
		return def
	}
	if val, ok := ival.(bool); ok {
		return val
	}
	return def
}

func getTermSize(bdata *waveobj.Block) waveobj.TermSize {
	if bdata.RuntimeOpts != nil {
		return bdata.RuntimeOpts.TermSize
	} else {
		return waveobj.TermSize{
			Rows: 25,
			Cols: 80,
		}
	}
}

func HandleAppendBlockFile(blockId string, blockFile string, data []byte) error {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	startOffset, endOffset, generation, err := filestore.WFS.AppendDataWithRangeAndGeneration(ctx, blockId, blockFile, data)
	if err != nil {
		return fmt.Errorf("error appending to blockfile: %w", err)
	}
	fileEvent := &wps.WSFileEventData{
		ZoneId:   blockId,
		FileName: blockFile,
		FileOp:   wps.FileOp_Append,
		Data64:   base64.StdEncoding.EncodeToString(data),
	}
	if policy.IsEmbedded() {
		fileEvent.StartOffset = &startOffset
		fileEvent.EndOffset = &endOffset
		fileEvent.Generation = &generation
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event: wps.Event_BlockFile,
		Scopes: []string{
			waveobj.MakeORef(waveobj.OType_Block, blockId).String(),
		},
		Data: fileEvent,
	})
	return nil
}

func HandleTruncateBlockFile(blockId string) error {
	ctx, cancelFn := context.WithTimeout(context.Background(), DefaultTimeout)
	defer cancelFn()
	err := filestore.WFS.WriteFile(ctx, blockId, wavebase.BlockFile_Term, nil)
	if err == fs.ErrNotExist {
		return nil
	}
	if err != nil {
		return fmt.Errorf("error truncating blockfile: %w", err)
	}
	err = filestore.WFS.DeleteFile(ctx, blockId, wavebase.BlockFile_Cache)
	if err == fs.ErrNotExist {
		err = nil
	}
	if err != nil {
		log.Printf("error deleting cache file (continuing): %v\n", err)
	}
	truncateEvent := &wps.WSFileEventData{
		ZoneId:   blockId,
		FileName: wavebase.BlockFile_Term,
		FileOp:   wps.FileOp_Truncate,
	}
	if policy.IsEmbedded() {
		if file, statErr := filestore.WFS.Stat(ctx, blockId, wavebase.BlockFile_Term); statErr == nil {
			if generation, ok := filestore.TerminalHistoryGeneration(file); ok {
				truncateEvent.Generation = &generation
			}
		}
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_BlockFile,
		Scopes: []string{waveobj.MakeORef(waveobj.OType_Block, blockId).String()},
		Data:   truncateEvent,
	})
	return nil

}

func debugLog(ctx context.Context, fmtStr string, args ...interface{}) {
	blocklogger.Infof(ctx, "[conndebug] "+fmtStr, args...)
	log.Printf(fmtStr, args...)
}

func CheckConnStatus(blockId string) error {
	bdata, err := wstore.DBMustGet[*waveobj.Block](context.Background(), blockId)
	if err != nil {
		return fmt.Errorf("error getting block: %w", err)
	}
	connName := bdata.Meta.GetString(waveobj.MetaKey_Connection, "")
	if conncontroller.IsLocalConnName(connName) {
		return nil
	}
	if strings.HasPrefix(connName, "wsl://") {
		distroName := strings.TrimPrefix(connName, "wsl://")
		conn := wslconn.GetWslConn(distroName)
		connStatus := conn.DeriveConnStatus()
		if connStatus.Status != conncontroller.Status_Connected {
			return fmt.Errorf("not connected: %s", connStatus.Status)
		}
		return nil
	}
	opts, err := remote.ParseOpts(connName)
	if err != nil {
		return fmt.Errorf("error parsing connection name: %w", err)
	}
	conn := conncontroller.MaybeGetConn(opts)
	if conn == nil {
		return fmt.Errorf("no connection found")
	}
	connStatus := conn.DeriveConnStatus()
	if connStatus.Status != conncontroller.Status_Connected {
		return fmt.Errorf("not connected: %s", connStatus.Status)
	}
	return nil
}

func makeSwapToken(ctx context.Context, logCtx context.Context, blockId string, blockMeta waveobj.MetaMapType, remoteName string, shellType string) *shellutil.TokenSwapEntry {
	token := &shellutil.TokenSwapEntry{
		Token: uuid.New().String(),
		Env:   make(map[string]string),
		Exp:   time.Now().Add(5 * time.Minute),
	}
	token.Env["TERM_PROGRAM"] = "waveterm"
	token.Env["WAVETERM_BLOCKID"] = blockId
	token.Env["WAVETERM_VERSION"] = wavebase.WaveVersion
	token.Env["WAVETERM"] = "1"
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil {
		log.Printf("error finding tab for block: %v\n", err)
	} else {
		token.Env["WAVETERM_TABID"] = tabId
	}
	if tabId != "" {
		wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
		if err != nil {
			log.Printf("error finding workspace for tab: %v\n", err)
		} else {
			token.Env["WAVETERM_WORKSPACEID"] = wsId
		}
	}
	token.Env["WAVETERM_CLIENTID"] = wstore.GetClientId()
	token.Env["WAVETERM_CONN"] = remoteName
	envMap, err := resolveEnvMap(blockId, blockMeta, remoteName)
	if err != nil {
		log.Printf("error resolving env map: %v\n", err)
	}
	for k, v := range envMap {
		token.Env[k] = v
	}
	token.ScriptText = getCustomInitScript(logCtx, blockMeta, remoteName, shellType)
	return token
}
