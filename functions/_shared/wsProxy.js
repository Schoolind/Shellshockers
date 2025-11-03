export async function handleProxyRequest(context, label = "Proxy") {
    const { request, env } = context;

    console.log(`[${label}] Request to:`, request.url);

    if (!env.HMAC_SECRET) {
        console.error(`[${label}] HMAC_SECRET not configured`);
        return new Response("Server misconfigured", { status: 500 });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    const clientProtoHeader = request.headers.get("sec-websocket-protocol") || "";
    const clientProtocols = clientProtoHeader.split(",").map(s => s.trim()).filter(Boolean);
    const selectedClientProto = clientProtocols[0] || null;

    if (upgradeHeader !== "websocket") {
        console.log(`[${label}] Not a WebSocket upgrade request`);
        return new Response("Expected WebSocket", { status: 426 });
    }

    const clientIP = request.headers.get("CF-Connecting-IP");
    const country = request.headers.get("CF-IPCountry") || "unknown";

    if (!clientIP) {
        console.error(`[${label}] No CF-Connecting-IP header`);
        return new Response("Unable to determine client IP", { status: 500 });
    }

    console.log(`[${label}] Client ${clientIP} (${country})`);

	const backends = [
		"dev.shellshock.io"
	];

    try {
        const token = await createAuthToken(clientIP, env.HMAC_SECRET);
        console.log(`[${label}] Token generated: ${token.substring(0, 20)}...`);

        const shuffled = shuffleArray([...backends]);
        const maxAttempts = 10;

        for (let i = 0; i < Math.min(maxAttempts, shuffled.length); i++) {
            const backend = shuffled[i];
            const backendUrl = `wss://${backend}/matchmaker/`;
            console.log(`[${label}] Attempt ${i + 1}: ${backendUrl}`);

            try {
                const upstreamProtocols = selectedClientProto ? [selectedClientProto, token] : [token];
                const swp = upstreamProtocols.join(", ");

                const resp = await fetch(backendUrl, {
                    headers: {
                        "Upgrade": "websocket",
                        "Sec-WebSocket-Protocol": swp,
                    },
                });

                if (!resp.webSocket) {
                    console.log(`[${label}] Upstream handshake failed (no webSocket)`);
                    continue;
                }

                const backendWs = resp.webSocket;
                backendWs.accept();

                const pair = new WebSocketPair();
                const [client, server] = Object.values(pair);

                backendWs.addEventListener("message", (event) => {
                    try { server.send(event.data); }
                    catch (e) { console.error(`[${label}] Error forwarding to client:`, e.message); }
                });

                server.addEventListener("message", (event) => {
                    try {
                        if (backendWs.readyState === WebSocket.OPEN)
                            backendWs.send(event.data);
                    } catch (e) {
                        console.error(`[${label}] Error forwarding to backend:`, e.message);
                    }
                });

                backendWs.addEventListener("close", (event) => {
                    console.log(`[${label}] Backend closed: ${event.code} ${event.reason}`);
                    try { server.close(event.code, event.reason); } catch {}
                });

                server.addEventListener("close", (event) => {
                    console.log(`[${label}] Client closed: ${event.code} ${event.reason}`);
                    try { backendWs.close(event.code, event.reason); } catch {}
                });

                server.accept();
                console.log(`[${label}] ✓ Connected to ${backend} for ${clientIP}`);

                const headers = new Headers();
                if (selectedClientProto)
                    headers.set("Sec-WebSocket-Protocol", selectedClientProto);

                return new Response(null, { status: 101, webSocket: client, headers });

            } catch (error) {
                console.error(`[${label}] ✗ ${backend}:`, error.message, error.stack);
                continue;
            }
        }

        console.error(`[${label}] All backends failed`);
        return new Response("All backends failed", { status: 503 });

    } catch (error) {
        console.error(`[${label}] Fatal error:`, error.message, error.stack);
        return new Response("Internal server error", { status: 500 });
    }
}

async function createAuthToken(ip, secret) {
    const timestamp = Date.now().toString();
    const data = `${ip}|${timestamp}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
    const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, "0")).join("");
    return base64urlEncode(`${data}|${sigHex}`);
}

function base64urlEncode(str) {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}