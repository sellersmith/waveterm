// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

declare global {
  interface Window {
    hyprlaneWave: Readonly<{
      security: Readonly<{
        contextIsolated: boolean
        sandboxed: boolean
      }>
      bootstrap(): Promise<string>
      ready(): void
      isSurfaceActive(): boolean
      onSurfaceActivityChange(listener: (active: boolean) => void): () => void
    }>
  }
}

const bootstrapValue: unknown = JSON.parse(
  await window.hyprlaneWave.bootstrap()
)
if (
  typeof bootstrapValue !== "object" ||
  bootstrapValue === null ||
  !("workspaceId" in bootstrapValue) ||
  typeof bootstrapValue.workspaceId !== "string" ||
  !("surfaceId" in bootstrapValue) ||
  typeof bootstrapValue.surfaceId !== "number"
) {
  throw new Error("invalid hosted surface bootstrap")
}
const bootstrap = Object.freeze({
  workspaceId: bootstrapValue.workspaceId,
  surfaceId: bootstrapValue.surfaceId,
})
const status = document.querySelector<HTMLElement>("#status")
if (!status) throw new Error("hosted surface status element not found")
status.textContent = `Hosted surface ${bootstrap.surfaceId} · ${bootstrap.workspaceId}`
document.documentElement.dataset.hostedWaveReady = "true"
window.hyprlaneWave.ready()

export {}
