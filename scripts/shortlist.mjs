// Filters the catalog into a vendor shortlist for a specific workflow.
//
// Usage:
//   node scripts/shortlist.mjs                          # default futures/options data + execution preset
//   node scripts/shortlist.mjs --categories "Backtesting,Options"
//   node scripts/shortlist.mjs --match "walk-forward"   # regex over name + summary (replaces default)
//   node scripts/shortlist.mjs --check-urls             # live HTTP status per shortlisted URL
//   node scripts/shortlist.mjs --json                   # machine-readable output
//
// Filters combine with AND: a tool must match at least one requested category
// AND the regex. Output goes to stdout only. --check-urls needs unrestricted
// outbound HTTPS; sandboxes with an egress policy will report FAIL for blocked hosts.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = resolve(ROOT, "data/find-my-moat-tools.json");

// Default preset: data, backtesting, and execution tools for a systematic
// futures/options trader. The match regex keeps only tools that name the
// instruments or data granularity that workflow needs. Edit freely.
const DEFAULT_CATEGORIES = [
	"APIs & Data Feeds",
	"Backtesting",
	"Quant",
	"Broker Connectors",
	"Auto-Trading & Bots",
];
const DEFAULT_MATCH = "futures|tick data|order book|intraday|options";

const TIMEOUT_MS = 8000;

function parseArgs(argv) {
	const args = {
		categories: DEFAULT_CATEGORIES,
		match: new RegExp(DEFAULT_MATCH, "i"),
		checkUrls: false,
		json: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--categories") {
			args.categories = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
		} else if (arg === "--match") {
			args.match = new RegExp(argv[++i], "i");
		} else if (arg === "--check-urls") {
			args.checkUrls = true;
		} else if (arg === "--json") {
			args.json = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function select(tools, { categories, match }) {
	const wanted = new Set(categories.map((c) => c.toLowerCase()));
	return tools.filter((tool) => {
		const inCategory = tool.categories.some((c) => wanted.has(c.toLowerCase()));
		if (!inCategory) return false;
		if (match && !match.test(`${tool.name} ${tool.summary}`)) return false;
		return true;
	});
}

async function checkUrl(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		// HEAD first; many vendor sites reject HEAD, so fall back to GET.
		let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
		if (res.status === 405 || res.status === 403) {
			res = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
		}
		return { status: res.status, ok: res.ok };
	} catch (err) {
		return { status: null, ok: false, error: err.name === "AbortError" ? "timeout" : err.message };
	} finally {
		clearTimeout(timer);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
	let rows = select(catalog.tools, args).sort((a, b) => a.name.localeCompare(b.name));

	if (args.checkUrls) {
		// Sequential on purpose: keeps load on vendor sites low and output ordered.
		for (const row of rows) row.check = await checkUrl(row.url);
	}

	if (args.json) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}

	console.log(`# Shortlist (${rows.length} tools)\n`);
	console.log(`Categories: ${args.categories.join(", ")}`);
	if (args.match) console.log(`Match: /${args.match.source}/i`);
	console.log(`Catalog exported: ${catalog.exportedOn}\n`);

	for (const row of rows) {
		const status = row.check
			? ` [${row.check.ok ? "OK" : "FAIL"} ${row.check.status ?? row.check.error}]`
			: "";
		console.log(`- **${row.name}**${status} — ${row.url}`);
		console.log(`  ${row.summary}`);
		console.log(`  Categories: ${row.categories.join(", ")}\n`);
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exitCode = 1;
});
