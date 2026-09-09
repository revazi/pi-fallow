import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

interface ReadLimits { minimum: number; maximum: number; executable?: boolean }

/** Validate and read the same opened file, with a fixed allocation and no pathname check/reopen race. */
export async function readSizedFile(path: string, limits: ReadLimits, openFile = open): Promise<Buffer> {
	// Nonblocking open lets us reject a FIFO/device via fstat without waiting for a writer.
	const file = await openFile(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const info = await file.stat();
		validateSize(info, path, limits);
		validateExecutable(info, path, limits.executable);
		const buffer = Buffer.alloc(info.size + 1);
		const length = await readBounded(file, buffer);
		if (length !== info.size) throw new Error(`File size changed while reading: ${path}`);
		return buffer.subarray(0, length);
	} finally {
		await file.close();
	}
}

function validateSize(info: Stats, path: string, limits: ReadLimits): void {
	if (!info.isFile()) throw new Error(`Expected a regular file: ${path}`);
	if (info.size < limits.minimum || info.size > limits.maximum) throw new Error(`Expected file size ${limits.minimum}–${limits.maximum} bytes: ${path}`);
}

function validateExecutable(info: Stats, path: string, executable: boolean | undefined): void {
	if (!executable || process.platform === "win32") return;
	if ((info.mode & 0o111) === 0) throw new Error(`Sidecar has no executable permission bits: ${path}`);
}

async function readBounded(file: FileHandle, buffer: Buffer): Promise<number> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return offset;
}
