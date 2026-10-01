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

// The first-run theme picker. A choice takes effect the moment it is clicked:
// this window shows it at once, the library behind it once the picker closes
// (macOS doesn't repaint a window under a modal one). Only Continue keeps it: Skip, Escape or closing the window put back what
// was there before -- on a first run, the default, Dark.

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SCHEME_PREF = 'browser.theme.toolbar-theme';
const DARK_THEME_PREF = 'extensions.zotero.darkTheme';

// Each theme is a colour scheme (0 dark, 1 light) and, for dark, which palette
let THEMES = {
	dark: { scheme: 0, darkTheme: 'paperly', mocks: ['dark'] },
	light: { scheme: 1, darkTheme: 'paperly', mocks: ['light'] },
	'zotero-dark': { scheme: 0, darkTheme: 'zotero', mocks: ['zotero-dark'] },
};

// eslint-disable-next-line no-unused-vars
var Zotero_Theme_Picker = {
	_confirmed: false,
	
	// What the user had set before the picker opened, null where it was the default
	_previous: null,
	
	init() {
		this._previous = {
			[SCHEME_PREF]: this._getUserValue(SCHEME_PREF),
			[DARK_THEME_PREF]: this._getUserValue(DARK_THEME_PREF),
		};
		
		this._radios = [...document.querySelectorAll('.theme')];
		for (let radio of this._radios) {
			let preview = radio.querySelector('.preview');
			for (let mock of THEMES[radio.dataset.theme].mocks) {
				preview.append(this._buildMock(mock));
			}
			radio.addEventListener('click', () => this._select(radio, true));
			radio.addEventListener('keydown', (event) => {
				if (event.key == ' ') {
					this._select(radio, true);
					event.preventDefault();
				}
			});
		}
		document.getElementById('theme-picker-themes')
			.addEventListener('keydown', event => this._handleArrowKeys(event));
		document.getElementById('theme-picker-skip')
			.addEventListener('click', () => window.close());
		document.getElementById('theme-picker-continue')
			.addEventListener('click', () => {
				this._confirmed = true;
				window.close();
			});
		window.addEventListener('keydown', (event) => {
			if (event.key == 'Escape') {
				window.close();
			}
		});
		window.addEventListener('unload', () => {
			if (!this._confirmed) {
				this._restore();
			}
		});
		
		let radio = this._radios.find(r => r.dataset.theme == this._currentTheme());
		this._select(radio, false);
		radio.focus();
	},
	
	_currentTheme() {
		if (Zotero.Prefs.get(SCHEME_PREF, true) == 1) {
			return 'light';
		}
		return Zotero.Prefs.get(DARK_THEME_PREF, true) == 'zotero' ? 'zotero-dark' : 'dark';
	},
	
	_getUserValue(pref) {
		return Services.prefs.prefHasUserValue(pref) ? Zotero.Prefs.get(pref, true) : null;
	},
	
	_restore() {
		for (let [pref, value] of Object.entries(this._previous)) {
			if (value === null) {
				Zotero.Prefs.clear(pref, true);
			}
			else {
				Zotero.Prefs.set(pref, value, true);
			}
		}
	},
	
	_select(radio, apply) {
		for (let r of this._radios) {
			let checked = r === radio;
			r.setAttribute('aria-checked', checked);
			r.tabIndex = checked ? 0 : -1;
		}
		if (!apply) {
			return;
		}
		let { scheme, darkTheme } = THEMES[radio.dataset.theme];
		// Palette first, so a switch between the two darks doesn't flash
		if (darkTheme == 'paperly') {
			Zotero.Prefs.clear(DARK_THEME_PREF, true);
		}
		else {
			Zotero.Prefs.set(DARK_THEME_PREF, darkTheme, true);
		}
		Zotero.Prefs.set(SCHEME_PREF, scheme, true);
	},
	
	_handleArrowKeys(event) {
		let step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
		if (!step) {
			return;
		}
		if (Zotero.rtl && (event.key == 'ArrowLeft' || event.key == 'ArrowRight')) {
			step = -step;
		}
		let index = this._radios.indexOf(document.activeElement);
		let next = this._radios[(index + step + this._radios.length) % this._radios.length];
		this._select(next, true);
		next.focus();
		event.preventDefault();
	},
	
	// A thumbnail of the main window in the given palette: title bar, collections,
	// items with one selected, item pane. Its colours come from the class, not the
	// live theme, so each card always shows its own.
	_buildMock(palette) {
		let el = (className, ...children) => {
			let node = document.createElementNS(HTML_NS, 'div');
			node.className = className;
			node.append(...children);
			return node;
		};
		let lines = (count, selected) => Array.from(
			{ length: count },
			(_, i) => el(i === selected ? 'line selected' : 'line')
		);
		return el(`mock ${palette}`,
			el('mock-titlebar', el('dot'), el('dot'), el('dot')),
			el('mock-body',
				el('mock-collections', ...lines(5, 1)),
				el('mock-items', ...lines(7, 2)),
				el('mock-item-pane', ...lines(4))
			)
		);
	},
};
