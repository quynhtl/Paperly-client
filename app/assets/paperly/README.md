# The Paperly app icon

One drawing, one page, every size. `icon.html` composes the icon in a browser
and `build-icons.sh` screenshots it with headless Chrome, so changing the look
means editing CSS, not re-exporting a dozen files by hand.

```bash
./build-icons.sh            # the shipped look, "slate"
CHROME=/path/to/chrome ./build-icons.sh
```

It writes, in place:

| File | Used by |
| --- | --- |
| `../../mac/Contents/Resources/paperly.icns` | the macOS bundle, via `CFBundleIconFile` |
| `../../win/zotero.ico` | the Windows executable and installer |
| `../../linux/icons/icon{32,64,128}.png` | the Linux launcher |

The same page renders the web port's icons; see `paperly-web/docs/PORTING.md`.

## Why it is built this way

**The source is `Paperly_logo.png`, but the icon is drawn from
`paperly-mark.svg`.** The logo is 750px with the hexagon only ~110px of it;
blown up to 1024 it is mush. The SVG is that hexagon traced by hand, so it is
sharp at every size. Change the logo, re-trace the mark.

**The corner is a superellipse, not a `border-radius`.** Apple's corner is
continuous and the difference shows the moment the icon sits beside a system
one. `squircle()` walks the curve directly.

**`slate` is the logo's own ground.** The mark's cut-outs are painted in that
colour, so any other plate would show them as dark holes.

## The macOS bundle no longer carries an asset catalogue

Stock Zotero shipped `Assets.car` holding nothing but the old `AppIcon`, named
from `CFBundleIconName`. Rebuilding one needs `actool`, which is Xcode-only --
a Command Line Tools install does not have it. So the catalogue is gone and
`Info.plist` names a `.icns` through `CFBundleIconFile` instead, which every
macOS version reads. Nothing else was in the catalogue; `assetutil --info`
listed only `AppIcon` and its layers.

If full Xcode is ever installed and the layered icon is wanted back, build an
`AppIcon.appiconset` from the rendered PNGs and compile it with `actool`.

## Traps

**Do not set the Finder custom-icon flag on the bundle.** `SetFile -a C` makes
Finder look for an `Icon\r` resource fork that is not there, and the app then
shows as a plain blue folder. Clear it with `SetFile -a c`. Measured with
`NSWorkspace.icon(forFile:)`, which is what the Dock asks.

**A dev build reads `app/staging/Zotero.app`, which is gitignored.** Installing
there is what makes the running instance change; committing the sources is what
makes the next build keep it. `build-icons.sh` does the second, not the first.
