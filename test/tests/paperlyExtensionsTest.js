"use strict";

describe("Zotero.PaperlyExtensions", function () {
	var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	
	const ID = 'paperly-extensions-test@paperly.org';
	
	var httpd, baseURL, keys, dir, checkUpdateSecurity;
	var xpiCount = 0;
	
	function toBase64(buffer) {
		return btoa(String.fromCharCode(...new Uint8Array(buffer)));
	}
	
	async function sha256(path) {
		let digest = await crypto.subtle.digest('SHA-256', await IOUtils.read(path));
		return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
	}
	
	// Where the marketplace has every listed extension take its updates from
	function marketplaceUpdateURL() {
		return `${baseURL}updates/${ID}.json`;
	}
	
	// Writes an .xpi that records in Zotero.PaperlyExtensionsTest which version
	// of it is running -- and, with withView, gives itself a view -- and serves
	// it at files/<name>. It takes its updates from the marketplace unless
	// updateURL says otherwise.
	async function makeExtension(version, { withView = false, id = ID, updateURL = marketplaceUpdateURL() } = {}) {
		let name = `test-${version}-${++xpiCount}.xpi`;
		let path = PathUtils.join(dir, name);
		/* eslint-disable camelcase */
		let files = {
			'manifest.json': JSON.stringify({
				manifest_version: 2,
				name: 'Paperly Extensions Test',
				version,
				applications: {
					zotero: {
						id,
						// Plain HTTP from the test server, which before() lets
						// the add-on manager accept
						update_url: updateURL,
						strict_min_version: '6.999',
						strict_max_version: '*'
					}
				}
			}),
			'bootstrap.js': 'function startup({ id, version }) {\n'
				+ '  Zotero.PaperlyExtensionsTest = version;\n'
				+ (withView
					? '  Zotero.PaperlyExtensions.registerView({ pluginID: id, id: "main", label: "Test view",\n'
						+ '    onRender({ body }) { body.textContent = "Hello from " + version; },\n'
						+ '    onDestroy() { Zotero.PaperlyExtensionsTestViewDestroyed = true; } });\n'
					: '')
				+ '}\n'
				+ 'function shutdown() { delete Zotero.PaperlyExtensionsTest; }\n'
				+ 'function install() {}\nfunction uninstall() {}\n'
		};
		/* eslint-enable camelcase */
		let zipWriter = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
		// PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE
		zipWriter.open(Zotero.File.pathToFile(path), 0x04 | 0x08 | 0x20);
		for (let [entry, text] of Object.entries(files)) {
			let stream = Cc["@mozilla.org/io/string-input-stream;1"]
				.createInstance(Ci.nsIStringInputStream);
			stream.setUTF8Data(text);
			zipWriter.addEntryStream(entry, Date.now() * 1000, Ci.nsIZipWriter.COMPRESSION_DEFAULT, stream, false);
		}
		zipWriter.close();
		httpd.registerFile('/files/' + name, Zotero.File.pathToFile(path));
		return {
			version,
			url: baseURL + 'files/' + name,
			sha256: await sha256(path),
			minAppVersion: '6.999',
			maxAppVersion: '*'
		};
	}
	
	function makeIndex(versions, { generated = new Date(), blocked = {}, publisher, declares = {} } = {}) {
		return {
			schema: 1,
			generated: generated.toISOString(),
			baseURL,
			appVersion: Services.appinfo.version,
			extensions: [{
				id: ID,
				name: 'Paperly Extensions Test',
				description: 'Tells the tests which version is running.',
				publisher: publisher || { name: 'Paperly', github: 'paperly', official: true, verified: true },
				repo: 'paperly/test',
				homepage: null,
				license: 'MIT',
				privacyPolicy: null,
				categories: [],
				icon: null,
				declares,
				updateURL: marketplaceUpdateURL(),
				versions: versions.map(v => ({ size: 0, released: null, uses: [], hosts: [], findings: [], ...v }))
			}],
			blocked
		};
	}
	
	// Serves an index, signed -- or, with `signFor`, signed for other bytes
	async function publish(index, { signFor } = {}) {
		let bytes = new TextEncoder().encode(JSON.stringify(index));
		let signed = signFor ? new TextEncoder().encode(signFor) : bytes;
		let signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed);
		let name = Zotero.Utilities.randomString();
		await IOUtils.write(PathUtils.join(dir, name + '.json'), bytes);
		await IOUtils.writeUTF8(PathUtils.join(dir, name + '.sig'), toBase64(signature));
		httpd.registerFile('/index.json', Zotero.File.pathToFile(PathUtils.join(dir, name + '.json')));
		httpd.registerFile('/index.json.sig', Zotero.File.pathToFile(PathUtils.join(dir, name + '.sig')));
	}
	
	// Installs a release the way anything but the marketplace would -- a file
	// from elsewhere, or the add-on manager's own update -- and says how it ended.
	// With fromFile, from the file on the disk, as Install Plugin From File does.
	async function installDirectly(release, { fromFile = false } = {}) {
		let install = fromFile
			? await AddonManager.getInstallForFile(Zotero.File.pathToFile(PathUtils.join(dir, release.url.split('/').pop())))
			: await AddonManager.getInstallForURL(release.url, { hash: 'sha256:' + release.sha256 });
		return new Promise((resolve) => {
			install.addListener({
				onInstallEnded: () => resolve('installed'),
				onInstallCancelled: () => resolve('cancelled'),
				onInstallFailed: () => resolve('failed'),
				onDownloadFailed: () => resolve('failed')
			});
			Promise.resolve(install.install()).catch(() => {});
		});
	}
	
	async function waitForVersion(version) {
		for (let i = 0; i < 100 && Zotero.PaperlyExtensionsTest !== version; i++) {
			await Zotero.Promise.delay(50);
		}
		assert.equal(Zotero.PaperlyExtensionsTest, version);
	}
	
	var publicKey;
	
	before(async function () {
		({ httpd, baseURL } = await startHTTPServer());
		dir = await getTempDirectory();
		keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
		publicKey = toBase64(await crypto.subtle.exportKey('spki', keys.publicKey));
		// The add-on manager disables an add-on whose updates would come over
		// plain HTTP, as the test server's do
		checkUpdateSecurity = AddonManager.checkUpdateSecurity;
		AddonManager.checkUpdateSecurity = false;
	});
	
	// The runner clears every pref after each test
	beforeEach(function () {
		Zotero.Prefs.set('paperlyExtensions.registryURL', baseURL);
		Zotero.Prefs.set('paperlyExtensions.publicKey', publicKey);
	});
	
	afterEach(async function () {
		let addon = await AddonManager.getAddonByID(ID);
		if (addon) {
			await addon.uninstall();
		}
	});
	
	after(async function () {
		AddonManager.checkUpdateSecurity = checkUpdateSecurity;
		await new Promise(resolve => httpd.stop(resolve));
		await IOUtils.remove(PathUtils.join(PathUtils.profileDir, 'paperly-extensions'), { recursive: true });
	});
	
	describe("#refresh()", function () {
		it("should keep an index that verifies", async function () {
			let index = makeIndex([await makeExtension('1.0')]);
			await publish(index);
			let fetched = await Zotero.PaperlyExtensions.refresh();
			assert.equal(fetched.generated, index.generated);
			assert.equal((await Zotero.PaperlyExtensions.getIndex()).generated, index.generated);
			assert.isTrue(await IOUtils.exists(
				PathUtils.join(PathUtils.profileDir, 'paperly-extensions', 'index.json')
			));
			assert.isAbove(Zotero.Prefs.get('paperlyExtensions.lastCheck'), 0);
			assert.equal(Zotero.Prefs.get('paperlyExtensions.lastGenerated'), index.generated);
		});
		
		it("should refuse an index whose signature does not match", async function () {
			let kept = await Zotero.PaperlyExtensions.getIndex();
			let index = makeIndex([await makeExtension('1.0')]);
			await publish(index, { signFor: 'something else' });
			let error = await getPromiseError(Zotero.PaperlyExtensions.refresh());
			assert.equal(error.code, 'signature');
			assert.equal((await Zotero.PaperlyExtensions.getIndex()).generated, kept.generated);
		});
		
		it("should refuse an index signed with another key", async function () {
			let other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
			let bytes = new TextEncoder().encode(JSON.stringify(makeIndex([])));
			let signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, other.privateKey, bytes);
			assert.isFalse(await Zotero.PaperlyExtensions.verify(bytes, toBase64(signature)));
		});
		
		it("should refuse an older index than the one already seen", async function () {
			await publish(makeIndex([]));
			await Zotero.PaperlyExtensions.refresh();
			await publish(makeIndex([], { generated: new Date(Date.now() - 60 * 60 * 1000) }));
			let error = await getPromiseError(Zotero.PaperlyExtensions.refresh());
			assert.equal(error.code, 'stale');
		});
		
		it("should refuse an older index than the newest accepted, with no copy kept", async function () {
			let index = makeIndex([]);
			await publish(index);
			// A newer one was accepted, and its copy has since gone
			Zotero.Prefs.set('paperlyExtensions.lastGenerated', new Date(Date.parse(index.generated) + 1000).toISOString());
			await IOUtils.remove(PathUtils.join(PathUtils.profileDir, 'paperly-extensions'), { recursive: true });
			let error = await getPromiseError(Zotero.PaperlyExtensions.refresh());
			assert.equal(error.code, 'stale');
		});
		
		it("should refuse an index generated more than a week ago, with none seen before", async function () {
			const DAY = 24 * 60 * 60 * 1000;
			assert.notOk(Zotero.Prefs.get('paperlyExtensions.lastGenerated'));
			await publish(makeIndex([], { generated: new Date(Date.now() - 8 * DAY) }));
			let error = await getPromiseError(Zotero.PaperlyExtensions.refresh());
			assert.equal(error.code, 'stale');
			// Some days late is an outage, or a clock out, and still believed
			let late = makeIndex([], { generated: new Date(Date.now() - 6 * DAY) });
			await publish(late);
			assert.equal((await Zotero.PaperlyExtensions.refresh()).generated, late.generated);
		});
	});
	
	describe("#getCompatibleVersion()", function () {
		it("should pick the newest version this Paperly runs", function () {
			let extension = {
				versions: [
					{ version: '3.0', minAppVersion: '999.0', maxAppVersion: '999.*' },
					{ version: '2.0', minAppVersion: '6.999', maxAppVersion: '*' },
					{ version: '1.0', minAppVersion: '6.999', maxAppVersion: '*' }
				]
			};
			assert.equal(Zotero.PaperlyExtensions.getCompatibleVersion(extension).version, '2.0');
			extension.versions.splice(1);
			assert.isNull(Zotero.PaperlyExtensions.getCompatibleVersion(extension));
		});
	});
	
	describe("#install()", function () {
		it("should install the newest version and start it", async function () {
			await publish(makeIndex([await makeExtension('2.0'), await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			let progress = [];
			let addon = await Zotero.PaperlyExtensions.install(ID, { onProgress: p => progress.push(p) });
			assert.equal(addon.id, ID);
			assert.equal(addon.version, '2.0');
			await waitForVersion('2.0');
			
			let installed = await Zotero.PaperlyExtensions.getInstalled();
			let entry = installed.find(x => x.addon.id == ID);
			assert.equal(entry.extension.name, 'Paperly Extensions Test');
		});
		
		it("should update an installed extension", async function () {
			await publish(makeIndex([await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			
			await publish(makeIndex([await makeExtension('1.1'), await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			let addon = await Zotero.PaperlyExtensions.install(ID);
			assert.equal(addon.version, '1.1');
			await waitForVersion('1.1');
		});
		
		it("should refuse a download that does not match the index", async function () {
			let release = await makeExtension('1.0');
			release.sha256 = '0'.repeat(64);
			await publish(makeIndex([release]));
			await Zotero.PaperlyExtensions.refresh();
			let error = await getPromiseError(Zotero.PaperlyExtensions.install(ID));
			assert.equal(error.code, 'hash');
			assert.isNull(await AddonManager.getAddonByID(ID));
		});
		
		it("should refuse an extension that is not listed", async function () {
			let error = await getPromiseError(Zotero.PaperlyExtensions.install('nobody@example.com'));
			assert.equal(error.code, 'not-listed');
		});
		
		it("should leave alone an extension from elsewhere that has a listed id", async function () {
			let elsewhere = await makeExtension('1.0', { updateURL: 'https://elsewhere.test/updates.json' });
			assert.equal(await installDirectly(elsewhere), 'installed');
			await waitForVersion('1.0');
			await publish(makeIndex([await makeExtension('2.0')]));
			await Zotero.PaperlyExtensions.refresh();
			
			let entry = (await Zotero.PaperlyExtensions.getInstalled()).find(x => x.addon.id == ID);
			assert.isNull(entry.extension);
			assert.equal(entry.conflict.id, ID);
			let error = await getPromiseError(Zotero.PaperlyExtensions.install(ID));
			assert.equal(error.code, 'id-conflict');
			assert.equal((await AddonManager.getAddonByID(ID)).version, '1.0');
		});
	});
	
	describe("updates the add-on manager makes by itself", function () {
		// 1.0, installed from the marketplace
		async function installFirst() {
			let first = await makeExtension('1.0');
			await publish(makeIndex([first]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			return first;
		}
		
		it("should refuse one whose file the index does not list", async function () {
			let first = await installFirst();
			let update = await makeExtension('1.1');
			await publish(makeIndex([{ ...update, sha256: '0'.repeat(64) }, first]));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'cancelled');
			assert.equal((await AddonManager.getAddonByID(ID)).version, '1.0');
		});
		
		it("should allow one the index lists", async function () {
			let first = await installFirst();
			let update = await makeExtension('1.1');
			await publish(makeIndex([update, first]));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'installed');
			await waitForVersion('1.1');
		});
		
		it("should refuse one from another publisher than the installed version's", async function () {
			let first = await installFirst();
			let update = await makeExtension('1.1');
			let publisher = { name: 'Someone else', github: 'someone-else', official: false, verified: false };
			await publish(makeIndex([update, first], { publisher }));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'cancelled');
			assert.equal((await AddonManager.getAddonByID(ID)).version, '1.0');
			let entry = (await Zotero.PaperlyExtensions.getInstalled()).find(x => x.addon.id == ID);
			assert.equal(entry.previousPublisher, 'paperly');
		});
		
		it("should refuse one that uses more than the installed version", async function () {
			let first = await installFirst();
			let update = await makeExtension('1.1');
			await publish(makeIndex([{ ...update, uses: ['passwords'] }, first]));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'cancelled');
			assert.equal((await AddonManager.getAddonByID(ID)).version, '1.0');
		});
		
		it("should leave to the user a file installed by hand", async function () {
			await installFirst();
			// A developer's own build, which the marketplace has never seen
			let build = await makeExtension('1.1.1');
			assert.equal(await installDirectly(build, { fromFile: true }), 'installed');
			await waitForVersion('1.1.1');
		});
		
		it("should judge one by what was installed once the index drops the installed version", async function () {
			let first = await makeExtension('1.0');
			await publish(makeIndex([{ ...first, uses: ['files'] }]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			// 1.0 is blocked, and so gone from the index; 1.1 is the fix
			let blocked = { [ID]: { versionRanges: [{ maxVersion: '1.0' }], reason: 'Leaks.' } };
			let fix = await makeExtension('1.1');
			await publish(makeIndex([{ ...fix, uses: ['files', 'passwords'] }], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			await waitForVersion(undefined);
			assert.equal(await installDirectly(fix), 'cancelled');
			
			await publish(makeIndex([{ ...fix, uses: ['files'] }], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(fix), 'installed');
			await waitForVersion('1.1');
			assert.isTrue((await AddonManager.getAddonByID(ID)).isActive);
		});
		
		it("should judge one over a version not installed from here by what the listing declares", async function () {
			// As the extension shipped with Paperly is
			assert.equal(await installDirectly(await makeExtension('1.0')), 'installed');
			await waitForVersion('1.0');
			let update = await makeExtension('1.1');
			await publish(makeIndex([{ ...update, uses: ['files'] }]));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'cancelled');
			
			await publish(makeIndex([{ ...update, uses: ['files'] }], { declares: { files: true } }));
			await Zotero.PaperlyExtensions.refresh();
			assert.equal(await installDirectly(update), 'installed');
			await waitForVersion('1.1');
		});
	});
	
	describe("blocking", function () {
		it("should switch a blocked extension off, and on again when the block is lifted", async function () {
			let release = await makeExtension('1.0.0');
			await publish(makeIndex([release]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0.0');
			
			let blocked = { [ID]: { versionRanges: ['*'], reason: 'Sends the library somewhere undisclosed.' } };
			await publish(makeIndex([release], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			await waitForVersion(undefined);
			let addon = await AddonManager.getAddonByID(ID);
			assert.isFalse(addon.isActive);
			assert.equal(Zotero.PaperlyExtensions.getBlockReason(addon), 'Sends the library somewhere undisclosed.');
			
			// Nor can it be switched back on by hand
			try {
				await addon.enable();
			}
			catch {}
			assert.isFalse((await AddonManager.getAddonByID(ID)).isActive);
			
			await publish(makeIndex([release]));
			await Zotero.PaperlyExtensions.refresh();
			await waitForVersion('1.0.0');
			addon = await AddonManager.getAddonByID(ID);
			assert.isTrue(addon.isActive);
			assert.isNull(Zotero.PaperlyExtensions.getBlockReason(addon));
		});
		
		it("should leave versions outside the blocked range running", async function () {
			let release = await makeExtension('1.1.0');
			await publish(makeIndex([release]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.1.0');
			
			let blocked = { [ID]: { versionRanges: [{ maxVersion: '1.0.9' }], reason: 'Old versions leak.' } };
			await publish(makeIndex([release], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			assert.isTrue((await AddonManager.getAddonByID(ID)).isActive);
			assert.equal(Zotero.PaperlyExtensionsTest, '1.1.0');
		});
		
		it("should compare versions as the add-on manager does", function () {
			let addon = version => ({ id: ID, version, updateURL: marketplaceUpdateURL() });
			let block = range => Zotero.Prefs.set('paperlyExtensions.blocked',
				JSON.stringify({ [ID]: { versionRanges: [range], reason: 'r' } }));
			block({ maxVersion: '1.2' });
			assert.equal(Zotero.PaperlyExtensions.getMarketplaceBlockReason(addon('1.2.0')), 'r');
			assert.isFalse(Zotero.PaperlyExtensions.getMarketplaceBlockReason(addon('1.2.1')));
			block({ minVersion: '2.0.0' });
			assert.equal(Zotero.PaperlyExtensions.getMarketplaceBlockReason(addon('2.0')), 'r');
			// A pre-release comes before its release
			block({ minVersion: '1.3' });
			assert.isFalse(Zotero.PaperlyExtensions.getMarketplaceBlockReason(addon('1.3b1')));
		});
		
		it("should leave an extension from elsewhere running unless the block is global", async function () {
			let release = await makeExtension('1.0');
			let elsewhere = await makeExtension('1.0', { updateURL: 'https://elsewhere.test/updates.json' });
			assert.equal(await installDirectly(elsewhere), 'installed');
			await waitForVersion('1.0');
			
			let blocked = { [ID]: { versionRanges: ['*'], reason: 'Squatted.' } };
			await publish(makeIndex([release], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			assert.isTrue((await AddonManager.getAddonByID(ID)).isActive);
			assert.equal(Zotero.PaperlyExtensionsTest, '1.0');
			
			blocked[ID].global = true;
			await publish(makeIndex([release], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			await waitForVersion(undefined);
			assert.isFalse((await AddonManager.getAddonByID(ID)).isActive);
		});
		
		it("should keep Zotero's own blocks for an id the marketplace blocks too", async function () {
			const BBT = 'better-bibtex@iris-advies.com';
			// Zotero blocks every version before 9.0; the marketplace one more
			Zotero.Prefs.set('paperlyExtensions.blocked', JSON.stringify({
				[BBT]: { versionRanges: ['9.1.3'], reason: 'One bad release.', global: true }
			}));
			let old = await makeExtension('8.0', { id: BBT, updateURL: 'https://elsewhere.test/updates.json' });
			try {
				assert.equal(await installDirectly(old), 'installed');
				let addon = await AddonManager.getAddonByID(BBT);
				assert.equal(addon.blocklistState, Ci.nsIBlocklistService.STATE_BLOCKED);
				assert.isFalse(addon.isActive);
				assert.isUndefined(Zotero.PaperlyExtensionsTest);
			}
			finally {
				let addon = await AddonManager.getAddonByID(BBT);
				if (addon) {
					await addon.uninstall();
				}
			}
		});
		
		it("should ignore a damaged list", function () {
			Zotero.Prefs.set('paperlyExtensions.blocked', '{ not json');
			assert.deepEqual(Zotero.PaperlyExtensions.getBlockedPlugins(), {});
			Zotero.Prefs.set('paperlyExtensions.blocked', JSON.stringify({ a: { reason: 'r' }, b: { versionRanges: ['*'], reason: 'r' } }));
			assert.deepEqual(Object.keys(Zotero.PaperlyExtensions.getBlockedPlugins()), ['b']);
		});
	});
	
	describe("#registerView()", function () {
		it("should add, replace and remove views", function () {
			let mine = () => Zotero.PaperlyExtensions.getViews().filter(v => v.pluginID == 'views@example.com');
			let removeFirst = Zotero.PaperlyExtensions.registerView({
				pluginID: 'views@example.com', id: 'v', label: 'First', onRender() {}
			});
			let removeSecond = Zotero.PaperlyExtensions.registerView({
				pluginID: 'views@example.com', id: 'v', label: 'Second', onRender() {}
			});
			assert.deepEqual(mine().map(v => v.label), ['Second']);
			// A replaced view's remover no longer reaches the new one
			removeFirst();
			assert.lengthOf(mine(), 1);
			removeSecond();
			assert.lengthOf(mine(), 0);
		});
		
		it("should refuse a view without what it needs", function () {
			assert.throws(
				() => Zotero.PaperlyExtensions.registerView({ pluginID: 'views@example.com', id: 'v', label: 'V' }),
				/onRender/
			);
			assert.throws(
				() => Zotero.PaperlyExtensions.registerView({ pluginID: 'views@example.com', label: 'V', onRender() {} }),
				/'id'/
			);
		});
	});
	
	describe("#getContext()", function () {
		var win, zp;
		
		before(async function () {
			win = await loadZoteroPane();
			zp = win.ZoteroPane;
		});
		
		it("should give the items selected in the library", async function () {
			let item = await createDataObject('item', { title: 'Context test' });
			await zp.selectItem(item.id);
			let context = Zotero.PaperlyExtensions.getContext();
			assert.sameMembers(context.items.map(i => i.id), [item.id]);
			assert.isNull(context.reader);
		});
		
		it("should give the reader's item and its selected text", async function () {
			let parent = await createDataObject('item', { title: 'Paper' });
			let attachment = await importFileAttachment('test.pdf', { parentID: parent.id });
			let reader = await Zotero.Reader.open(attachment.id);
			// What the reader does when text is selected
			Zotero.Reader._dispatchEvent({
				type: 'renderTextSelectionPopup',
				reader,
				doc: null,
				params: { annotation: { text: 'a sentence worth keeping', pageLabel: '3' } },
				append() {}
			});
			let context = Zotero.PaperlyExtensions.getContext();
			assert.equal(context.items[0].id, parent.id);
			assert.equal(context.reader.attachment.id, attachment.id);
			assert.equal(context.reader.selectedText, 'a sentence worth keeping');
			assert.equal(context.reader.pageLabel, '3');
			win.Zotero_Tabs.close(reader.tabID);
		});
		
		it("should say which API version it is", function () {
			assert.equal(Zotero.PaperlyExtensions.apiVersion, 1);
		});
	});
	
	describe("Extensions window", function () {
		var win;
		
		async function waitFor(check) {
			for (let i = 0; i < 100; i++) {
				let result = check();
				if (result) {
					return result;
				}
				await Zotero.Promise.delay(50);
			}
			throw new Error('Timed out');
		}
		
		afterEach(function () {
			if (win && !win.closed) {
				win.close();
			}
		});
		
		it("should show the marketplace, and install after the confirmation", async function () {
			await publish(makeIndex([await makeExtension('1.0.0')]));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			let item = await waitFor(() => doc.querySelector(`.item[data-id="${ID}"]`));
			assert.equal(item.getAttribute('aria-selected'), 'true');
			assert.equal(doc.querySelector('#details h2').textContent, 'Paperly Extensions Test');
			
			doc.querySelector('.details-actions button.primary').click();
			assert.isFalse(doc.getElementById('confirm').hidden);
			doc.getElementById('confirm-ok').click();
			await waitForVersion('1.0.0');
			
			// Now listed as installed, with Uninstall in place of Install
			let uninstall = await waitFor(() => [...doc.querySelectorAll('.details-actions button')]
				.find(button => button.getAttribute('data-l10n-id') == 'extensions-uninstall'));
			assert.ok(uninstall);
			uninstall.click();
			await waitForVersion(undefined);
			assert.isNull(await AddonManager.getAddonByID(ID));
		});
		
		it("should show an extension's view, and take it away when the extension stops", async function () {
			delete Zotero.PaperlyExtensionsTestViewDestroyed;
			await publish(makeIndex([await makeExtension('1.0.0', { withView: true })]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0.0');
			let key = `${ID}:main`;
			
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ view: key });
			win = await opened;
			let doc = win.document;
			let body = await waitFor(() => doc.querySelector(`.view[data-view="${key}"] .view-body`));
			assert.equal(body.textContent, 'Hello from 1.0.0');
			assert.isTrue(doc.getElementById('manager').hidden);
			assert.equal(doc.querySelector(`.view-button[data-view="${key}"]`).getAttribute('aria-selected'), 'true');
			
			// Back to the marketplace and in again: the view keeps what it drew
			doc.getElementById('activity-manager').click();
			assert.isFalse(doc.getElementById('manager').hidden);
			doc.querySelector(`.view-button[data-view="${key}"]`).click();
			assert.strictEqual(doc.querySelector(`.view[data-view="${key}"] .view-body`), body);
			
			await Zotero.PaperlyExtensions.setEnabled(ID, false);
			await waitFor(() => !doc.querySelector(`.view[data-view="${key}"]`));
			assert.isFalse(doc.getElementById('manager').hidden);
			assert.isNull(doc.querySelector('.view-button'));
			assert.isTrue(Zotero.PaperlyExtensionsTestViewDestroyed);
		});
		
		it("should say so when a view fails to render, later or at once", async function () {
			let removers = [
				Zotero.PaperlyExtensions.registerView({
					pluginID: 'views@example.com', id: 'later', label: 'Later',
					onRender: async () => {
						throw new Error('Failed later');
					}
				}),
				Zotero.PaperlyExtensions.registerView({
					pluginID: 'views@example.com', id: 'now', label: 'Now',
					onRender: () => {
						throw new Error('Failed at once');
					}
				})
			];
			try {
				let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
				Zotero.PaperlyExtensions.openWindow({ view: 'views@example.com:later' });
				win = await opened;
				let doc = win.document;
				await waitFor(() => doc.querySelector('.view[data-view="views@example.com:later"] .view-failed'));
				win.Zotero_Paperly_Extensions.showView('views@example.com:now');
				assert.ok(doc.querySelector('.view[data-view="views@example.com:now"] .view-failed'));
			}
			finally {
				removers.forEach(remove => remove());
			}
		});
		
		it("should name the domain a publisher verified", async function () {
			let publisher = { name: 'Someone', github: 'someone', official: false, verified: true, domain: 'example.org' };
			await publish(makeIndex([await makeExtension('1.0.0')], { publisher }));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			let badge = await waitFor(() => doc.querySelector('#details .publisher-badge.verified'));
			assert.equal(badge.getAttribute('data-l10n-id'), 'extensions-publisher-verified-domain');
			assert.deepEqual(JSON.parse(badge.getAttribute('data-l10n-args')), { domain: 'example.org' });
			// The list has room only for the badge
			let listBadge = doc.querySelector(`.item[data-id="${ID}"] .publisher-badge`);
			assert.equal(listBadge.getAttribute('data-l10n-id'), 'extensions-publisher-verified');
		});
		
		it("should offer no Update for an extension from elsewhere that has a listed id", async function () {
			let elsewhere = await makeExtension('1.0', { updateURL: 'https://elsewhere.test/updates.json' });
			assert.equal(await installDirectly(elsewhere), 'installed');
			await publish(makeIndex([await makeExtension('2.0')]));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			let banners = await waitFor(() => {
				let ids = [...doc.querySelectorAll('#details .banner')].map(b => b.getAttribute('data-l10n-id'));
				return ids.length && ids;
			});
			assert.includeMembers(banners, ['extensions-not-from-marketplace', 'extensions-id-conflict']);
			assert.isNull(doc.querySelector('[data-l10n-id="extensions-update"]'));
		});
		
		it("should confirm an update from a version the marketplace does not list", async function () {
			await publish(makeIndex([await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			// 1.0 is gone, and 1.1 says it uses nothing
			await publish(makeIndex([await makeExtension('1.1')]));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			let update = await waitFor(() => doc.querySelector('.details-actions [data-l10n-id="extensions-update"]'));
			update.click();
			assert.isFalse(doc.getElementById('confirm').hidden);
			doc.getElementById('confirm-cancel').click();
			await Zotero.Promise.delay(200);
			assert.equal((await AddonManager.getAddonByID(ID)).version, '1.0');
		});
		
		it("should update a blocked version to a release that is not blocked", async function () {
			await publish(makeIndex([await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			// The fix is out, and the block narrowed to the version before it
			let blocked = { [ID]: { versionRanges: [{ maxVersion: '1.0' }], reason: 'Leaks.' } };
			await publish(makeIndex([await makeExtension('1.1')], { blocked }));
			await Zotero.PaperlyExtensions.refresh();
			await waitForVersion(undefined);
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			let update = await waitFor(() => doc.querySelector('.details-actions [data-l10n-id="extensions-update"]'));
			// Blocked, it still cannot be switched back on
			assert.isNull(doc.querySelector('.details-actions [data-l10n-id="extensions-enable"]'));
			update.click();
			doc.getElementById('confirm-ok').click();
			await waitForVersion('1.1');
			assert.isTrue((await AddonManager.getAddonByID(ID)).isActive);
		});
		
		it("should confirm an update from another publisher, and say who", async function () {
			let first = await makeExtension('1.0');
			await publish(makeIndex([first]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			let publisher = { name: 'Someone else', github: 'someone-else', official: false, verified: false };
			await publish(makeIndex([await makeExtension('1.1'), first], { publisher }));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			let banner = await waitFor(() => doc.querySelector('#details [data-l10n-id="extensions-publisher-changed"]'));
			assert.deepEqual(JSON.parse(banner.getAttribute('data-l10n-args')), { previous: 'paperly', current: 'someone-else' });
			doc.querySelector('.details-actions [data-l10n-id="extensions-update"]').click();
			assert.isFalse(doc.getElementById('confirm').hidden);
			// The accounts, which the name alone could hide
			let changed = doc.querySelector('#confirm-body [data-l10n-id="extensions-confirm-publisher-changed"]');
			assert.deepEqual(JSON.parse(changed.getAttribute('data-l10n-args')), { previous: 'paperly', current: 'someone-else' });
			assert.include(doc.getElementById('confirm-body').textContent, 'Someone else');
			doc.getElementById('confirm-ok').click();
			await waitForVersion('1.1');
			// Accepted, so no longer a change
			await waitFor(() => !doc.querySelector('#details [data-l10n-id="extensions-publisher-changed"]'));
		});
		
		it("should check again when the last check is dated in the future", async function () {
			await publish(makeIndex([await makeExtension('1.0.0')]));
			await Zotero.PaperlyExtensions.refresh();
			// As if checked while the clock was a year ahead
			let future = Math.round(Date.now() / 1000) + 365 * 24 * 60 * 60;
			Zotero.Prefs.set('paperlyExtensions.lastCheck', future);
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow();
			win = await opened;
			await waitFor(() => Zotero.Prefs.get('paperlyExtensions.lastCheck') < future);
		});
		
		it("should install nothing when the confirmation is cancelled", async function () {
			await publish(makeIndex([await makeExtension('1.0.0')]));
			await Zotero.PaperlyExtensions.refresh();
			let opened = waitForWindow('chrome://zotero/content/paperlyExtensions.xhtml');
			Zotero.PaperlyExtensions.openWindow({ extensionID: ID });
			win = await opened;
			let doc = win.document;
			
			await waitFor(() => doc.querySelector(`.item[data-id="${ID}"]`));
			doc.querySelector('.details-actions button.primary').click();
			doc.getElementById('confirm-cancel').click();
			assert.isTrue(doc.getElementById('confirm').hidden);
			await Zotero.Promise.delay(200);
			assert.isNull(await AddonManager.getAddonByID(ID));
		});
	});
	
	describe("#uninstall()", function () {
		it("should remove the extension and stop it", async function () {
			await publish(makeIndex([await makeExtension('1.0')]));
			await Zotero.PaperlyExtensions.refresh();
			await Zotero.PaperlyExtensions.install(ID);
			await waitForVersion('1.0');
			await Zotero.PaperlyExtensions.uninstall(ID);
			assert.isNull(await AddonManager.getAddonByID(ID));
			assert.isUndefined(Zotero.PaperlyExtensionsTest);
		});
	});
});
