export async function handleProxyRequest(context, label = "Proxy") {
    const { request, env } = context;

    const reqUrl = new URL(request.url);

    // Decide upstream path from incoming route. Default to /matchmaker/.
    let routePath = '/matchmaker/';
    if (reqUrl.pathname.startsWith('/services')) routePath = '/services/';
    else if (reqUrl.pathname.startsWith('/game')) routePath = '/game/';

    // services is transactional (open → one reply → close), others are long-lived
    const isTransactional = routePath === '/services/';

    // Attach HMAC token to subprotocols for matchmaker/services only (not for game)
    const attachToken = routePath !== '/game/';

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

    // Sticky upstream: allow pinning to a chosen backend via cookie or query param
    function parseCookies(header) {
      return (header || '').split(';').reduce((acc, part) => {
        const i = part.indexOf('=');
        if (i === -1) return acc;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) acc[k] = v;
        return acc;
      }, {});
    }
    const cookies = parseCookies(request.headers.get('Cookie'));
    const forcedUp = reqUrl.searchParams.get('up'); // for testing, e.g. ?up=dev.shellshock.io

	function isValidBackend(host) {
		if (!host) return false;
		if (host === 'dev.shellshock.io') return true;
		// Allow game cluster subdomains: egs-static-dev-uswest-z6w70a8.shellshock.io, etc.
		return /^egs-[a-z0-9-]+\.shellshock\.io$/.test(host);
	}
	
	const allowlist = [
		"dev.shellshock.io"
	];
	
	const sticky = forcedUp || cookies['ws_upstream'] || '';

	// If ?up= or cookie specifies a valid backend, use it first
	let backends;  // ← Declare OUTSIDE the if/else
	if (sticky && isValidBackend(sticky)) {
		backends = [sticky, ...allowlist.filter(b => b !== sticky)];
	} else {
		backends = allowlist.slice();
	}

    try {
        const token = await createAuthToken(clientIP, env.HMAC_SECRET);
        console.log(`[${label}] Token generated: ${token.substring(0, 20)}...`);

        const shuffled = shuffleArray([...backends]);
        const maxAttempts = 10;

        for (let i = 0; i < Math.min(maxAttempts, shuffled.length); i++) {
            const backend = shuffled[i];
            const backendUrl = `https://${backend}${routePath}`;
            console.log(`[${label}] Attempt ${i + 1}: ${backendUrl}`);

            try {
                let upstreamProtocols;
                if (attachToken) {
                  upstreamProtocols = selectedClientProto ? [selectedClientProto, token] : [token];
                } else {
                  // game: pass through only the browser-requested subprotocol (if any)
                  upstreamProtocols = selectedClientProto ? [selectedClientProto] : [];
                }
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

                let repliedOnce = false;

                backendWs.addEventListener("message", (event) => {
                    // Do not forward control keepalives to the browser
                    if (typeof event.data === "string" && (event.data === "ping" || event.data === "pong")) {
                        return;
                    }
                    try { server.send(event.data); }
                    catch (e) { console.error(`[${label}] Error forwarding to client:`, e.message); }

                    if (isTransactional && !repliedOnce) {
                      repliedOnce = true;
                      // Allow the frame to flush, then close both ends with a clean code.
                      setTimeout(() => {
                        try { server.close(1000, "ok"); } catch {}
                        try { backendWs.close(1000, "ok"); } catch {}
                      }, 0);
                    }
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

                if (!isTransactional) {
                  const KA_INTERVAL_MS = 25000;
                  const ka = setInterval(() => {
                    try { if (backendWs.readyState === WebSocket.OPEN) backendWs.send("ping"); } catch {}
                  }, KA_INTERVAL_MS);
                  const clearKA = () => { try { clearInterval(ka); } catch {} };
                  backendWs.addEventListener("close", clearKA);
                  server.addEventListener("close", clearKA);
                  backendWs.addEventListener("error", clearKA);
                  server.addEventListener("error", clearKA);
                }

                console.log(`[${label}] ✓ Connected to ${backend} for ${clientIP}`);

                const headers = new Headers();
                if (selectedClientProto)
                    headers.set("Sec-WebSocket-Protocol", selectedClientProto);

                // Persist chosen backend for this browser for 30 minutes
                headers.append("Set-Cookie", `ws_upstream=${backend}; Path=/; Max-Age=1800; Secure; HttpOnly; SameSite=None`);

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