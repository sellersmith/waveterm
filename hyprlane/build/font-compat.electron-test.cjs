// Copyright 2026, Hyprlane
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow } = require("electron")
const { rm, writeFile } = require("node:fs/promises")
const { resolve } = require("node:path")

const rendererRoot = resolve(__dirname, "../../dist/hyprlane/renderer")
const pagePath = resolve(rendererRoot, ".font-compat-check.html")
const fonts = [
  "fonts/hacknerdmono-bold.ttf",
  "fonts/hacknerdmono-bolditalic.ttf",
  "fonts/hacknerdmono-italic.ttf",
  "fonts/hacknerdmono-regular.ttf",
  "fonts/inter-variable.woff2",
  "fonts/jetbrains-mono-v13-latin-200.woff2",
  "fonts/jetbrains-mono-v13-latin-700.woff2",
  "fonts/jetbrains-mono-v13-latin-regular.woff2",
]

async function main() {
  await writeFile(
    pagePath,
    "<!doctype html><html><body><p>font compatibility check</p></body></html>"
  )

  let browserWindow
  try {
    await app.whenReady()
    browserWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    await browserWindow.loadFile(pagePath)
    const results = await Promise.race([
      browserWindow.webContents.executeJavaScript(`
        (async () => {
          const paths = ${JSON.stringify(fonts)}
          return Promise.all(paths.map(async (path, index) => {
            const family = "HyprlaneFontCheck" + index
            const face = new FontFace(family, "url('" + path + "')")
            document.fonts.add(face)
            await Promise.race([
              face.load(),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error("font load timed out: " + path)),
                5000
              )),
            ])
            return { path, status: face.status }
          }))
        })()
      `),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("renderer font check timed out")),
          15000
        )
      ),
    ])
    const failures = results.filter((entry) => entry.status !== "loaded")
    if (failures.length > 0) {
      throw new Error(
        `Chromium rejected compatibility fonts: ${JSON.stringify(failures)}`
      )
    }
    console.info(
      JSON.stringify({ fontCount: results.length, status: "loaded" })
    )
  } finally {
    browserWindow?.destroy()
    await rm(pagePath, { force: true })
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
