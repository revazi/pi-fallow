import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createJiti } from "jiti";

const { readSizedFile } = await createJiti(import.meta.url).import("../extensions/fallow/read-sized-file.ts");
const limits = { minimum: 1, maximum: 64 };

it("reads the validated open file even if its pathname is replaced, and handles short reads", async () => {
	const root = await mkdtemp(join(tmpdir(), "fallow-file-race-"));
	const path = join(root, "binary");
	let closes = 0;
	try {
		await writeFile(path, "original");
		const openReplacingPath = async (name, flags) => {
			const file = await open(name, flags);
			return {
				async stat() {
					const info = await file.stat();
					await rename(path, `${path}.old`);
					await writeFile(path, "replacement with different bytes and size");
					return info;
				},
				read: (buffer, offset, length, position) => file.read(buffer, offset, Math.min(length, 2), position),
				async close() { closes++; await file.close(); },
			};
		};
		assert.equal((await readSizedFile(path, limits, openReplacingPath)).toString(), "original");
		assert.match(await readFile(path, "utf8"), /replacement/);
		assert.equal(closes, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});

function fakeFile(content, info = {}, readError) {
	let closes = 0;
	let reads = 0;
	const data = Buffer.from(content);
	return {
		closes: () => closes,
		reads: () => reads,
		open: async () => ({
			stat: async () => ({ size: data.length, mode: 0o755, isFile: () => true, ...info }),
			read: async (buffer, offset, length, position) => {
				reads++;
				if (readError) throw readError;
				assert.ok(buffer.length <= 65, "allocation must stay within the checked size plus one byte");
				return { bytesRead: data.copy(buffer, offset, position, position + Math.min(length, 2)) };
			},
			close: async () => { closes++; },
		}),
	};
}

it("rejects growth and shrinkage after fstat with bounded reads and always closes", async () => {
	for (const content of ["", "growing".repeat(100)]) {
		const file = fakeFile(content, { size: 3 });
		await assert.rejects(readSizedFile("binary", limits, file.open), /size changed/);
		assert.equal(file.closes(), 1);
		assert.ok(file.reads() <= 2);
	}
});

it("rejects non-files and invalid sizes before reading, and closes on read failures", async () => {
	for (const info of [{ size: 0 }, { size: 65 }, { isFile: () => false }]) {
		const file = fakeFile("data", info);
		await assert.rejects(readSizedFile("binary", limits, file.open), /Expected/);
		assert.equal(file.reads(), 0);
		assert.equal(file.closes(), 1);
	}
	const file = fakeFile("data", {}, new Error("read failed"));
	await assert.rejects(readSizedFile("binary", limits, file.open), /read failed/);
	assert.equal(file.closes(), 1);
});

it("checks executable mode from the opened file metadata without a separate access check", { skip: process.platform === "win32" }, async () => {
	const file = fakeFile("data", { mode: 0o644 });
	await assert.rejects(readSizedFile("binary", { ...limits, executable: true }, file.open), /executable permission/);
	assert.equal(file.reads(), 0);
	assert.equal(file.closes(), 1);
});
