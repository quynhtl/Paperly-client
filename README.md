Paperly
=======

Paperly is a desktop reference manager for reading research papers. It keeps your
library on your own machine: no account, no sync server, no cloud.

It is built as a modified version of [Zotero](https://www.zotero.org/), and it
inherits Zotero's data model, its 760+ web translators and its PDF/EPUB reader.
Paperly is not affiliated with, endorsed by, or supported by Zotero or the
Corporation for Digital Scholarship.

> **Status: work in progress.** Paperly currently runs from source. There is no
> installer, no auto-update and no release build yet.

What is different from Zotero
-----------------------------

**Everything stays local.** Account sign-in, the sync toolbar button and the sync
preference pane are gone, and the client no longer contacts `api.zotero.org` on its
own. The only outbound requests left are the ones you ask for: fetching translators
and citation styles when you import from the web.

**Its own identity.** The application is named Paperly, its database is
`paperly.sqlite`, its bundle id is `org.paperly.paperly` and its profile lives in
`Application Support/Paperly`. Existing Zotero libraries are migrated on first run,
and nothing is moved without a backup being written first.

**Reading workflow**, added by the companion plugin: a per-paper reading status you
can tick from the item list, a starred collection, and an AI panel that opens beside
the reader. See [Paperly AI](https://github.com/quynhtl/Paperly).

Zotero plugins still work. Paperly keeps the plugin manifest format and aliases
Zotero's application ids, so an add-on built for Zotero installs unchanged.

Building from source
--------------------

Requires Node.js, Python 3, and Xcode command line tools on macOS.

```bash
git clone --recursive https://github.com/quynhtl/Paperly-client
cd Paperly-client
npm install
npm run build

cd app
./scripts/fetch_xulrunner -p m    # m = macOS, w = Windows, l = Linux
./scripts/dir_build -p m
```

That produces `app/staging/Paperly.app`. Run it directly, or point it at an isolated
profile and library while developing:

```bash
app/staging/Paperly.app/Contents/MacOS/paperly \
  -profile /path/to/profile -datadir /path/to/library
```

Tests run inside a built instance:

```bash
test/runtests.sh -f item        # one file, stop on first failure
test/runtests.sh                # everything
```

Notes on the changes made to Zotero, and why, are in
[`app/assets/paperly/`](app/assets/paperly/) — start with `NAMING.md` for what was
renamed and what deliberately was not, and `APP-ID.md` for the application id and
the profile migration.

Migrating from Zotero
---------------------

Paperly reads Zotero's database format, so an existing library works. Back it up
first anyway.

- **Library data** is not moved. Pass `-datadir ~/Zotero`, or set the data directory
  in Settings.
- **The database file** is renamed `zotero.sqlite` → `paperly.sqlite` on first run.
  A full copy is written to `zotero.sqlite.pre-paperly.bak` before anything moves.
- **The profile** (preferences, installed plugins) moves with
  `app/scripts/migrate_profile`. Run it with Paperly closed; it copies rather than
  moves, and leaves the original in place as the backup.

License
-------

Paperly is free software, released under the **GNU Affero General Public License,
version 3 or later** — the same license as Zotero. The full text is in
[`COPYING`](COPYING), together with the copyright notices of the original work.

Because it is AGPLv3, anyone who distributes Paperly, or runs a modified version as
a network service, has to make the corresponding source available under the same
license.

### Attribution and modification notice

Paperly is a modified version of Zotero.

- Zotero is Copyright © 2018 Corporation for Digital Scholarship, and
  Copyright © 2006–2017 Roy Rosenzweig Center for History and New Media, George
  Mason University. Those notices are preserved in [`COPYING`](COPYING).
- This fork diverges from Zotero at commit
  [`0d0bbc892`](https://github.com/zotero/zotero/commit/0d0bbc8925f0b7ecc35f1c4cb03f5063c6747529)
  (27 September 2026). Modifications by Paperly contributors begin
  29 September 2026 and are listed in the commit history of the `paperly` branch.
- **"Zotero" is a registered trademark of the Corporation for Digital Scholarship.**
  Paperly uses the name only to identify the software this project is derived from.
  The trademark is why the application is renamed rather than shipped as "Zotero";
  it does not indicate any endorsement.

Report problems with Paperly here, in this repository's issues — not to the Zotero
forums, which support Zotero and cannot help with a fork.
