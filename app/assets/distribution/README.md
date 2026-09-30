# Plugins that ship inside Paperly

Anything in `extensions/` is copied into the built application, and Gecko installs it
into the user's profile the first time Paperly starts. One download, plugin already
there.

## The one rule

**Each file must be named `<addon-id>.xpi`.** Gecko derives the add-on id from the
filename (`getExpectedID` in `XPIProvider.sys.mjs`) and skips any file whose name is
not a valid id -- silently, as far as the user can tell. `paperly-ai@paperly.org.xpi`,
not `Paperly.AI-0.9.37.xpi`.

That is why `app/scripts/bundle_plugin` renames the plugin's build output instead of
copying it as-is.

## What happens at first start

Measured on a fresh profile:

```
id          : paperly-ai@paperly.org
source      : distribution
location    : app-profile
active      : True   userDisabled: False   appDisabled: False
```

The xpi is copied into the profile and `extensions.installedDistroAddon.<id>` is set
to true. Two consequences:

- It is a real install, not the side-load that Paperly disables by default. Nothing
  has to flip an "enable me" flag afterwards.
- It installs **once**. A user who removes the plugin does not get it forced back on
  the next start. A new version only replaces it when the application version changes
  *and* the bundled version is higher.

## Filling it

```bash
./scripts/bundle_plugin      # builds ../paperly-plugin and drops the xpi here
./scripts/dir_build -p m     # or build.sh for a release
```

The xpis themselves are gitignored -- they are build output, and a binary in a source
tree is a merge conflict waiting to happen.

## Before you ship one

A bundled plugin is redistributed with the application. Make sure its licence lets
you do that. Paperly AI derives from a project that carries no licence, which means
that permission does not exist yet -- see its repository for where that stands.
