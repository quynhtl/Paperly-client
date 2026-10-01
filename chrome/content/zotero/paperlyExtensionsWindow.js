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

// The Extensions window: browsing the marketplace, installing from it, and
// managing what is installed. The marketplace itself -- the signed index,
// installing, blocking -- is Zotero.PaperlyExtensions; this only shows it.

var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");

const HTML_NS = 'http://www.w3.org/1999/xhtml';
// Opening the window checks the marketplace again when the last check is older
const STALE_AFTER = 60 * 60 * 1000;
// What a listing can declare, in the order it is shown (see POLICY.md in
// paperly-extensions)
let DECLARATIONS = ['network', 'sendsContent', 'clipboard', 'files', 'cookies', 'passwords', 'programs'];
let ERRORS = {
	network: 'extensions-error-network',
	hash: 'extensions-error-hash',
	corrupt: 'extensions-error-corrupt',
	'file-access': 'extensions-error-file-access',
	incompatible: 'extensions-error-incompatible'
};

function h(tag, attributes, ...children) {
	let element = document.createElementNS(HTML_NS, tag);
	for (let [name, value] of Object.entries(attributes || {})) {
		if (value === null || value === undefined || value === false) {
			continue;
		}
		if (name == 'l10n') {
			document.l10n.setAttributes(element, value.id, value.args);
		}
		else if (name.startsWith('on')) {
			element.addEventListener(name.slice(2), value);
		}
		else {
			element.setAttribute(name, value === true ? '' : value);
		}
	}
	element.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
	return element;
}

// eslint-disable-next-line no-unused-vars
var Zotero_Paperly_Extensions = {
	_index: null,
	_installed: [],
	_selectedID: null,
	_query: '',
	// id -> { update, progress } while installing
	_busy: new Map(),
	// id -> l10n id of what went wrong last time
	_errors: new Map(),
	_status: null,
	// The view shown instead of the marketplace, by key, or null
	_activeView: null,
	// key -> { view, container, body } for each view shown in this window
	_viewParts: new Map(),
	
	async init() {
		this._list = document.getElementById('list');
		this._details = document.getElementById('details');
		this._search = document.getElementById('search');
		
		this._search.addEventListener('input', () => {
			this._query = this._search.value.trim().toLowerCase();
			this._renderList();
		});
		this._search.addEventListener('keydown', (event) => {
			if (event.key == 'ArrowDown') {
				event.preventDefault();
				this._list.focus();
				this._moveSelection(0);
			}
		});
		document.getElementById('refresh').addEventListener('click', () => this.refresh());
		this._list.addEventListener('keydown', event => this._onListKeyDown(event));
		document.getElementById('confirm').addEventListener('click', (event) => {
			if (event.target.id == 'confirm') {
				this._closeConfirm(false);
			}
		});
		document.getElementById('confirm-cancel').addEventListener('click', () => this._closeConfirm(false));
		document.getElementById('confirm-ok').addEventListener('click', () => this._closeConfirm(true));
		document.addEventListener('keydown', (event) => {
			if (event.key == 'Escape' && !document.getElementById('confirm').hidden) {
				event.preventDefault();
				this._closeConfirm(false);
			}
		});
		
		this._onServiceChange = (what) => {
			if (what == 'views') {
				this._renderActivityBar();
				this._renderDetails();
			}
			else {
				this.reload();
			}
		};
		Zotero.PaperlyExtensions.addListener(this._onServiceChange);
		document.getElementById('activity-manager').addEventListener('click', () => this.showManager());
		// Changes made anywhere, Tools -> Plugins included
		let reload = () => this.reload();
		this._addonListener = {
			onInstalled: reload,
			onUninstalled: reload,
			onEnabled: reload,
			onDisabled: reload,
			onPropertyChanged: reload
		};
		AddonManager.addAddonListener(this._addonListener);
		
		let args = window.arguments && window.arguments[0];
		args = args && args.wrappedJSObject;
		this._selectedID = (args && args.extensionID) || null;
		
		await this.reload();
		this._renderActivityBar();
		if (args && args.view) {
			this.showView(args.view);
		}
		let lastCheck = Zotero.Prefs.get('paperlyExtensions.lastCheck') * 1000;
		if (!Zotero.PaperlyExtensions.isConfigured()) {
			this._setStatus({ l10nID: 'extensions-status-not-configured' });
		}
		else if (!this._index || Date.now() - lastCheck > STALE_AFTER) {
			this.refresh();
		}
		else {
			this._setCheckedStatus();
		}
		this._search.focus();
	},
	
	
	destroy() {
		Zotero.PaperlyExtensions.removeListener(this._onServiceChange);
		AddonManager.removeAddonListener(this._addonListener);
		for (let key of [...this._viewParts.keys()]) {
			this._destroyView(key);
		}
	},
	
	
	/**
	 * Shows an extension's view ('<pluginID>:<id>') in place of the marketplace.
	 */
	showView(key) {
		let view = Zotero.PaperlyExtensions.getViews().find(v => v.key == key);
		if (!view) {
			return;
		}
		if (!this._viewParts.has(key)) {
			let body = h('div', { class: 'view-body' });
			let container = h('section', { class: 'view', 'data-view': key, hidden: true },
				h('header', { class: 'view-header' }, h('h1', {}, view.label)),
				body);
			document.getElementById('view-host').append(container);
			this._viewParts.set(key, { view, container, body });
			try {
				view.onRender({ body, window });
			}
			catch (e) {
				Zotero.logError(e);
				body.replaceChildren(h('p', { class: 'view-failed', l10n: { id: 'extensions-view-failed' } }));
			}
		}
		for (let [otherKey, parts] of this._viewParts) {
			parts.container.hidden = otherKey != key;
		}
		this._activeView = key;
		document.getElementById('manager').hidden = true;
		document.getElementById('view-host').hidden = false;
		this._renderActivityBar();
	},
	
	
	showManager() {
		this._activeView = null;
		document.getElementById('view-host').hidden = true;
		document.getElementById('manager').hidden = false;
		this._renderActivityBar();
	},
	
	
	_destroyView(key) {
		let parts = this._viewParts.get(key);
		if (!parts) {
			return;
		}
		this._viewParts.delete(key);
		try {
			if (parts.view.onDestroy) {
				parts.view.onDestroy({ body: parts.body, window });
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		parts.container.remove();
	},
	
	
	// One button per view, after the marketplace's. A view that has gone (its
	// extension stopped) is torn down here.
	_renderActivityBar() {
		let views = Zotero.PaperlyExtensions.getViews();
		let keys = new Set(views.map(view => view.key));
		for (let [key, parts] of [...this._viewParts]) {
			// Gone, or registered again with a new onRender
			if (!keys.has(key) || !views.some(view => view === parts.view)) {
				this._destroyView(key);
			}
		}
		if (this._activeView && !this._viewParts.has(this._activeView)) {
			if (keys.has(this._activeView)) {
				this.showView(this._activeView);
				return;
			}
			this.showManager();
			return;
		}
		
		document.getElementById('activity-manager').setAttribute('aria-selected', String(!this._activeView));
		document.getElementById('activity-views').replaceChildren(...views.map(view => h('button', {
			class: 'activity view-button',
			role: 'tab',
			title: view.label,
			'aria-label': view.label,
			'aria-selected': String(view.key == this._activeView),
			'data-view': view.key,
			onclick: () => this.showView(view.key)
		},
		view.icon
			? h('img', { src: view.icon, alt: '' })
			: h('span', { class: 'letter', 'aria-hidden': 'true' }, view.label.charAt(0).toUpperCase()))));
	},
	
	
	select(id) {
		this._selectedID = id;
		this._render();
	},
	
	
	async refresh() {
		if (!Zotero.PaperlyExtensions.isConfigured()) {
			this._setStatus({ l10nID: 'extensions-status-not-configured' });
			return;
		}
		this._setStatus({ l10nID: 'extensions-status-checking', busy: true });
		try {
			// Its listener reloads the window
			await Zotero.PaperlyExtensions.refresh();
			this._setCheckedStatus();
		}
		catch (e) {
			Zotero.debug(`Paperly extensions: ${e.message}`, 2);
			let l10nID = ['signature', 'stale', 'format'].includes(e.code)
				? 'extensions-status-untrusted'
				: 'extensions-status-unreachable';
			this._setStatus({ l10nID, retry: true });
		}
	},
	
	
	async reload() {
		this._index = await Zotero.PaperlyExtensions.getIndex();
		this._installed = await Zotero.PaperlyExtensions.getInstalled();
		this._render();
	},
	
	
	// Everything there is to show: what is installed, then what is not
	_getEntries() {
		let installed = this._installed
			.map(({ addon, extension }) => ({ id: addon.id, addon, extension }))
			.sort((a, b) => this._getName(a).localeCompare(this._getName(b)));
		let installedIDs = new Set(installed.map(entry => entry.id));
		let marketplace = ((this._index && this._index.extensions) || [])
			.filter(extension => !installedIDs.has(extension.id))
			.map(extension => ({ id: extension.id, addon: null, extension }));
		return { installed, marketplace };
	},
	
	
	_matches(entry) {
		if (!this._query) {
			return true;
		}
		let { addon, extension } = entry;
		let haystack = [
			entry.id,
			this._getName(entry),
			extension ? extension.description : addon.description,
			extension ? extension.publisher.name : (addon.creator && addon.creator.name),
			...(extension ? extension.categories : [])
		].join('\n').toLowerCase();
		return haystack.includes(this._query);
	},
	
	
	_getName(entry) {
		return entry.extension ? entry.extension.name : entry.addon.name;
	},
	
	
	_getUpdate(entry) {
		if (!entry.addon || !entry.extension) {
			return null;
		}
		let release = Zotero.PaperlyExtensions.getCompatibleVersion(entry.extension);
		return release && Services.vc.compare(release.version, entry.addon.version) > 0 ? release : null;
	},
	
	
	_getVisible() {
		let { installed, marketplace } = this._getEntries();
		return [...installed, ...marketplace].filter(entry => this._matches(entry));
	},
	
	
	_render() {
		let visible = this._getVisible();
		if (!visible.some(entry => entry.id == this._selectedID) && !this._query) {
			this._selectedID = visible.length ? visible[0].id : null;
		}
		this._renderList();
		this._renderDetails();
	},
	
	
	_renderList() {
		let { installed, marketplace } = this._getEntries();
		let hadFocus = document.activeElement == this._list;
		this._list.replaceChildren();
		
		let installedShown = installed.filter(entry => this._matches(entry));
		this._list.append(this._renderSectionHeader('extensions-section-installed', installedShown.length));
		if (installedShown.length) {
			this._list.append(...installedShown.map(entry => this._renderItem(entry)));
		}
		else if (!this._query) {
			this._list.append(h('p', { class: 'empty', l10n: { id: 'extensions-none-installed' } }));
		}
		
		let marketplaceShown = marketplace.filter(entry => this._matches(entry));
		this._list.append(this._renderSectionHeader('extensions-section-marketplace', marketplaceShown.length));
		if (marketplaceShown.length) {
			this._list.append(...marketplaceShown.map(entry => this._renderItem(entry)));
		}
		else if (!this._query && this._index) {
			this._list.append(h('p', { class: 'empty', l10n: { id: 'extensions-none-listed' } }));
		}
		
		if (this._query && !installedShown.length && !marketplaceShown.length) {
			this._list.append(h('p', {
				class: 'empty',
				l10n: { id: 'extensions-no-results', args: { query: this._search.value.trim() } }
			}));
		}
		
		let selected = this._list.querySelector('.item[aria-selected="true"]');
		if (selected) {
			this._list.setAttribute('aria-activedescendant', selected.id);
			if (hadFocus) {
				selected.scrollIntoView({ block: 'nearest' });
			}
		}
		else {
			this._list.removeAttribute('aria-activedescendant');
		}
	},
	
	
	_renderSectionHeader(l10nID, count) {
		return h('div', { class: 'section-header', role: 'presentation' },
			h('span', { l10n: { id: l10nID } }),
			h('span', { class: 'count' }, String(count)));
	},
	
	
	// The item's own Install or Update button is a shortcut for the mouse; from
	// the keyboard the same actions are in the details, so the list stays a
	// single tab stop
	_renderItem(entry) {
		let { addon, extension } = entry;
		let update = this._getUpdate(entry);
		let blockReason = addon && Zotero.PaperlyExtensions.getBlockReason(addon);
		let busy = this._busy.get(entry.id);
		let action = null;
		if (busy) {
			action = h('span', { class: 'item-busy', l10n: { id: busy.update ? 'extensions-updating' : 'extensions-installing' } });
		}
		else if (!addon && extension && Zotero.PaperlyExtensions.getCompatibleVersion(extension)) {
			action = h('button', {
				class: 'item-action primary',
				tabindex: '-1',
				l10n: { id: 'extensions-install' },
				onclick: (event) => {
					event.stopPropagation();
					this._install(entry);
				}
			});
		}
		else if (update && !blockReason) {
			action = h('button', {
				class: 'item-action',
				tabindex: '-1',
				l10n: { id: 'extensions-update' },
				onclick: (event) => {
					event.stopPropagation();
					this._install(entry, { update: true });
				}
			});
		}
		
		let item = h('div', {
			class: 'item',
			id: 'item-' + entry.id.replace(/[^A-Za-z0-9_-]/g, '_'),
			role: 'option',
			'aria-selected': String(entry.id == this._selectedID),
			'data-id': entry.id,
			'data-state': blockReason ? 'blocked' : (addon && !addon.isActive ? 'disabled' : null),
			onclick: () => this.select(entry.id)
		},
		this._renderIcon(entry, 'item-icon'),
		h('div', { class: 'item-text' },
			h('div', { class: 'item-title' },
				h('span', { class: 'item-name' }, this._getName(entry)),
				blockReason
					? h('span', { class: 'badge blocked', l10n: { id: 'extensions-badge-blocked' } })
					: (addon && !addon.isActive
						? h('span', { class: 'badge', l10n: { id: 'extensions-badge-disabled' } })
						: null)),
			h('div', { class: 'item-description' },
				extension ? extension.description : (addon.description || '')),
			h('div', { class: 'item-publisher' }, this._renderPublisher(entry, { short: true }))),
		action);
		return item;
	},
	
	
	_renderIcon(entry, className) {
		let name = this._getName(entry);
		let letter = h('span', { class: `${className} letter`, 'aria-hidden': 'true' }, name.charAt(0).toUpperCase());
		// A colour of its own, from its id
		let hue = [...entry.id].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 360, 7);
		letter.style.setProperty('--letter-hue', hue);
		let url = (entry.extension && entry.extension.icon) || (entry.addon && entry.addon.iconURL);
		if (!url) {
			return letter;
		}
		let image = h('img', { class: className, src: url, alt: '' });
		image.addEventListener('error', () => image.replaceWith(letter), { once: true });
		return image;
	},
	
	
	_renderPublisher(entry, { short = false } = {}) {
		let { extension, addon } = entry;
		if (!extension) {
			let creator = addon.creator && addon.creator.name;
			return creator ? h('span', { class: 'publisher-name' }, creator) : null;
		}
		let { publisher } = extension;
		let badge;
		if (publisher.official) {
			badge = h('span', { class: 'publisher-badge verified', l10n: { id: 'extensions-publisher-official' } });
		}
		else if (publisher.verified) {
			// The domain the publisher proved they control, where there is room for it
			badge = publisher.domain && !short
				? h('span', {
					class: 'publisher-badge verified',
					l10n: { id: 'extensions-publisher-verified-domain', args: { domain: publisher.domain } }
				})
				: h('span', { class: 'publisher-badge verified', l10n: { id: 'extensions-publisher-verified' } });
		}
		else if (!short) {
			badge = h('span', { class: 'publisher-badge', l10n: { id: 'extensions-publisher-unverified' } });
		}
		return [h('span', { class: 'publisher-name' }, publisher.name), badge];
	},
	
	
	_renderDetails() {
		let entry = this._getVisible().find(x => x.id == this._selectedID)
			|| [...this._getEntries().installed, ...this._getEntries().marketplace].find(x => x.id == this._selectedID);
		if (!entry) {
			this._details.replaceChildren(h('p', { class: 'placeholder', l10n: { id: 'extensions-pick-one' } }));
			return;
		}
		let { addon, extension } = entry;
		let blockReason = addon && Zotero.PaperlyExtensions.getBlockReason(addon);
		let compatible = extension && Zotero.PaperlyExtensions.getCompatibleVersion(extension);
		// The version the details describe: what is installed, if the
		// marketplace knows it, or what would be installed
		let release = (extension && addon && extension.versions.find(v => v.version == addon.version))
			|| compatible
			|| (extension && extension.versions[0]);
		let version = addon ? addon.version : (release && release.version);
		let license = extension && extension.license;
		
		let header = h('header', { class: 'details-header' },
			this._renderIcon(entry, 'details-icon'),
			h('div', { class: 'details-heading' },
				h('h2', {}, this._getName(entry)),
				h('div', { class: 'details-meta' },
					this._renderPublisher(entry),
					version ? h('span', { class: 'meta', l10n: { id: 'extensions-version', args: { version } } }) : null,
					license ? h('span', { class: 'meta', l10n: { id: 'extensions-license', args: { license } } }) : null),
				this._renderActions(entry, { compatible, blockReason })));
		
		let banners = [];
		let busy = this._busy.get(entry.id);
		if (busy) {
			banners.push(h('progress', { class: 'details-progress', max: '1', value: String(busy.progress || 0) }));
		}
		if (this._errors.has(entry.id)) {
			banners.push(h('p', { class: 'banner error', role: 'alert', l10n: { id: this._errors.get(entry.id) } }));
		}
		if (blockReason) {
			banners.push(h('p', { class: 'banner error', l10n: { id: 'extensions-blocked-banner', args: { reason: blockReason } } }));
		}
		if (addon && !extension) {
			banners.push(h('p', { class: 'banner warning', l10n: { id: 'extensions-not-from-marketplace' } }));
		}
		if (extension && !compatible) {
			banners.push(h('p', {
				class: 'banner warning',
				l10n: { id: 'extensions-incompatible', args: { version: Services.appinfo.version } }
			}));
		}
		
		let sections = [h('p', { class: 'description' }, extension ? extension.description : (addon.description || ''))];
		if (extension) {
			sections.push(this._renderDeclares(extension));
			if (release) {
				sections.push(this._renderChecks(extension, release));
			}
			sections.push(this._renderVersions(extension));
			sections.push(this._renderLinks(extension));
		}
		
		this._details.replaceChildren(header, ...banners, ...sections);
	},
	
	
	_renderActions(entry, { compatible, blockReason }) {
		let { addon } = entry;
		let busy = this._busy.get(entry.id);
		let buttons = [];
		if (busy) {
			buttons.push(h('button', { class: 'primary', disabled: true, l10n: { id: busy.update ? 'extensions-updating' : 'extensions-installing' } }));
		}
		else if (!addon) {
			buttons.push(h('button', {
				class: 'primary',
				disabled: !compatible,
				l10n: { id: 'extensions-install' },
				onclick: () => this._install(entry)
			}));
		}
		else {
			if (this._getUpdate(entry) && !blockReason) {
				buttons.push(h('button', {
					class: 'primary',
					l10n: { id: 'extensions-update' },
					onclick: () => this._install(entry, { update: true })
				}));
			}
			if (!blockReason) {
				let canEnable = addon.permissions & AddonManager.PERM_CAN_ENABLE;
				let canDisable = addon.permissions & AddonManager.PERM_CAN_DISABLE;
				if (addon.userDisabled && canEnable) {
					buttons.push(h('button', {
						l10n: { id: 'extensions-enable' },
						onclick: () => this._run(() => Zotero.PaperlyExtensions.setEnabled(addon.id, true))
					}));
				}
				else if (!addon.userDisabled && canDisable) {
					buttons.push(h('button', {
						l10n: { id: 'extensions-disable' },
						onclick: () => this._run(() => Zotero.PaperlyExtensions.setEnabled(addon.id, false))
					}));
				}
			}
			if (addon.isActive) {
				for (let view of Zotero.PaperlyExtensions.getViews().filter(v => v.pluginID == addon.id)) {
					buttons.push(h('button', {
						l10n: { id: 'extensions-open-view', args: { label: view.label } },
						onclick: () => this.showView(view.key)
					}));
				}
			}
			if (addon.permissions & AddonManager.PERM_CAN_UNINSTALL) {
				buttons.push(h('button', {
					l10n: { id: 'extensions-uninstall' },
					onclick: () => this._run(() => Zotero.PaperlyExtensions.uninstall(addon.id))
				}));
			}
		}
		return h('div', { class: 'details-actions' }, buttons);
	},
	
	
	_renderDeclares(extension) {
		let rows = this._describeUses(extension.declares);
		return h('section', {},
			h('h3', { l10n: { id: 'extensions-section-declares' } }),
			rows.length
				? h('ul', { class: 'uses' }, rows)
				: h('p', { class: 'muted', l10n: { id: 'extensions-declares-nothing' } }));
	},
	
	
	// A listing's declarations -- or a version's detected uses, which share
	// their keys -- as list items
	_describeUses(declares) {
		let rows = [];
		for (let key of DECLARATIONS) {
			if (key == 'network') {
				let hosts = declares.network || [];
				if (hosts.length) {
					rows.push(h('li', {
						'data-use': key,
						l10n: { id: 'extensions-declares-network', args: { hosts: hosts.join(', ') } }
					}));
				}
			}
			else if (declares[key]) {
				rows.push(h('li', { 'data-use': key, l10n: { id: `extensions-declares-${key}` } }));
			}
		}
		return rows;
	},
	
	
	_renderChecks(extension, release) {
		let findings = release.findings || [];
		return h('section', {},
			h('h3', { l10n: { id: 'extensions-section-checks' } }),
			findings.length
				? h('ul', { class: 'findings' },
					findings.map(finding => h('li', { 'data-level': finding.level }, finding.message)))
				: h('p', { class: 'muted', l10n: { id: 'extensions-checks-clean' } }),
			h('p', { class: 'caveat', l10n: { id: 'extensions-checks-caveat' } }));
	},
	
	
	_renderVersions(extension) {
		let format = new Intl.DateTimeFormat(Zotero.locale, { dateStyle: 'medium' });
		return h('section', {},
			h('h3', { l10n: { id: 'extensions-section-versions' } }),
			h('table', { class: 'versions' },
				h('tbody', {},
					extension.versions.map(v => h('tr', {},
						h('td', {}, v.version),
						h('td', {}, v.released ? format.format(new Date(v.released)) : ''),
						h('td', { l10n: { id: 'extensions-versions-runs-in', args: { min: v.minAppVersion, max: v.maxAppVersion } } }))))));
	},
	
	
	_renderLinks(extension) {
		let links = [
			['extensions-link-homepage', extension.homepage],
			['extensions-link-source', extension.repo && `https://github.com/${extension.repo}`],
			['extensions-link-privacy', extension.privacyPolicy]
		].filter(([, url]) => url);
		return h('nav', { class: 'links' },
			links.map(([l10nID, url]) => h('a', {
				href: url,
				l10n: { id: l10nID },
				onclick: (event) => {
					event.preventDefault();
					Zotero.launchURL(url);
				}
			})));
	},
	
	
	async _install(entry, { update = false } = {}) {
		let { extension, addon } = entry;
		let release = Zotero.PaperlyExtensions.getCompatibleVersion(extension);
		if (!release) {
			this._errors.set(entry.id, 'extensions-error-incompatible');
			this._render();
			return;
		}
		// A first install says what the extension does; an update only what
		// this version does that the installed one did not
		let installed = addon && extension.versions.find(v => v.version == addon.version);
		let newUses = installed ? (release.uses || []).filter(use => !(installed.uses || []).includes(use)) : [];
		if ((!update || newUses.length) && !await this._confirm(entry, release, { update, newUses })) {
			return;
		}
		
		this._busy.set(entry.id, { update, progress: 0 });
		this._errors.delete(entry.id);
		this._selectedID = entry.id;
		this._render();
		try {
			await Zotero.PaperlyExtensions.install(entry.id, {
				onProgress: (progress) => {
					this._busy.get(entry.id).progress = progress;
					let bar = this._details.querySelector('.details-progress');
					if (bar) {
						bar.value = progress;
					}
				}
			});
		}
		catch (e) {
			Zotero.debug(`Paperly extensions: ${e.message}`, 2);
			this._errors.set(entry.id, ERRORS[e.code] || 'extensions-error-other');
		}
		finally {
			this._busy.delete(entry.id);
			await this.reload();
		}
	},
	
	
	async _run(action) {
		try {
			await action();
		}
		catch (e) {
			Zotero.logError(e);
		}
		await this.reload();
	},
	
	
	_confirm(entry, release, { update, newUses }) {
		let name = this._getName(entry);
		let body = document.getElementById('confirm-body');
		body.replaceChildren();
		if (update) {
			body.append(
				h('p', { l10n: { id: 'extensions-confirm-new-uses' } }),
				h('ul', { class: 'uses' }, this._describeUses(Object.fromEntries(newUses.map(use => [use, true])))));
		}
		else {
			let declared = this._describeUses(entry.extension.declares);
			if (declared.length) {
				body.append(h('p', { l10n: { id: 'extensions-confirm-declares' } }), h('ul', { class: 'uses' }, declared));
			}
			let warnings = (release.findings || []).filter(f => f.level == 'warning');
			if (warnings.length) {
				body.append(
					h('p', { l10n: { id: 'extensions-confirm-warnings' } }),
					h('ul', { class: 'findings' }, warnings.map(f => h('li', { 'data-level': f.level }, f.message))));
			}
			body.append(h('p', { class: 'publisher' }, this._renderPublisher(entry)));
		}
		body.append(h('p', { class: 'caveat', l10n: { id: 'extensions-confirm-trust' } }));
		
		document.l10n.setAttributes(
			document.getElementById('confirm-title'),
			update ? 'extensions-confirm-update' : 'extensions-confirm-install',
			{ name }
		);
		document.l10n.setAttributes(
			document.getElementById('confirm-ok'),
			update ? 'extensions-update' : 'extensions-install'
		);
		let dialog = document.getElementById('confirm');
		dialog.hidden = false;
		document.getElementById('confirm-ok').focus();
		return new Promise((resolve) => {
			this._confirmResolve = resolve;
		});
	},
	
	
	_closeConfirm(ok) {
		document.getElementById('confirm').hidden = true;
		if (this._confirmResolve) {
			this._confirmResolve(ok);
			this._confirmResolve = null;
		}
	},
	
	
	_onListKeyDown(event) {
		switch (event.key) {
			case 'ArrowDown':
				this._moveSelection(1);
				break;
			case 'ArrowUp':
				this._moveSelection(-1);
				break;
			case 'Home':
				this._moveSelection(-Infinity);
				break;
			case 'End':
				this._moveSelection(Infinity);
				break;
			default:
				return;
		}
		event.preventDefault();
	},
	
	
	_moveSelection(delta) {
		let visible = this._getVisible();
		if (!visible.length) {
			return;
		}
		let index = visible.findIndex(entry => entry.id == this._selectedID);
		let next = Math.min(visible.length - 1, Math.max(0, index + delta));
		this.select(visible[next].id);
	},
	
	
	_setCheckedStatus() {
		let seconds = Zotero.Prefs.get('paperlyExtensions.lastCheck');
		if (!seconds) {
			this._setStatus(null);
			return;
		}
		let time = new Intl.DateTimeFormat(Zotero.locale, { dateStyle: 'medium', timeStyle: 'short' })
			.format(new Date(seconds * 1000));
		this._setStatus({ l10nID: 'extensions-status-checked', args: { time } });
	},
	
	
	_setStatus(status) {
		let node = document.getElementById('status');
		node.replaceChildren();
		node.toggleAttribute('data-busy', !!(status && status.busy));
		document.getElementById('refresh').disabled = !!(status && status.busy);
		if (!status) {
			return;
		}
		node.append(h('span', { l10n: { id: status.l10nID, args: status.args } }));
		if (status.retry) {
			node.append(' ', h('button', {
				class: 'link',
				l10n: { id: 'extensions-status-retry' },
				onclick: () => this.refresh()
			}));
		}
	}
};
