# The application id, and the profile that moved with it

Two changes that look like one. They are written up together because doing either
without the other leaves the app quietly broken, and because the failure in both
cases is silent -- nothing logs an error, things just stop being there.

## What the id is, and what actually reads it

`zotero@zotero.org` -> `paperly@paperly.org`. It lives in **three** places, and
they must agree:

| Where | Becomes | Read by |
| --- | --- | --- |
| `app/config.sh` `APP_ID` | baked into `XPIInstall.sys.mjs` and `AddonUpdateChecker.sys.mjs` by `fetch_xulrunner` | the add-on manager, at install and update time |
| `app/assets/application.ini` `[App] ID` | `Services.appinfo.ID` | the add-on manager, at startup |
| `resource/config.mjs` `GUID` | nothing | **nothing** |

`ZOTERO_CONFIG.GUID` is referenced nowhere in the tree -- verified by grep across
`chrome/`, `resource/` and `components/`. It is kept in step so the three never
disagree, not because anything consults it. Likewise `Services.appinfo.ID` appears
in no Zotero JS at all; the only consumers are inside the patched Gecko modules.

So the blast radius of this change is exactly one subsystem: plugin compatibility.

## Why the compatibility alias is not optional

An installed plugin's `extensions.json` record pins the app id it was installed
under:

```json
"targetApplications": [{ "id": "zotero@zotero.org", "minVersion": "9.0", "maxVersion": "11.*" }]
```

`XPIDatabase.sys.mjs` resolves that with `matchingTargetApplication`, which returns
`null` when no recorded id equals `Services.appinfo.ID`. `isCompatibleWith` then
returns `false` on its first line, and the add-on manager sets `appDisabled`.

Measured, on a copy of the dev profile, with a deliberately unmatched id:

```
active= False | appDisabled= True | targetApps= ['nobody@example.invalid']
"Calling bootstrap method 'startup' for plugin zotero-webai"  -> 0 occurrences
```

Changing `APP_ID` on its own therefore switches off **every** installed plugin,
Paperly AI included, with no error anywhere.

`fetch_xulrunner` fixes this by aliasing Zotero's ids to `$APP_ID` inside
`matchingTargetApplication`. Zotero set the precedent itself: the same line already
aliased `zotero@chnm.gmu.edu` (Zotero 6 and earlier) so those plugins survived the
move to `zotero@zotero.org`. We extended the same line rather than inventing a
mechanism.

The assignment mutates the record in place, so the profile is rewritten to the new
id the first time it is read. Measured on the same profile:

```
before: targetApps= ['zotero@zotero.org']   active= True
after:  targetApps= ['paperly@paperly.org'] active= True  appDisabled= False
```

Two consequences worth knowing:

- The aliases are only needed once per profile, but they must stay in the patch
  forever -- any profile that has not yet been opened by the new build still holds
  the old id.
- It also means every plugin written for Zotero installs and runs on Paperly. That
  is deliberate. Plugin manifests key off `applications.zotero`, a **literal string**
  in the `fetch_xulrunner` patches, not off `APP_ID`, so renaming the app id does not
  break the manifest format and no plugin author has to do anything.

## The profile directory, which had already moved

Commit `54e238c93` set `Vendor=Paperly` / `Name=Paperly` in `application.ini`. That
is what decides the profile root, **not** the id -- and nothing migrated with it, so
the tree was left in this state:

```
~/Library/Application Support/Paperly     <- empty
~/Library/Application Support/Zotero      <- profiles.ini, Profiles/qv9ddmvt.default, Profiles/paperly-dev
```

It had not bitten yet only because every launch path passes `-profile` explicitly.
The first launch without it would have created a blank profile and looked exactly
like losing every preference and plugin.

`app/scripts/migrate_profile` does the move. It cannot be done the way
`zotero.sqlite -> paperly.sqlite` was: Gecko resolves the profile root in C++
(`nsXREDirProvider`) before any JS exists, so there is no point at which Zotero code
could redirect it.

What the script does, and why each step is there:

1. **Refuses to run on a live profile** -- `.parentlock` via `lsof`, plus a `pgrep`
   backstop. A half-copied sqlite file is worse than no copy.
2. **Refuses to merge** into a destination that already has `profiles.ini`. Two
   `extensions.json` disagreeing about what is installed is not recoverable by
   inspection.
3. **Copies with `ditto`, whole-directory** -- so no sqlite file is ever separated
   from its `-wal`. That is the same failure that nearly cost a library during the
   database rename.
4. **Rewrites stored absolute paths.** This is the step that is easy to miss.
   `extensions.json` holds the profile path twice per plugin: as a filesystem path
   and again percent-encoded inside a `jar:` URI. Left alone, the migrated profile
   goes on loading plugins out of the **old** directory -- and looks migrated right
   up until the backup is deleted. Files touched: `extensions.json`,
   `extensions.json.bak`, `pkcs11.txt`.
5. **Drops `addonStartup.json.lz4` and `startupCache/`.** Pure caches, keyed by path
   and version, rebuilt on launch. Stale ones are the usual reason a migrated
   profile starts with its plugins missing.
6. **Leaves the source in place as the backup.** It copies; it never moves.

`profiles.ini` needs no rewriting -- it uses `IsRelative=1`.

Windows is refused outright rather than guessed at. The path is
`%APPDATA%\Zotero` -> `%APPDATA%\Paperly`, but it cannot be run or tested here, and
steps 4 and 5 still have to happen by hand.

## Running it

```bash
cd paperly-client/app
./scripts/migrate_profile --dry-run   # safe while the app is open; changes nothing
./scripts/migrate_profile             # quit Paperly first
```

`PAPERLY_PROFILE_SRC` / `PAPERLY_PROFILE_DEST` override both paths, which is how the
whole thing was rehearsed on a copy before being aimed at the real profile. The
`pgrep` backstop is skipped when they are set, since a live app is a false positive
for a sandbox run.

## If something is wrong

The id lives in the three places in the table at the top. To revert, set all three
back to `zotero@zotero.org`, then `./scripts/fetch_xulrunner -p m` (it reuses the
cached Firefox zip; no download) followed by `./scripts/dir_build -p m`. The alias
line becomes a harmless self-assignment.

A profile is reverted by pointing the app back at the untouched original with
`-profile`, or by deleting `Application Support/Paperly` and running the script
again.

## Deliberately still named Zotero

The reasons are in `NAMING.md`. One entry there is now out of date: `APP_ID` and
`application.ini`'s `ID` are no longer `zotero@zotero.org`. What remains Zotero is
the plugin manifest key `applications.zotero`, which is a literal in the
`fetch_xulrunner` patches and is what keeps the plugin ecosystem compatible.
