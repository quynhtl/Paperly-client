## Paperly's Extensions window (paperlyExtensions.xhtml): the extension
## marketplace, and the extensions already installed.

paperly-extensions-window =
    .title = Extensions
extensions-activity-manager =
    .title = Extensions
extensions-heading = Extensions
extensions-search =
    .placeholder = Search extensions
extensions-refresh =
    .title = Check the marketplace again
extensions-section-installed = Installed
extensions-section-marketplace = Marketplace

extensions-status-checked = Checked { $time }
extensions-status-checking = Checking the marketplace…
extensions-status-not-configured = The marketplace isn’t set up in this build of Paperly.
extensions-status-unreachable = Couldn’t reach the marketplace.
extensions-status-untrusted = The marketplace sent something Paperly couldn’t verify, so it was ignored.
extensions-status-stale = The marketplace hasn’t been updated for over a week, so Paperly keeps using what it already has.
extensions-status-retry = Try again
extensions-no-results = No extensions match “{ $query }”.
extensions-none-listed = No extensions are listed yet.
extensions-all-installed = Everything in the marketplace is already installed.
extensions-none-installed = No extensions installed.
extensions-pick-one = Select an extension to see what it does.

extensions-install = Install
extensions-update = Update
extensions-uninstall = Uninstall
extensions-enable = Enable
extensions-disable = Disable
extensions-installing = Installing…
extensions-updating = Updating…
extensions-cancel = Cancel
extensions-open-view = Open { $label }
extensions-view-failed = This view couldn’t be shown. The error is in the debug output.

extensions-publisher-official = Official
extensions-publisher-verified = Verified publisher
extensions-publisher-verified-domain = Verified: { $domain }
extensions-publisher-unverified = Unverified publisher
extensions-version = v{ $version }
extensions-license = { $license } license
extensions-badge-disabled = Disabled
extensions-badge-blocked = Blocked
extensions-badge-update = Update

extensions-not-from-marketplace = Installed from outside the marketplace, so nothing has checked it.
extensions-not-listed = No longer listed in the marketplace.
extensions-id-conflict = The marketplace lists a different extension with the same id. It can’t replace this one.
extensions-publisher-changed = This extension was installed from { $previous } on GitHub, and the marketplace now lists it under { $current }. It won’t be updated until you accept that here.
extensions-blocked-banner = Paperly switched this extension off: { $reason }
extensions-incompatible = No version of this extension runs in Paperly { $version }.

extensions-section-declares = What it says it does
extensions-section-checks = What the checks found
extensions-section-versions = Versions
extensions-declares-nothing = Nothing beyond running inside Paperly.
extensions-declares-network = Connects to { $hosts }
extensions-declares-sendsContent = Sends text from your papers, notes or items to web services
extensions-declares-clipboard = Uses the clipboard
extensions-declares-files = Writes files, or asks you for them
extensions-declares-cookies = Reads cookies and sign-ins kept by Paperly
extensions-declares-passwords = Reads saved passwords or keys
extensions-declares-programs = Starts other programs on your computer
extensions-checks-clean = The automated checks found nothing to report.
extensions-checks-caveat = Extensions run with full access to Paperly and your files. The checks read the code; they can’t prove an extension is safe.
extensions-versions-runs-in = Paperly { $min } to { $max }
extensions-link-homepage = Homepage
extensions-link-source = Source code
extensions-link-privacy = Privacy policy

extensions-confirm-install = Install { $name }?
extensions-confirm-update = Update { $name }?
extensions-confirm-changed = The marketplace changed this extension while you were deciding. This is what it offers now.
extensions-confirm-declares = It says it:
extensions-confirm-new-uses = This version also:
extensions-confirm-publisher-changed = It was installed from { $previous } on GitHub, and now comes from { $current }:
extensions-confirm-warnings = The checks found:
extensions-confirm-trust = Extensions run with full access to Paperly and your files. Install only extensions from publishers you trust.

extensions-error-network = The download failed. Check your connection and try again.
extensions-error-hash = The download didn’t match what the marketplace checked, so it wasn’t installed.
extensions-error-corrupt = The downloaded file is damaged.
extensions-error-file-access = Paperly couldn’t write the extension to your profile.
extensions-error-incompatible = No version of this extension runs in this Paperly.
extensions-error-id-conflict = An extension with the same id is already installed from outside the marketplace, so this one wasn’t installed.
extensions-error-changed = The marketplace changed this extension while you were deciding, so nothing was installed.
extensions-error-other = The extension couldn’t be installed.
