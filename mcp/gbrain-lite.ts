/**
 * gbrain-lite — MCP stdio filter proxy for gbrain.
 *
 * Sits between the host (omp) and `gbrain serve` (stdio). Forwards all
 * JSON-RPC traffic untouched EXCEPT `tools/list` responses, where it
 * filters the ~90 gbrain tools down to the curated GBRAIN_LITE set below.
 *
 * Why: gbrain's stdio server exposes every operation unconditionally and
 * omp has no per-server tool filtering. Each tool definition costs prompt
 * tokens in every session and subagent spawn.
 *
 * Upgrade-safe: does not modify gbrain-repo; only spawns it.
 *
 * MCP stdio framing: newline-delimited JSON-RPC (NDJSON).
 */

const GBRAIN_CLI =
	"C:/Users/Administrator/AppData/Local/hermes/gbrain-repo/src/cli.ts";
const BUN = "C:/Users/Administrator/.bun/bin/bun.exe";
/** Curated tool set for coding-harness sessions. Edit freely. */
const GBRAIN_LITE: Record<string, true> = {
	// core retrieval
	query: true, // hybrid search (vector + keyword + expansion)
	search: true, // plain FTS keyword search
	get_page: true, // read page by slug
	list_pages: true, // recent/filtered page listing
	resolve_slugs: true, // fuzzy slug resolution
	get_backlinks: true, // inbound links
	get_links: true, // outbound links
	traverse_graph: true, // link graph walk
	think: true, // multi-hop synthesis with citations
	// hot memory
	recall: true, // per-source hot memory facts
	get_recent_salience: true, // what is going on lately
	// writes
	put_page: true, // write/update a page
	add_link: true,
	add_tag: true,
	add_timeline_entry: true,
	get_timeline: true,
	// chronicle
	chronicle_day: true,
	chronicle_since: true,
	// people
	find_experts: true,
	// meta
	whoami: true,
	get_health: true,
};

const child = Bun.spawn([BUN, GBRAIN_CLI, "serve", "--port", "8046"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "inherit", // MCP hosts ignore stderr; keep child logs visible there
	env: process.env,
});

/** ids of in-flight tools/list requests sent by the client */
const toolsListIds = new Set<number | string>();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeLine(stream: typeof process.stdout, line: string): void {
	stream.write(encoder.encode(line + "\n"));
}

/** client → child: track tools/list request ids, forward verbatim */
async function pumpClientToChild(): Promise<void> {
	let buf = "";
	for await (const chunk of Bun.stdin.stream()) {
		buf += decoder.decode(chunk, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line) as {
					id?: number | string;
					method?: string;
				};
				if (msg.method === "tools/list" && msg.id !== undefined) {
					toolsListIds.add(msg.id);
				}
			} catch {
				// not JSON — forward anyway
			}
			child.stdin.write(line + "\n");
		}
	}
	child.stdin.end();
}

/** child → client: filter tools/list responses, forward the rest */
async function pumpChildToClient(): Promise<void> {
	let buf = "";
	for await (const chunk of child.stdout) {
		buf += decoder.decode(chunk as Uint8Array, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line) continue;
			let out = line;
			try {
				const msg = JSON.parse(line) as {
					id?: number | string;
					result?: { tools?: Array<{ name: string }> };
				};
				if (
					msg.id !== undefined &&
					toolsListIds.has(msg.id) &&
					Array.isArray(msg.result?.tools)
				) {
					toolsListIds.delete(msg.id);
					const before = msg.result.tools.length;
					msg.result.tools = msg.result.tools.filter(t => GBRAIN_LITE[t.name]);
					process.stderr.write(
						`[gbrain-lite] tools/list: ${before} -> ${msg.result.tools.length}\n`,
					);
					out = JSON.stringify(msg);
				}
			} catch {
				// not JSON — forward anyway
			}
			writeLine(process.stdout, out);
		}
	}
}

child.exited.then(code => {
	process.exit(code ?? 0);
});

process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());

await Promise.all([pumpClientToChild(), pumpChildToClient()]);
