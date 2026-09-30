# Making something people can download

Everything here was run on macOS. The macOS steps are measured; the Windows and Linux
ones are read from `build.sh` and marked where they could not be tested.

## Before anything else: the signature problem

A build produced by these steps is **unsigned**. Measured on the dmg this document
describes:

```
spctl -a -t install Paperly-11.0.dmg
  → rejected
    source=no usable signature

codesign -dvvv staging/Paperly.app
  → Signature=adhoc
    TeamIdentifier=not set
```

`codesign_local` applies an ad-hoc signature, which is enough for the machine that
built it and nothing else. On anybody else's Mac, macOS refuses to open it and says:

> **"Paperly" is damaged and can't be opened. You should move it to the Trash.**

That message is a lie about the file and people believe it. The honest workaround is
telling users to run `xattr -cr /Applications/Paperly.app` after copying, which most
will not do and some cannot be talked through.

Fixing it properly costs **99 USD/year** for the Apple Developer Program. With a
Developer ID in hand:

1. Put the certificate's SHA-1 in `DEVELOPER_ID` in `app/config.sh`
2. Set `SIGN=1`
3. Fill `NOTARIZATION_BUNDLE_ID`, `NOTARIZATION_USER`, `NOTARIZATION_TEAM_ID` and
   `NOTARIZATION_PASSWORD` (an app-specific password, not your Apple ID password)
4. Build with a channel other than `test`

`build.sh` notarizes only when `SIGN=1` and the channel is not `test`. Without a
signature there is nothing to notarize -- Apple rejects the submission -- so it skips
the step and says so rather than failing the build at its last line.

Windows wants a separate code-signing certificate. Without one, SmartScreen warns
until enough people install it anyway, which for a new project is a long wait.

None of this stops you shipping. It decides how much friction the first run has.

## macOS: the dmg

Verified end to end. Produces `app/dist/Paperly-11.0.dmg`, about 202 MB, containing
`Paperly.app` and a "Drag Here to Install" symlink.

```bash
# 1. Source build
npm install
npm run build

# 2. Gecko, once per version bump (reuses the cached Firefox zip, no download)
cd app
./scripts/fetch_xulrunner -p m

# 3. Bundle the plugin into the application -- omit for the app on its own
./scripts/bundle_plugin

# 4. Stage the source tree for packaging
cd ..
python3 app/scripts/prepare_build -s build -o /tmp/paperly-build -c release

# 5. Build and package
cd app
./build.sh -d /tmp/paperly-build -p m -c release
```

`-c release` keeps the version plain (`Paperly-11.0.dmg`). Any other channel spells
itself into the filename: `-c test` gives `Paperly-11.0-test.1+3d48ba8b2.dmg`.

Check what came out before publishing it:

```bash
MP=$(hdiutil attach app/dist/Paperly-11.0.dmg -nobrowse -readonly | grep -o '/Volumes/.*')
ls "$MP/Paperly.app/Contents/Resources/distribution/extensions/"   # the bundled plugin
grep -E '^(Vendor|Name|ID)=' "$MP/Paperly.app/Contents/Resources/app/application.ini"
hdiutil detach "$MP"
```

## Windows: the exe

**Cannot be built from macOS.** The installer is made by NSIS through `makensis.exe`
and the paths go through `cygpath`, so `build.sh` checks `WIN_NATIVE` and, off
Windows, prints *"Not building on Windows; only building zip file"*. You get
`Paperly-11.0_win-x64.zip` and no installer.

On a Windows machine (or VM) you need Cygwin, NSIS in the path `NSIS_DIR` points at in
`app/config.sh`, and `upx`. Then:

```bash
cd app
./scripts/fetch_xulrunner -p w
./scripts/bundle_plugin
cd ..
python3 app/scripts/prepare_build -s build -o /tmp/paperly-build -c release
cd app
./build.sh -d /tmp/paperly-build -p w -c release
```

Produces `Paperly-11.0_x64_setup.exe`, plus `win32` and `arm64` if you do not narrow
it with `-a x64`. Untested here -- there is no Windows machine in this project.

## Linux: the tarball

```bash
cd app
./scripts/fetch_xulrunner -p l
./scripts/bundle_plugin
cd ..
python3 app/scripts/prepare_build -s build -o /tmp/paperly-build -c release
cd app
./build.sh -d /tmp/paperly-build -p l -c release
```

Produces `Paperly-11.0_linux-x64.tar.xz`, extracting to `Paperly_linux-x64/`. No
signing question on Linux. Untested here.

## Publishing

GitHub Releases is enough and costs nothing:

1. Tag the commit you built from -- `git tag v11.0 && git push origin v11.0`. Without
   this you cannot tell later which source produced a given download.
2. Draft a release on the tag, attach the artifacts from `app/dist/`.
3. Say in the release notes that the build is unsigned and what to do about it, for as
   long as that is true.

Paperly has no update channel: `[AppUpdate]` was removed from `application.ini` and
`app.update.auto` is false, so nothing phones home and nobody is told about a new
version automatically. `app.update.url.manual` points at the releases page, which is
where people will look.

## If you bundle the plugin

`bundle_plugin` puts Paperly AI inside the application, so one download gives the user
a working setup. It also means you are **redistributing the plugin**, which needs its
licence to permit that. Paperly AI derives from a project carrying no licence; until
that changes, the permission does not exist. Building without step 3 produces the
application alone, which is AGPLv3 and yours to distribute.
