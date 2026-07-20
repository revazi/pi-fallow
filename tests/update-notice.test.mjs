import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	scheduleFallowUpdateNotice,
	sendFallowAboutMessage,
} = await jiti.import("../extensions/fallow/update-notice.ts");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function drainPromises() {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("Pi Fallow update notices", () => {
	it("reports newer npm releases once with the canonical Pi update command", async () => {
		const originalFetch = globalThis.fetch;
		const originalDisable = process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE;
		let latestVersion = "99.0.0";
		let fetchCalls = 0;
		const messages = [];
		const notifications = [];
		const pi = { sendMessage(message) { messages.push(message); } };
		const ctx = {
			hasUI: true,
			ui: { notify(message, level) { notifications.push({ message, level }); } },
		};

		globalThis.fetch = async () => {
			fetchCalls++;
			return { ok: true, async json() { return { version: latestVersion }; } };
		};

		try {
			await sendFallowAboutMessage(pi, { hasUI: false });
			assert.equal(messages[0].details.currentVersion, packageJson.version);
			assert.equal(messages[0].details.latestVersion, "99.0.0");
			assert.equal(messages[0].details.updateAvailable, true);
			assert.equal(messages[0].details.updateCommand, "pi update npm:pi-fallow");
			assert.match(messages[0].content, /Update command: pi update npm:pi-fallow/);

			process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE = "1";
			scheduleFallowUpdateNotice(pi, ctx);
			await drainPromises();
			assert.deepEqual(notifications, []);

			delete process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE;
			scheduleFallowUpdateNotice(pi, ctx);
			await drainPromises();
			assert.deepEqual(notifications, [{
				message: `Pi Fallow 99.0.0 is available (you have ${packageJson.version}). Update: pi update npm:pi-fallow. Details: /fallow about`,
				level: "warning",
			}]);

			scheduleFallowUpdateNotice(pi, ctx);
			await drainPromises();
			assert.equal(notifications.length, 1);

			latestVersion = packageJson.version;
			await sendFallowAboutMessage(pi, { hasUI: false });
			assert.equal(messages[1].details.updateAvailable, false);
			assert.equal(fetchCalls, 2);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalDisable === undefined) delete process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE;
			else process.env.PI_FALLOW_DISABLE_UPDATE_NOTICE = originalDisable;
		}
	});
});
