// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package web

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	"github.com/wavetermdev/waveterm/hyprlane/policy"
	"github.com/wavetermdev/waveterm/hyprlane/sessionpolicy"
	"github.com/wavetermdev/waveterm/pkg/authkey"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/eventbus"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/web/webcmd"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const wsReadWaitTimeout = 15 * time.Second
const wsWriteWaitTimeout = 10 * time.Second
const wsPingPeriodTickTime = 10 * time.Second
const wsInitialPingTime = 1 * time.Second
const wsMaxMessageSize = 10 * 1024 * 1024

const DefaultCommandTimeout = 2 * time.Second
const WebSocketChannelSize = 128
const embeddedBlockParentMaxDepth = 64

type StableConnInfo struct {
	ConnId string
	LinkId baseds.LinkId
}

var GlobalLock = &sync.Mutex{}
var RouteToConnMap = map[string]*StableConnInfo{} // stableid => StableConnInfo
var webSessionCoordinator = sessionpolicy.DefaultCoordinator

type embeddedTabLookup func(context.Context, string) (*waveobj.Tab, error)

func lookupEmbeddedTab(
	ctx context.Context,
	tabID string,
) (*waveobj.Tab, error) {
	return wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
}

func embeddedTabExists(
	ctx context.Context,
	tabID string,
	lookup embeddedTabLookup,
) bool {
	if lookup == nil {
		return false
	}
	tab, err := lookup(ctx, tabID)
	return err == nil && tab != nil
}

func RunWebSocketServer(listener net.Listener) {
	gr := mux.NewRouter()
	gr.HandleFunc("/ws", HandleWs)
	server := &http.Server{
		ReadTimeout:    HttpReadTimeout,
		WriteTimeout:   HttpWriteTimeout,
		MaxHeaderBytes: HttpMaxHeaderBytes,
		Handler:        gr,
	}
	server.SetKeepAlivesEnabled(false)
	log.Printf("[websocket] running websocket server on %s\n", listener.Addr())
	err := server.Serve(listener)
	if err != nil {
		log.Printf("[websocket] error trying to run websocket server: %v\n", err)
	}
}

var WebSocketUpgrader = websocket.Upgrader{
	ReadBufferSize:   4 * 1024,
	WriteBufferSize:  32 * 1024,
	HandshakeTimeout: 1 * time.Second,
	CheckOrigin: func(r *http.Request) bool {
		if !policy.IsEmbedded() {
			return true
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			return policy.AllowsOrigin(origin)
		}
		return r.URL.Query().Get("stableid") == wshutil.ElectronRoute && authkey.ValidateIncomingRequest(r) == nil
	},
}

func validateEmbeddedStableRoute(stableID string, tabExists func(string) bool) error {
	if stableID == wshutil.ElectronRoute {
		return nil
	}
	if !strings.HasPrefix(stableID, wshutil.RoutePrefix_Tab) {
		return fmt.Errorf("stable route is not enabled by host policy")
	}
	tabID := strings.TrimPrefix(stableID, wshutil.RoutePrefix_Tab)
	if _, err := uuid.Parse(tabID); err != nil {
		return fmt.Errorf("stable route has invalid tab id")
	}
	if !tabExists(tabID) {
		return fmt.Errorf("stable route does not name an existing server tab")
	}
	return nil
}

func embeddedSessionTabID(stableID string) (string, bool) {
	if !policy.IsEmbedded() || !strings.HasPrefix(stableID, wshutil.RoutePrefix_Tab) {
		return "", false
	}
	return strings.TrimPrefix(stableID, wshutil.RoutePrefix_Tab), true
}

func attachEmbeddedSessionRoute(stableID string) error {
	tabID, isTabRoute := embeddedSessionTabID(stableID)
	if !isTabRoute {
		return nil
	}
	return webSessionCoordinator.Attach(tabID)
}

func detachEmbeddedSessionRoute(stableID string) {
	tabID, isTabRoute := embeddedSessionTabID(stableID)
	if isTabRoute {
		webSessionCoordinator.Detach(tabID)
	}
}

func HandleWs(w http.ResponseWriter, r *http.Request) {
	err := HandleWsInternal(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func getMessageType(jmsg map[string]any) string {
	if str, ok := jmsg["type"].(string); ok {
		return str
	}
	return ""
}

func getStringFromMap(jmsg map[string]any, key string) string {
	if str, ok := jmsg[key].(string); ok {
		return str
	}
	return ""
}

type embeddedBlockParentLookup func(context.Context, string) (string, error)

func lookupEmbeddedBlockParent(
	ctx context.Context,
	blockID string,
) (string, error) {
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, blockID)
	if err != nil {
		return "", err
	}
	return block.ParentORef, nil
}

func embeddedBlockBelongsToTab(
	ctx context.Context,
	blockID string,
	tabID string,
	lookupBlockParent embeddedBlockParentLookup,
) bool {
	visited := make(map[string]bool)
	currentBlockID := blockID
	for range embeddedBlockParentMaxDepth {
		if visited[currentBlockID] {
			return false
		}
		visited[currentBlockID] = true
		parentORefString, err := lookupBlockParent(ctx, currentBlockID)
		if err != nil {
			return false
		}
		parentORef, err := waveobj.ParseORef(parentORefString)
		if err != nil {
			return false
		}
		switch parentORef.OType {
		case waveobj.OType_Tab:
			return parentORef.OID == tabID
		case waveobj.OType_Block:
			currentBlockID = parentORef.OID
		default:
			return false
		}
	}
	return false
}

func validateEmbeddedRendererRouteControl(
	ctx context.Context,
	rpcMsg *wshutil.RpcMessage,
	stableID string,
	lookupBlockParent embeddedBlockParentLookup,
) error {
	if !policy.IsEmbedded() ||
		(rpcMsg.Command != "routeannounce" && rpcMsg.Command != "routeunannounce") {
		return nil
	}
	routeData, dataIsString := rpcMsg.Data.(string)
	if rpcMsg.Route != wshutil.ControlRoute ||
		!dataIsString ||
		routeData != rpcMsg.Source {
		return fmt.Errorf("route announcement denied by host policy")
	}
	if rpcMsg.Source == stableID {
		return nil
	}
	tabID, isTabRoute := embeddedSessionTabID(stableID)
	if !isTabRoute || !strings.HasPrefix(rpcMsg.Source, wshutil.RoutePrefix_FeBlock) {
		return fmt.Errorf("route announcement denied by host policy")
	}
	blockID := strings.TrimPrefix(rpcMsg.Source, wshutil.RoutePrefix_FeBlock)
	if _, err := uuid.Parse(blockID); err != nil || lookupBlockParent == nil {
		return fmt.Errorf("route announcement denied by host policy")
	}
	if !embeddedBlockBelongsToTab(
		ctx,
		blockID,
		tabID,
		lookupBlockParent,
	) {
		return fmt.Errorf("route announcement denied by host policy")
	}
	return nil
}

func validateEmbeddedRendererLocalCommand(rpcMsg *wshutil.RpcMessage) error {
	if !policy.IsEmbedded() {
		return nil
	}
	switch rpcMsg.Command {
	case "connensure":
		data, ok := rpcMsg.Data.(map[string]any)
		if !ok {
			return fmt.Errorf("local connection initialization denied by host policy")
		}
		connName, ok := data["connname"]
		if !ok || connName == nil {
			return nil
		}
		name, ok := connName.(string)
		if !ok || (name != "" && name != "local" && !strings.HasPrefix(name, "local:")) {
			return fmt.Errorf("connection %q denied by host policy", connName)
		}
	case "remoteprocesslist":
		if rpcMsg.Route != "conn:local" {
			return fmt.Errorf("process route %q denied by host policy", rpcMsg.Route)
		}
	}
	return nil
}

func processWSCommand(
	ctx context.Context,
	jmsg map[string]any,
	outputCh chan any,
	rpcInputCh chan baseds.RpcInputChType,
	stableID string,
	lookupBlockParent embeddedBlockParentLookup,
) {
	var rtnErr error
	var cmdType string
	var rpcRequest *wshutil.RpcMessage
	defer func() {
		panicCtx := "processWSCommand"
		if cmdType != "" {
			panicCtx = fmt.Sprintf("processWSCommand:%s", cmdType)
		}
		panicErr := panichandler.PanicHandler(panicCtx, recover())
		if panicErr != nil {
			rtnErr = panicErr
		}
		if rtnErr == nil {
			return
		}
		if rpcRequest != nil && rpcRequest.ReqId != "" {
			outputCh <- map[string]any{
				"eventtype": "rpc",
				"data": map[string]any{
					"resid": rpcRequest.ReqId,
					"error": rtnErr.Error(),
				},
			}
			return
		}
		rtn := map[string]any{"type": "error", "error": rtnErr.Error()}
		outputCh <- rtn
	}()
	wsCommand, err := webcmd.ParseWSCommandMap(jmsg)
	if err != nil {
		rtnErr = fmt.Errorf("cannot parse wscommand: %v", err)
		return
	}
	cmdType = wsCommand.GetWSCommand()
	switch cmd := wsCommand.(type) {
	case *webcmd.WSRpcCommand:
		rpcMsg := cmd.Message
		if rpcMsg == nil {
			return
		}
		rpcRequest = rpcMsg
		if rpcMsg.Command != "" {
			cmdType = fmt.Sprintf("%s:%s", cmdType, rpcMsg.Command)
			if !policy.AllowsWSHCommand(rpcMsg.Command) {
				rtnErr = fmt.Errorf("command %q denied by host policy", rpcMsg.Command)
				return
			}
			if err := validateEmbeddedRendererLocalCommand(rpcMsg); err != nil {
				rtnErr = err
				return
			}
		}
		if err := validateEmbeddedRendererRouteControl(
			ctx,
			rpcMsg,
			stableID,
			lookupBlockParent,
		); err != nil {
			rtnErr = err
			return
		}
		msgBytes, err := json.Marshal(rpcMsg)
		if err != nil {
			// this really should never fail since we just unmarshalled this value
			return
		}
		rpcInputCh <- baseds.RpcInputChType{MsgBytes: msgBytes}
	}
}

func ReadLoop(
	ctx context.Context,
	conn *websocket.Conn,
	outputCh chan any,
	closeCh chan any,
	rpcInputCh chan baseds.RpcInputChType,
	routeId string,
) {
	readWait := wsReadWaitTimeout
	conn.SetReadLimit(wsMaxMessageSize)
	conn.SetReadDeadline(time.Now().Add(readWait))
	defer close(closeCh)
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[websocket] ReadPump error (%s): %v\n", routeId, err)
			break
		}
		jmsg := map[string]any{}
		err = json.Unmarshal(message, &jmsg)
		if err != nil {
			log.Printf("[websocket] error unmarshalling json: %v\n", err)
			break
		}
		conn.SetReadDeadline(time.Now().Add(readWait))
		msgType := getMessageType(jmsg)
		if msgType == "pong" {
			// nothing
			continue
		}
		if msgType == "ping" {
			now := time.Now()
			pongMessage := map[string]interface{}{"type": "pong", "stime": now.UnixMilli()}
			outputCh <- pongMessage
			continue
		}
		wsCommand := getStringFromMap(jmsg, "wscommand")
		if wsCommand == "" {
			continue
		}
		processWSCommand(
			ctx,
			jmsg,
			outputCh,
			rpcInputCh,
			routeId,
			lookupEmbeddedBlockParent,
		)
	}
}

func WritePing(conn *websocket.Conn) error {
	now := time.Now()
	pingMessage := map[string]interface{}{"type": "ping", "stime": now.UnixMilli()}
	jsonVal, _ := json.Marshal(pingMessage)
	_ = conn.SetWriteDeadline(time.Now().Add(wsWriteWaitTimeout)) // no error
	err := conn.WriteMessage(websocket.TextMessage, jsonVal)
	if err != nil {
		return err
	}
	return nil
}

func WriteLoop(conn *websocket.Conn, outputCh chan any, closeCh chan any, routeId string) {
	ticker := time.NewTicker(wsInitialPingTime)
	defer ticker.Stop()
	initialPing := true
	for {
		select {
		case msg := <-outputCh:
			var barr []byte
			var err error
			if _, ok := msg.([]byte); ok {
				barr = msg.([]byte)
			} else {
				barr, err = json.Marshal(msg)
				if err != nil {
					log.Printf("[websocket] cannot marshal websocket message: %v\n", err)
					// just loop again
					break
				}
			}
			err = conn.WriteMessage(websocket.TextMessage, barr)
			if err != nil {
				conn.Close()
				log.Printf("[websocket] WritePump error (%s): %v\n", routeId, err)
				return
			}

		case <-ticker.C:
			err := WritePing(conn)
			if err != nil {
				log.Printf("[websocket] WritePump error (%s): %v\n", routeId, err)
				return
			}
			if initialPing {
				initialPing = false
				ticker.Reset(wsPingPeriodTickTime)
			}

		case <-closeCh:
			return
		}
	}
}

func registerConn(wsConnId string, stableId string, wproxy *wshutil.WshRpcProxy) error {
	GlobalLock.Lock()
	defer GlobalLock.Unlock()
	curConnInfo := RouteToConnMap[stableId]
	if curConnInfo != nil {
		if policy.IsEmbedded() {
			return fmt.Errorf("stable route already has a live connection")
		}
		log.Printf("[websocket] warning: replacing existing connection for stableid %q\n", stableId)
		if curConnInfo.LinkId != baseds.NoLinkId {
			wshutil.DefaultRouter.UnregisterLink(curConnInfo.LinkId)
		}
	}
	if err := attachEmbeddedSessionRoute(stableId); err != nil {
		return err
	}
	linkId := wshutil.DefaultRouter.RegisterTrustedRouter(wproxy)
	RouteToConnMap[stableId] = &StableConnInfo{
		ConnId: wsConnId,
		LinkId: linkId,
	}
	return nil
}

func unregisterConn(wsConnId string, stableId string) {
	GlobalLock.Lock()
	defer GlobalLock.Unlock()
	curConnInfo := RouteToConnMap[stableId]
	if curConnInfo == nil || curConnInfo.ConnId != wsConnId {
		log.Printf("[websocket] warning: trying to unregister connection %q for stableid %q but it is not the current connection (ignoring)\n", wsConnId, stableId)
		return
	}
	delete(RouteToConnMap, stableId)
	if curConnInfo.LinkId != baseds.NoLinkId {
		wshutil.DefaultRouter.UnregisterLink(curConnInfo.LinkId)
	}
	detachEmbeddedSessionRoute(stableId)
}

func HandleWsInternal(w http.ResponseWriter, r *http.Request) error {
	stableId := r.URL.Query().Get("stableid")
	if stableId == "" {
		return fmt.Errorf("stableid is required")
	}
	err := authkey.ValidateIncomingRequest(r)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(fmt.Sprintf("error validating authkey: %v", err)))
		log.Printf("[websocket] error validating authkey: %v\n", err)
		return err
	}
	if policy.IsEmbedded() {
		err := validateEmbeddedStableRoute(stableId, func(tabID string) bool {
			return embeddedTabExists(r.Context(), tabID, lookupEmbeddedTab)
		})
		if err != nil {
			w.WriteHeader(http.StatusForbidden)
			return err
		}
	}
	conn, err := WebSocketUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return fmt.Errorf("WebSocket Upgrade Failed: %v", err)
	}
	defer conn.Close()
	wsConnId := uuid.New().String()
	outputCh := make(chan any, WebSocketChannelSize)
	closeCh := make(chan any)
	log.Printf("[websocket] new connection: connid:%s stableid:%s\n", wsConnId, stableId)
	eventbus.RegisterWSChannel(wsConnId, stableId, outputCh)
	defer eventbus.UnregisterWSChannel(wsConnId)
	wproxy := wshutil.MakeRpcProxyWithSize(fmt.Sprintf("ws:%s", stableId), WebSocketChannelSize, WebSocketChannelSize)
	defer close(wproxy.ToRemoteCh)
	if err := registerConn(wsConnId, stableId, wproxy); err != nil {
		return err
	}
	defer unregisterConn(wsConnId, stableId)
	wg := &sync.WaitGroup{}
	wg.Add(2)
	go func() {
		defer func() {
			panichandler.PanicHandler("HandleWsInternal:outputCh", recover())
		}()
		// no waitgroup add here
		// move values from rpcOutputCh to outputCh
		for msgBytes := range wproxy.ToRemoteCh {
			rpcWSMsg := map[string]any{
				"eventtype": "rpc", // TODO don't hard code this (but def is in eventbus)
				"data":      json.RawMessage(msgBytes),
			}
			outputCh <- rpcWSMsg
		}
	}()
	go func() {
		defer func() {
			panichandler.PanicHandler("HandleWsInternal:ReadLoop", recover())
		}()
		defer wg.Done()
		ReadLoop(r.Context(), conn, outputCh, closeCh, wproxy.FromRemoteCh, stableId)
	}()
	go func() {
		defer func() {
			panichandler.PanicHandler("HandleWsInternal:WriteLoop", recover())
		}()
		defer wg.Done()
		WriteLoop(conn, outputCh, closeCh, stableId)
	}()
	wg.Wait()
	close(wproxy.FromRemoteCh)
	return nil
}
