// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "electron"
import type { NormalizedWaveBackend } from "./backend"

const AUTH_HEADER = "X-AuthKey"

export function installAuthKeyInjection(
  partitionSession: Session,
  backend: NormalizedWaveBackend
): () => void {
  const allowedOrigins = new Set([backend.webOrigin, backend.wsOrigin])
  partitionSession.webRequest.onBeforeSendHeaders(
    {
      urls: [`${backend.webOrigin}/*`, `${backend.wsOrigin}/*`],
    },
    (details, callback) => {
      let allowed = false
      try {
        allowed = allowedOrigins.has(new URL(details.url).origin)
      } catch {
        allowed = false
      }
      if (!allowed) {
        callback({ requestHeaders: details.requestHeaders })
        return
      }
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          [AUTH_HEADER]: backend.authKey,
        },
      })
    }
  )
  return () => partitionSession.webRequest.onBeforeSendHeaders(null)
}
