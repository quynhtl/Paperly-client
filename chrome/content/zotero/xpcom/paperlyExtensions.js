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
// included -- can change what is offered. Every install then names the
// SHA-256 the index gives for the file, and the add-on manager refuses a
// download that does not match it.

Zotero.PaperlyExtensions = new function () {
	const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
	// Long enough after startup not to compete with it
	const FIRST_CHECK_DELAY = 60 * 1000;
	const CHECK_TICK = 60 * 60 * 1000;
	const CACHE_DIR_NAME = 'paperly-extensions';
	const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
	const SIGNATURE_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };
	
	var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	
	var _index = null;
	var _listeners = new Set();
	var _checkTimer = null;
	var _sandbox = null;
	
	
	this.init = function () {
		Zotero.addShutdownListener(() => clearTimeout(_checkTimer));
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
	 * What the marketplace blocks, in the format of Zotero.Plugins' own list of
	 * blocked plugins, as of the last index that verified. Zotero.Plugins reads
	 * it at startup, before any plugin runs, and synchronously -- hence a pref
	 * rather than the kept index.
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
						reason: entry.reason
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
	 * Why an installed add-on is switched off by a block, or null.
	 */
	this.getBlockReason = function (addon) {
		if (addon.blocklistState != Ci.nsIBlocklistService.STATE_BLOCKED) {
			return null;
		}
		let entry = this.getBlockedPlugins()[addon.id];
		return entry ? entry.reason : null;
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
	 * Every installed extension, with its listing when the marketplace has one.
	 *
	 * @return {Promise<{ addon: Addon, extension: Object|null }[]>}
	 */
	this.getInstalled = async function () {
		let index = await this.getIndex();
		let addons = await AddonManager.getAddonsByTypes(['extension']);
		return addons
			.filter(addon => !addon.hidden)
			.map(addon => ({
				addon,
				extension: (index && index.extensions.find(x => x.id == addon.id)) || null
			}));
	};
	
	
	/**
	 * @param {Function} listener - Called with 'index' when the index changes and
	 *     'addons' after an install, uninstall, enable or disable done here
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
