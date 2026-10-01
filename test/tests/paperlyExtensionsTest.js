"use strict";

describe("Zotero.PaperlyExtensions", function () {
	var { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
	
	const ID = 'paperly-extensions-test@paperly.org';
	
	var httpd, baseURL, keys, dir;
	
	function toBase64(buffer) {
		return btoa(String.fromCharCode(...new Uint8Array(buffer)));
	}
	
	async function sha256(path) {
		let digest = await crypto.subtle.digest('SHA-256', await IOUtils.read(path));
		return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
	}
	
	// Writes an .xpi that records in Zotero.PaperlyExtensionsTest which version
	// of it is running, and serves it at files/<name>
	async function makeExtension(version) {
		let name = `test-${version}.xpi`;
		let path = PathUtils.join(dir, name);
		/* eslint-disable camelcase */
		let files = {
			'manifest.json': JSON.stringify({
				manifest_version: 2,
				name: 'Paperly Extensions Test',
				version,
				applications: {
					zotero: {
						id: ID,
						// The add-on manager disables an add-on whose updates
						// would come over plain HTTP, as the test server's would
						update_url: `https://registry.test/updates/${ID}.json`,
						strict_min_version: '6.999',
						strict_max_version: '*'
					}
				}
			}),
			'bootstrap.js': 'function startup({ version }) { Zotero.PaperlyExtensionsTest = version; }\n'
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
	
	function makeIndex(versions, { generated = new Date(), blocked = {} } = {}) {
		return {
			schema: 1,
			generated: generated.toISOString(),
			baseURL,
			appVersion: Services.appinfo.version,
			extensions: [{
				id: ID,
				name: 'Paperly Extensions Test',
				description: 'Tells the tests which version is running.',
				publisher: { name: 'Paperly', github: 'paperly', official: true, verified: true },
				repo: 'paperly/test',
				homepage: null,
				license: 'MIT',
				privacyPolicy: null,
				categories: [],
				icon: null,
				declares: {},
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
			await publish(makeIndex([], { generated: new Date(2020, 0, 1) }));
			let error = await getPromiseError(Zotero.PaperlyExtensions.refresh());
			assert.equal(error.code, 'stale');
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
