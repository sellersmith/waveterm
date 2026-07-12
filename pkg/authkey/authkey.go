// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package authkey

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"

	"github.com/wavetermdev/waveterm/hyprlane/policy"
)

var authkey string

const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY"
const AuthKeyHeader = "X-AuthKey"

func ValidateIncomingRequest(r *http.Request) error {
	reqAuthKey := r.Header.Get(AuthKeyHeader)
	if reqAuthKey == "" {
		return fmt.Errorf("no x-authkey header")
	}
	if subtle.ConstantTimeCompare([]byte(reqAuthKey), []byte(GetAuthKey())) != 1 {
		return fmt.Errorf("x-authkey header is invalid")
	}
	return nil
}

func SetAuthKeyFromEnv() error {
	if policy.IsEmbedded() {
		authkey = policy.Current().AuthKey
	} else {
		authkey = os.Getenv(WaveAuthKeyEnv)
	}
	os.Unsetenv(WaveAuthKeyEnv)
	if authkey == "" {
		return fmt.Errorf("no auth key found in startup bootstrap")
	}
	return nil
}

func GetAuthKey() string {
	return authkey
}
