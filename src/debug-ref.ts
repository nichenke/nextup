#!/usr/bin/env bun
import { TicketRefError, resolveTicketRef } from "./ticket-ref";

const input = process.argv[2];
if (!input) {
	console.error("usage: debug-ref.ts <ticket-ref-or-url>");
	process.exit(1);
}

try {
	console.log(JSON.stringify(resolveTicketRef(input), null, 2));
} catch (err) {
	if (err instanceof TicketRefError) {
		console.error(err.message);
		process.exit(1);
	}
	throw err;
}
