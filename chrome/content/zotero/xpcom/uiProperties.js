/*
	***** BEGIN LICENSE BLOCK *****
	
	Copyright © 2023 Corporation for Digital Scholarship
					 Vienna, Virginia, USA
					 https://www.zotero.org
	
	This file is part of Zotero.
	
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

Zotero.UIProperties = new (class {
	_roots = new Set();
	
	// Paperly's own dark palette is the default; the darkTheme pref can bring back
	// Zotero's. The choice is an attribute on the root of every Paperly document
	// -- windows, dialogs and the reader's frames -- which the stylesheets key on.
	_darkThemeDocs = new Set();
	
	constructor() {
		Services.obs.addObserver(doc => this._registerDarkThemeDoc(doc), 'document-element-inserted');
		for (let win of Services.wm.getEnumerator(null)) {
			this._registerDarkThemeDoc(win.document);
		}
	}
	
	registerRoot(root) {
		if (root.nodeType !== Node.ELEMENT_NODE) {
			throw new Error('Root must be an element');
		}
		
		this._roots.add(new WeakRef(root));
		this.set(root);
	}
	
	setAll() {
		for (let rootRef of this._roots) {
			let root = rootRef.deref();
			if (!root) {
				this._roots.delete(rootRef);
				continue;
			}
			this.set(root);
		}
	}
	
	set(root) {
		this._setFontSize(root);
		this._setUIDensity(root);
		root.dispatchEvent(new Event('UIPropertiesChanged', { bubbles: false }));
	}
	
	_setFontSize(root) {
		let size = Zotero.Prefs.get('fontSize');
		let sizeCSS = size + 'rem';
		root.style.fontSize = sizeCSS;
		root.style.setProperty('--zotero-font-size', sizeCSS);
		if (size <= 1) {
			size = 'small';
		}
		else if (size <= 1.15) {
			size = 'medium';
		}
		else if (size <= 1.3) {
			size = 'large';
		}
		else {
			size = 'x-large';
		}
		// Custom attribute -- allows for additional customizations in zotero.css
		root.setAttribute('zoteroFontSize', size);
		if (Zotero.rtl) {
			root.setAttribute('dir', 'rtl');
		}
		else {
			root.removeAttribute('dir');
		}
	}
	
	setDarkThemeAll() {
		for (let docRef of this._darkThemeDocs) {
			let doc = docRef.deref();
			if (!doc) {
				this._darkThemeDocs.delete(docRef);
				continue;
			}
			this._setDarkTheme(doc);
		}
	}
	
	_registerDarkThemeDoc(doc) {
		let url = doc.documentURI;
		if (!url.startsWith('chrome://') && !url.startsWith('resource://zotero/')
				|| doc.contentType.startsWith('image/')) {
			return;
		}
		this._darkThemeDocs.add(new WeakRef(doc));
		this._setDarkTheme(doc);
	}
	
	_setDarkTheme(doc) {
		let root = doc.documentElement;
		if (!root) {
			return;
		}
		if (Zotero.Prefs.get('darkTheme') == 'zotero') {
			root.setAttribute('data-dark-theme', 'zotero');
		}
		else {
			root.removeAttribute('data-dark-theme');
		}
	}
	
	_setUIDensity(root) {
		let density = Zotero.Prefs.get('uiDensity');
		root.style.setProperty('--zotero-ui-density', density);
		root.setAttribute('zoteroUIDensity', density);
	}
});
