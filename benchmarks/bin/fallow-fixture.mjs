#!/usr/bin/env node

process.stdout.write(JSON.stringify({
	kind: "dead-code",
	schema_version: 7,
	version: "benchmark",
	elapsed_ms: 1,
	total_issues: 0,
	summary: { total_issues: 0 },
	unused_files: [],
	unused_exports: [],
}));
