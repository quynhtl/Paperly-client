/*
	***** BEGIN LICENSE BLOCK *****
	
	This file is part of Paperly, a fork of Zotero.
	
	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
	
	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.
	
	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
	
	***** END LICENSE BLOCK *****
*/

// Paperly's extension marketplace, as the app sees it: the signed index the
// paperly-extensions repository publishes, and installing from it.
//
// Extensions are ordinary Zotero plugins, run by Zotero.Plugins; this only
// decides what gets installed. The index is believed only when its signature
// verifies with the public key in prefs, so nothing between the marketplace
// and the user -- a proxy trusted through the system's certificate store
// included -- can change what is offered. Every install from here then names
// the SHA-256 the index gives for the file, and the add-on manager refuses a
// download that does not match it.
//
// The add-on manager also updates extensions by itself, daily, from the update
// URL each declares -- for a listed extension, a file the marketplace publishes
// unsigned, which anything in between could rewrite. So an update it is about
// to make over a marketplace extension goes ahead only when the signed index
// lists that version with that file's SHA-256, and the version uses nothing the
// installed one did not; anything else is cancelled, and it tries again the
// next day. An update that uses more is the user's to confirm, in the
// Extensions window.

Zotero.PaperlyExtensions = new function () {
	const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
	// Long enough after startup not to compete with it
	const FIRST_CHECK_DELAY = 60 * 1000;
	const CHECK_TICK = 60 * 60 * 1000;
	const CACHE_DIR_NAME = 'paperly-extensions';
	let KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
	let SIGNATURE_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };
	
	var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	
	/**
	 * The version of the extension API that docs/api.md in paperly-extensions
	 * describes: registerView(), openWindow(), getContext(). Raised only for a
	 * change that could break an extension written against an earlier one.
	 */
	this.apiVersion = 1;
	
	var _index = null;
	var _listeners = new Set();
	// The text last selected in a reader, as its selection popup reported it
	var _lastSelection = null;
	// key ('<pluginID>:<id>') -> view, in the order they were added
	var _views = new Map();
	var _checkTimer = null;
	var _sandbox = null;
	// The installs install() started, which the update check lets through
	var _ownInstalls = new WeakSet();
	var _updateGuard = {
		onInstallStarted(install) {
			let refusal = _checkUpdate(install);
			if (refusal) {
				Zotero.warn(`Paperly extensions: not updating ${install.existingAddon.id} `
					+ `to ${install.addon && install.addon.version}: ${refusal}`);
				return false;
			}
			return true;
		}
	};
	
	
	this.init = function () {
		Zotero.addShutdownListener(() => clearTimeout(_checkTimer));
		AddonManager.addInstallListener(_updateGuard);
		Zotero.addShutdownListener(() => AddonManager.removeInstallListener(_updateGuard));
		// What the update check compares with; until it is here, updates wait
		this.getIndex().catch(e => Zotero.logError(e));
		// An extension's views go when it stops, however it stops
		Zotero.Plugins.addObserver({
			shutdown: ({ id }) => this._removeViewsOf(id)
		});
		// Selecting text in the reader renders its selection popup; listening for
		// that is how getContext() knows the selection. Nothing is added to the popup.
		Zotero.Reader.registerEventListener('renderTextSelectionPopup', ({ reader, params }) => {
			let annotation = (params && params.annotation) || {};
			_lastSelection = {
				tabID: reader.tabID,
				text: annotation.text || '',
				pageLabel: annotation.pageLabel || null
			};
		});
		if (!this.isConfigured() || !Zotero.Prefs.get('paperlyExtensions.autoCheck')) {
			return;
		}
		let tick = () => {
			let last = Zotero.Prefs.get('paperlyExtensions.lastCheck') * 1000;
			if (Date.now() - last >= CHECK_INTERVAL) {
				this.refresh().catch(e => Zotero.debug(`Paperly extensions: ${e.message}`, 2));
			}
			_checkTimer = setTimeout(tick, CHECK_TICK);
		};
		_checkTimer = setTimeout(tick, FIRST_CHECK_DELAY);
	};
	
	
	/**
	 * Whether there is a marketplace to talk to: an address, and a key to
	 * check what comes from it.
	 */
	this.isConfigured = function () {
		return !!(Zotero.Prefs.get('paperlyExtensions.registryURL')
			&& Zotero.Prefs.get('paperlyExtensions.publicKey'));
	};
	
	
	this.getRegistryURL = function () {
		let url = Zotero.Prefs.get('paperlyExtensions.registryURL');
		return url.endsWith('/') ? url : url + '/';
	};
	
	
	/**
	 * The last index that verified, from memory or from the profile, or null if
	 * there has never been one. Never goes to the network; refresh() does.
	 */
	this.getIndex = async function () {
		if (_index) {
			return _index;
		}
		let dir = _getCacheDir();
		let bytes, signature;
		try {
			bytes = await IOUtils.read(PathUtils.join(dir, 'index.json'));
			signature = await IOUtils.readUTF8(PathUtils.join(dir, 'index.json.sig'));
		}
		catch {
			// Never fetched yet
			return null;
		}
		try {
			_index = await _parseVerified(bytes, signature);
		}
		catch (e) {
			// A copy kept under an older key, say. The next refresh replaces it.
			Zotero.debug(`Paperly extensions: ignoring the kept index: ${e.message}`, 2);
		}
		return _index;
	};
	
	
	/**
	 * Fetches the index, verifies it and keeps it.
	 */
	this.refresh = async function () {
		if (!this.isConfigured()) {
			throw _error('not-configured', 'The extension marketplace is not set up');
		}
		let base = this.getRegistryURL();
		let options = {
			noCache: true,
			// The marketplace has no business with anyone's cookies
			anon: true,
			errorDelayMax: 0,
			timeout: 30000
		};
		let indexRequest, signatureRequest;
		try {
			[indexRequest, signatureRequest] = await Promise.all([
				Zotero.HTTP.request('GET', base + 'index.json', { ...options, responseType: 'arraybuffer' }),
				Zotero.HTTP.request('GET', base + 'index.json.sig', { ...options, responseType: 'text' })
			]);
		}
		catch (e) {
			throw _error('network', `The marketplace could not be reached: ${e.message}`);
		}
		let bytes = new Uint8Array(indexRequest.response);
		let signature = signatureRequest.response;
		let index = await _parseVerified(bytes, signature);
		
		// A correctly signed but older index is a replay: whoever serves it
		// could be hiding a block made since
		let current = await this.getIndex();
		if (current && Date.parse(index.generated) < Date.parse(current.generated)) {
			throw _error('stale', 'The marketplace sent an older index than the one already seen');
		}
		
		let dir = _getCacheDir();
		await IOUtils.makeDirectory(dir, { ignoreExisting: true });
		await IOUtils.write(PathUtils.join(dir, 'index.json'), bytes);
		await IOUtils.writeUTF8(PathUtils.join(dir, 'index.json.sig'), signature);
		_index = index;
		Zotero.Prefs.set('paperlyExtensions.lastCheck', Math.round(Date.now() / 1000));
		await _applyBlocked(index.blocked);
		_notify('index');
		return index;
	};
	
	
	/**
	 * What the marketplace blocks, by id, as of the last index that verified.
	 * Zotero.Plugins asks about it (getMarketplaceBlockReason()) at startup,
	 * before any plugin runs, and synchronously -- hence a pref rather than the
	 * kept index.
	 */
	this.getBlockedPlugins = function () {
		let json = Zotero.Prefs.get('paperlyExtensions.blocked');
		if (!json) {
			return {};
		}
		let blocked = {};
		try {
			for (let [id, entry] of Object.entries(JSON.parse(json))) {
				if (entry && typeof entry.reason == 'string' && Array.isArray(entry.versionRanges)) {
					blocked[id] = {
						versionRanges: entry.versionRanges.filter(r => typeof r == 'string' || (r && typeof r == 'object')),
						reason: entry.reason,
						global: entry.global === true
					};
				}
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		return blocked;
	};
	
	
	/**
	 * Why the marketplace blocks an add-on, or false; Zotero.Plugins asks after
	 * checking its own list. Versions compare as in the add-on manager and the
	 * marketplace's build (scripts/lib/version.mjs), so a range blocks here just
	 * what it took out of the index there. A block names an id, and anyone can
	 * list an id, so it applies only to the marketplace's copy of an extension
	 * -- unless the maintainers marked it global, for a plugin from elsewhere
	 * known to do harm.
	 */
	this.getMarketplaceBlockReason = function (addon) {
		let entry = this.getBlockedPlugins()[addon.id];
		if (!entry || (!entry.global && !_isFromMarketplace(addon))) {
			return false;
		}
		let blocked = entry.versionRanges.some((range) => {
			if (typeof range == 'string') {
				return range == '*' || range == addon.version;
			}
			return (!range.minVersion || Services.vc.compare(addon.version, range.minVersion) >= 0)
				&& (!range.maxVersion || Services.vc.compare(addon.version, range.maxVersion) <= 0);
		});
		return blocked ? entry.reason : false;
	};
	
	
	/**
	 * Why an installed add-on is switched off by a marketplace block, or null.
	 */
	this.getBlockReason = function (addon) {
		if (addon.blocklistState != Ci.nsIBlocklistService.STATE_BLOCKED) {
			return null;
		}
		return this.getMarketplaceBlockReason(addon) || null;
	};
	
	
	/**
	 * Whether `signature` (base64) signs `bytes` under `publicKey` (base64
	 * SPKI), as scripts/lib/sign.mjs in paperly-extensions makes it.
	 */
	this.verify = async function (bytes, signature, publicKey = Zotero.Prefs.get('paperlyExtensions.publicKey')) {
		try {
			let subtle = _getSubtle();
			let key = await subtle.importKey('spki', _fromBase64(publicKey), KEY_ALGORITHM, false, ['verify']);
			return await subtle.verify(SIGNATURE_ALGORITHM, key, _fromBase64(signature), bytes);
		}
		catch (e) {
			Zotero.debug(`Paperly extensions: cannot check a signature: ${e}`, 2);
			return false;
		}
	};
	
	
	/**
	 * The newest version of a listed extension that this Paperly can run, or
	 * null.
	 */
	this.getCompatibleVersion = function (extension) {
		let appVersion = Services.appinfo.version;
		return extension.versions.find(
			v => Services.vc.compare(appVersion, v.minAppVersion) >= 0
				&& Services.vc.compare(appVersion, v.maxAppVersion) <= 0
		) || null;
	};
	
	
	/**
	 * Installs, or updates to, the newest version of a listed extension that
	 * this Paperly can run.
	 *
	 * @param {String} id
	 * @param {Object} [options]
	 * @param {Function} [options.onProgress] - Called with 0..1 while downloading
	 * @return {Promise<Addon>}
	 */
	this.install = async function (id, { onProgress } = {}) {
		let index = await this.getIndex();
		let extension = index && index.extensions.find(x => x.id == id);
		if (!extension) {
			throw _error('not-listed', `${id} is not in the marketplace`);
		}
		// Anyone can list an id, so one already taken by an add-on from
		// elsewhere is a different extension's, and the listing must not replace it
		let existing = await AddonManager.getAddonByID(id);
		if (existing && !_isListingOf(extension, existing)) {
			throw _error('id-conflict', `${id} is already installed from outside the marketplace`);
		}
		let release = this.getCompatibleVersion(extension);
		if (!release) {
			throw _error('incompatible', `No version of ${id} runs in Paperly ${Services.appinfo.version}`);
		}
		
		let install = await AddonManager.getInstallForURL(release.url, {
			hash: 'sha256:' + release.sha256,
			name: extension.name,
			version: release.version,
			telemetryInfo: { source: 'paperly-extensions' }
		});
		_ownInstalls.add(install);
		let addon = await new Promise((resolve, reject) => {
			install.addListener({
				onDownloadProgress(install) {
					if (onProgress && install.maxProgress > 0) {
						onProgress(install.progress / install.maxProgress);
					}
				},
				onDownloadFailed(install) {
					reject(_installError(install.error));
				},
				onInstallFailed(install) {
					reject(_installError(install.error));
				},
				onInstallCancelled() {
					reject(_error('cancelled', 'The installation was cancelled'));
				},
				onInstallEnded(install, addon) {
					resolve(addon);
				}
			});
			// The listener sees every outcome; a rejection here would only repeat it
			Promise.resolve(install.install()).catch(() => {});
		});
		
		// The index and the hash already pin the file, so this cannot happen
		// unless the marketplace itself is wrong -- and then the add-on goes
		if (addon.id != id) {
			await addon.uninstall();
			throw _error('wrong-id', `The marketplace's file for ${id} installed ${addon.id}`);
		}
		_notify('addons');
		return addon;
	};
	
	
	this.uninstall = async function (id) {
		let addon = await AddonManager.getAddonByID(id);
		if (addon) {
			await addon.uninstall();
			_notify('addons');
		}
	};
	
	
	this.setEnabled = async function (id, enabled) {
		let addon = await AddonManager.getAddonByID(id);
		if (addon) {
			await (enabled ? addon.enable() : addon.disable());
			_notify('addons');
		}
	};
	
	
	/**
	 * Every installed extension, with its listing when it is the marketplace's
	 * own copy of it. An add-on from elsewhere that only shares a listed id gets
	 * that listing as `conflict` instead: a different extension, which must
	 * neither describe nor replace it.
	 *
	 * @return {Promise<{ addon: Addon, extension: Object|null, conflict: Object|null }[]>}
	 */
	this.getInstalled = async function () {
		let index = await this.getIndex();
		let addons = await AddonManager.getAddonsByTypes(['extension']);
		return addons
			.filter(addon => !addon.hidden)
			.map((addon) => {
				let listing = (index && index.extensions.find(x => x.id == addon.id)) || null;
				let own = !!listing && _isListingOf(listing, addon);
				return { addon, extension: own ? listing : null, conflict: own ? null : listing };
			});
	};
	
	
	/**
	 * Opens the Extensions window, or brings it forward.
	 *
	 * @param {Object} [options]
	 * @param {String} [options.extensionID] - Show this extension's details
	 * @param {String} [options.view] - Show this view ('<pluginID>:<id>') instead
	 */
	this.openWindow = function ({ extensionID, view } = {}) {
		let win = Services.wm.getMostRecentWindow('zotero:paperly-extensions');
		if (win) {
			win.focus();
			if (view) {
				win.Zotero_Paperly_Extensions.showView(view);
			}
			else if (extensionID) {
				win.Zotero_Paperly_Extensions.select(extensionID);
			}
			return win;
		}
		let args = { extensionID, view };
		args.wrappedJSObject = args;
		return Services.ww.openWindow(
			null,
			'chrome://zotero/content/paperlyExtensions.xhtml',
			'_blank',
			'chrome,resizable,centerscreen,dialog=no',
			args
		);
	};
	
	
	/**
	 * Gives an extension a view of its own in the Extensions window, with a
	 * button in the window's activity bar -- a place for its interface that
	 * leaves Paperly's own untouched. The view goes when the extension stops.
	 *
	 * Registering the same pluginID and id again replaces the view.
	 *
	 * @param {Object} view
	 * @param {String} view.pluginID - The extension's id
	 * @param {String} view.id - Unique within the extension
	 * @param {String} view.label - The view's title, and the button's tooltip
	 * @param {String} [view.icon] - An image URL for the button, such as rootURI + 'icon.svg'
	 * @param {Function} view.onRender - ({ body, window }) => void, called once in each
	 *     Extensions window, the first time the view is shown there; `body` is an
	 *     empty HTML element for the view's content
	 * @param {Function} [view.onDestroy] - ({ body, window }) => void, called when that
	 *     window closes or the view is removed
	 * @return {Function} Removes the view
	 */
	this.registerView = function (view) {
		for (let name of ['pluginID', 'id', 'label']) {
			if (typeof view[name] != 'string' || !view[name]) {
				throw new Error(`registerView: '${name}' must be a non-empty string`);
			}
		}
		if (typeof view.onRender != 'function') {
			throw new Error("registerView: 'onRender' must be a function");
		}
		let key = `${view.pluginID}:${view.id}`;
		let entry = {
			key,
			pluginID: view.pluginID,
			id: view.id,
			label: view.label,
			icon: view.icon || null,
			onRender: view.onRender,
			onDestroy: view.onDestroy || null
		};
		_views.delete(key);
		_views.set(key, entry);
		_notify('views');
		return () => {
			if (_views.get(key) === entry) {
				_views.delete(key);
				_notify('views');
			}
		};
	};
	
	
	/**
	 * What the user is working on in the main window, for an extension's view to
	 * act on: the items selected in the library -- or, when a reader tab is in
	 * front, the item it shows -- and the text last selected in that reader.
	 *
	 * @return {{ items: Zotero.Item[], reader: null | {
	 *     attachment: Zotero.Item, selectedText: String, pageLabel: String|null } }}
	 */
	this.getContext = function () {
		let context = { items: [], reader: null };
		let win = Zotero.getMainWindow();
		if (!win || !win.Zotero_Tabs) {
			return context;
		}
		let tabs = win.Zotero_Tabs;
		if (tabs.selectedType == 'library') {
			context.items = win.ZoteroPane.getSelectedItems();
			return context;
		}
		let reader = Zotero.Reader.getByTabID(tabs.selectedID);
		let attachment = reader && Zotero.Items.get(reader.itemID);
		if (attachment) {
			context.items = [attachment.parentItem || attachment];
			let selection = _lastSelection && _lastSelection.tabID == reader.tabID ? _lastSelection : null;
			context.reader = {
				attachment,
				selectedText: selection ? selection.text : '',
				pageLabel: selection ? selection.pageLabel : null
			};
		}
		return context;
	};
	
	
	/**
	 * Every registered view, in the order they were added.
	 */
	this.getViews = function () {
		return [..._views.values()];
	};
	
	
	this._removeViewsOf = function (pluginID) {
		let removed = false;
		for (let [key, view] of _views) {
			if (view.pluginID == pluginID) {
				_views.delete(key);
				removed = true;
			}
		}
		if (removed) {
			_notify('views');
		}
	};
	
	
	/**
	 * @param {Function} listener - Called with 'index' when the index changes,
	 *     'addons' after an install, uninstall, enable or disable done here, and
	 *     'views' when a view is added or removed
	 */
	this.addListener = function (listener) {
		_listeners.add(listener);
	};
	
	
	this.removeListener = function (listener) {
		_listeners.delete(listener);
	};
	
	
	function _notify(what) {
		for (let listener of _listeners) {
			try {
				listener(what);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	}
	
	
	// Keeps the index's blocks where Zotero.Plugins looks for them, and has it
	// switch off what is newly blocked -- and back on what no longer is.
	async function _applyBlocked(blocked) {
		let json = JSON.stringify(blocked || {});
		if (json == (Zotero.Prefs.get('paperlyExtensions.blocked') || '{}')) {
			return;
		}
		Zotero.Prefs.set('paperlyExtensions.blocked', json);
		await Zotero.Plugins.applyBlockedPlugins();
	}
	
	
	// Why the add-on manager must not make an install over a marketplace
	// extension, or null if it may. Its own updates come from a file nobody
	// signed, so the signed index has to vouch for the version, and for the
	// file by its SHA-256; and as in the Extensions window, an update that uses
	// more than the installed version needs the user's confirmation.
	function _checkUpdate(install) {
		let existing = install.existingAddon;
		if (!existing || !_isFromMarketplace(existing) || _ownInstalls.has(install)) {
			return null;
		}
		if (!_index) {
			return 'the marketplace index is not loaded yet';
		}
		let extension = _index.extensions.find(x => x.id == existing.id);
		let version = install.addon && install.addon.version;
		let release = extension && extension.versions.find(v => v.version == version);
		if (!release) {
			return 'the marketplace does not list this version';
		}
		let hash;
		try {
			hash = _hashFile(install.file);
		}
		catch (e) {
			return `its file cannot be read: ${e}`;
		}
		if (hash != String(release.sha256).toLowerCase()) {
			return 'the file is not the one the marketplace lists';
		}
		let installed = extension.versions.find(v => v.version == existing.version);
		let usedBefore = (installed && installed.uses) || [];
		let newUses = (release.uses || []).filter(use => !usedBefore.includes(use));
		if (newUses.length) {
			return `it also uses ${newUses.join(', ')}, which the user has not agreed to`;
		}
		return null;
	}
	
	
	// The update URL the marketplace has every listed extension declare (as
	// updateURL() in scripts/lib/config.mjs there makes it), or null without a
	// marketplace
	function _getUpdateURL(id) {
		if (!Zotero.Prefs.get('paperlyExtensions.registryURL')) {
			return null;
		}
		let slug = String(id).replace(/[^A-Za-z0-9._@-]/g, '_');
		return `${Zotero.PaperlyExtensions.getRegistryURL()}updates/${slug}.json`;
	}
	
	
	// Whether an installed add-on takes its updates from the marketplace
	function _isFromMarketplace(addon) {
		let url = _getUpdateURL(addon.id);
		return !!url && addon.updateURL === url;
	}
	
	
	// Whether an installed add-on is the marketplace's copy of a listing: it takes
	// its updates from where the listing says. The id alone proves nothing --
	// anyone can list the id of a plugin they did not write.
	function _isListingOf(extension, addon) {
		let url = extension.updateURL;
		return !!Zotero.Prefs.get('paperlyExtensions.registryURL')
			&& typeof url == 'string'
			&& url.startsWith(Zotero.PaperlyExtensions.getRegistryURL())
			&& addon.updateURL === url;
	}


	async function _parseVerified(bytes, signature) {
		if (!await Zotero.PaperlyExtensions.verify(bytes, signature)) {
			throw _error('signature', 'The marketplace index is not signed with the key Paperly trusts');
		}
		let index;
		try {
			index = JSON.parse(new TextDecoder().decode(bytes));
		}
		catch {
			throw _error('format', 'The marketplace index cannot be read');
		}
		if (index.schema != 1 || !Array.isArray(index.extensions)) {
			throw _error('format', 'The marketplace index is in a format this Paperly does not read');
		}
		return index;
	}
	
	
	// Synchronous, as an install listener has to answer at once; the add-on
	// manager reads the file the same way to check its own hashes
	function _hashFile(file) {
		let hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
		hasher.init(Ci.nsICryptoHash.SHA256);
		let stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
		stream.init(file, -1, -1, 0);
		try {
			hasher.updateFromStream(stream, file.fileSize);
		}
		finally {
			stream.close();
		}
		return [...hasher.finish(false)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
	}
	
	
	function _getCacheDir() {
		return PathUtils.join(PathUtils.profileDir, CACHE_DIR_NAME);
	}
	
	
	// WebCrypto. Not every scope the xpcom files run in has it, but a system
	// sandbox always can (Zotero.Plugins gives plugins theirs the same way).
	function _getSandbox() {
		if (!_sandbox) {
			_sandbox = new Cu.Sandbox(
				Services.scriptSecurityManager.getSystemPrincipal(),
				{ wantGlobalProperties: ['atob', 'crypto'] }
			);
		}
		return _sandbox;
	}
	
	
	function _getSubtle() {
		if (typeof crypto != 'undefined' && crypto.subtle) {
			return crypto.subtle;
		}
		return _getSandbox().crypto.subtle;
	}
	
	
	function _fromBase64(text) {
		let decode = typeof atob == 'function' ? atob : _getSandbox().atob;
		return Uint8Array.from(decode(String(text).trim()), c => c.charCodeAt(0));
	}
	
	
	function _error(code, message) {
		let error = new Error(message);
		error.code = code;
		return error;
	}
	
	
	function _installError(code) {
		switch (code) {
			case AddonManager.ERROR_NETWORK_FAILURE:
				return _error('network', 'The download failed');
			case AddonManager.ERROR_INCORRECT_HASH:
				return _error('hash', 'The download did not match what the marketplace checked');
			case AddonManager.ERROR_CORRUPT_FILE:
				return _error('corrupt', 'The downloaded file is damaged');
			case AddonManager.ERROR_FILE_ACCESS:
				return _error('file-access', 'The extension could not be written to the profile');
			default:
				return _error('install', `The extension could not be installed (${code})`);
		}
	}
};


// Started once Zotero has loaded, and so without a line in zotero.js. On a
// reinit this file is loaded again and registers again.
Services.obs.addObserver({
	observe(subject, topic) {
		Services.obs.removeObserver(this, topic);
		try {
			Zotero.PaperlyExtensions.init();
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
}, 'zotero-loaded');
