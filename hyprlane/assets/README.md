# Renderer compatibility assets

The Hyprlane renderer build never copies Wave's `public/` directory. Its
commercial Font Awesome Pro files and Wave product logos are excluded at the
build boundary.

The compatibility manifest pins three independently distributable packages:

- Phosphor Web (MIT) supplies icon glyphs. The additive DOM adapter maps every
  static upstream `fa-*` icon reference to an audited Phosphor class.
- Inter and JetBrains Mono come from Fontsource packages under OFL-1.1.
- The four legacy `hacknerdmono-*.ttf` output names contain JetBrains Mono
  WOFF2 data. Only the URL names are retained because unmodified upstream
  `fontutil.ts` requests those paths; no Hack Nerd Font data is shipped.

The build emits the exact package licenses, source hashes, and output hashes in
`compatibility-assets.json`. Chromium signature-sniffing for all eight font
URLs, including WOFF2 data behind the legacy `.ttf` names, is covered by:

```bash
npx electron hyprlane/build/font-compat.electron-test.cjs
```
