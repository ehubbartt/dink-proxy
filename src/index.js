import dinkConfigTemplate from "../dinkconfig-template.json";

const CHANNEL_TO_SECRET = {
	achievements: "WEBHOOK_ACHIEVEMENTS",
	deaths: "WEBHOOK_DEATHS",
	collection: "WEBHOOK_COLLECTION",
};

const SAFE_ALLOWED_MENTIONS = { parse: [] };

const CONFIG_TEMPLATE_STRING = JSON.stringify(dinkConfigTemplate);

function getValidTokens(env) {
	return new Set(
		(env.VALID_TOKENS || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
	);
}

async function handleHook(request, env, channel) {
	const secretName = CHANNEL_TO_SECRET[channel];
	const webhook = secretName && env[secretName];
	if (!webhook) {
		return new Response("unknown channel", { status: 404 });
	}

	const contentType = request.headers.get("Content-Type") || "";
	let upstream;

	if (contentType.includes("application/json")) {
		let payload;
		try {
			payload = await request.json();
		} catch {
			return new Response("invalid json", { status: 400 });
		}
		payload.allowed_mentions = SAFE_ALLOWED_MENTIONS;
		upstream = await fetch(webhook, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} else if (contentType.includes("multipart/form-data")) {
		let form;
		try {
			form = await request.formData();
		} catch {
			return new Response("invalid multipart", { status: 400 });
		}
		const payloadJsonRaw = form.get("payload_json");
		if (typeof payloadJsonRaw !== "string") {
			return new Response("missing payload_json", { status: 400 });
		}
		let payload;
		try {
			payload = JSON.parse(payloadJsonRaw);
		} catch {
			return new Response("invalid payload_json", { status: 400 });
		}
		payload.allowed_mentions = SAFE_ALLOWED_MENTIONS;
		form.set("payload_json", JSON.stringify(payload));
		upstream = await fetch(webhook, { method: "POST", body: form });
	} else {
		return new Response("unsupported content type", { status: 415 });
	}

	return new Response(upstream.body, { status: upstream.status });
}

function handleConfig(token) {
	const body = CONFIG_TEMPLATE_STRING.replaceAll("{{TOKEN}}", token);
	return new Response(body, {
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);
		const validTokens = getValidTokens(env);

		if (
			request.method === "GET" &&
			parts.length === 2 &&
			parts[0] === "config"
		) {
			const [, token] = parts;
			if (!validTokens.has(token)) {
				return new Response("unauthorized", { status: 401 });
			}
			return handleConfig(token);
		}

		if (
			request.method === "POST" &&
			parts.length === 3 &&
			parts[0] === "hook"
		) {
			const [, token, channel] = parts;
			if (!validTokens.has(token)) {
				return new Response("unauthorized", { status: 401 });
			}
			return handleHook(request, env, channel);
		}

		return new Response("not found", { status: 404 });
	},
};
