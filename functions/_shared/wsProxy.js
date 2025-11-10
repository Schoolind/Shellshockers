export async function handleProxyRequest(context, label = "Proxy") {
    const { request, env } = context;

    const reqUrl = new URL(request.url);

    // Decide upstream path from incoming route. Default to /matchmaker/.
    let routePath = '/matchmaker/';
    if (reqUrl.pathname.startsWith('/services')) routePath = '/services/';
    else if (reqUrl.pathname.startsWith('/game/')) {  // <-- ADD TRAILING SLASH
        routePath = reqUrl.pathname;  // Preserve full path: /game/four-save-jets
    }

    // services is transactional (open → one reply → close), others are long-lived
    const isTransactional = routePath === '/services/';

    // Attach HMAC token to subprotocols for ALL routes (matchmaker, services, game)
    const attachToken = true;

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
	// normalize host from ?up or cookie: strip scheme, path, port, fragments
	const normalizeHost = (h) => {
		if (!h) return '';
		let s = String(h).trim();
		s = s.replace(/^[a-z]+:\/\//i, ''); // remove scheme
		s = s.replace(/[/?#].*$/, '');      // remove path/query/fragment
		s = s.replace(/:\d+$/, '');         // remove port
		return s;
		};

	const forcedUp = normalizeHost(reqUrl.searchParams.get('up')); // e.g. ?up=egs-...deathegg.life
	const cookieUp = normalizeHost(cookies['ws_upstream']);

    // CHANGE: validate against allowlist domains and their subdomains (no hardcoded patterns)
    function isValidBackend(host) {
        if (!host) return false;
        const h = host.toLowerCase();

        // Accept if it matches any entry in the allowlist or is a subdomain of it.
        // e.g., allowlist = ["deathegg.life", "shellbros.pages.dev"]
        // - "deathegg.life"            ✅
        // - "x.deathegg.life"          ✅
        // - "egs-static-...deathegg.life" ✅
        return allowlist.some(domain => {
            const d = domain.toLowerCase();
            return h === d || h.endsWith(`.${d}`);
        });
    }

    // Keep your existing allowlist array; populate it with proxy base domains.
    // Example during testing:
    //   const allowlist = ["deathegg.life", "shellbros.pages.dev", "dev.shellshock.io"];
    const allowlist = [
		'shellshock.io',
        "dev.shellshock.io"
    ];

    const sticky = forcedUp || cookieUp || '';

    // If ?up= or cookie specifies a valid backend, use it first
    let backends;
    if (sticky && isValidBackend(sticky)) {
        backends = [sticky, ...allowlist.filter(b => b.toLowerCase() !== sticky.toLowerCase())];
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
                // Always include the HMAC token; prepend any client-requested subprotocol.
                const upstreamProtocols = attachToken
                    ? (selectedClientProto ? [selectedClientProto, token] : [token])
                    : (selectedClientProto ? [selectedClientProto] : []);
                
                const headersInit = { "Upgrade": "websocket" };
                if (upstreamProtocols.length) {
                    headersInit["Sec-WebSocket-Protocol"] = upstreamProtocols.join(", ");
                }

				// Forward extensions & origin so upstream can complete strict handshakes
				const ext = request.headers.get("sec-websocket-extensions");
				if (ext) headersInit["Sec-WebSocket-Extensions"] = ext;
				const origin = request.headers.get("origin");
				if (origin) headersInit["Origin"] = origin;

                const resp = await fetch(backendUrl, { headers: headersInit });

                if (!resp.webSocket) {
                    console.log(`[${label}] Upstream handshake failed (no webSocket)`);
                    continue;
                }

                const backendWs = resp.webSocket;
                backendWs.accept();

                const pair = new WebSocketPair();
                const [client, server] = Object.values(pair);

                let repliedOnce = false;

                // Only send ping for probe connections (no game code)
                const isProbe = routePath === '/game/' && reqUrl.searchParams.has('probe');

                if (isProbe) {
                    try {
                        if (backendWs.readyState === WebSocket.OPEN) {
                            backendWs.send('ping');
                        }
                    } catch (e) {
                        console.error(`[${label}] Failed to send initial ping:`, e.message);
                    }
                }

                backendWs.addEventListener("message", (event) => {
                    console.log(`[${label}] Backend sent:`, typeof event.data, event.data);
                    
                    // Do not forward control keepalives to the browser
                    if (typeof event.data === "string" && (event.data === "ping" || event.data === "pong")) {
                        console.log(`[${label}] Blocked keepalive:`, event.data);
                        return;
                    }
                    
                    console.log(`[${label}] Forwarding to client:`, event.data);
                    try { server.send(event.data); }
                    catch (e) { console.error(`[${label}] Error forwarding to client:`, e.message); }
                    
                    if (isTransactional && !repliedOnce) {
                        repliedOnce = true;
                        setTimeout(() => {
                            try { server.close(1000, "ok"); } catch {}
                            try { backendWs.close(1000, "ok"); } catch {}
                        }, 0);
                    }
                });
                
                server.addEventListener("message", (event) => {
                    console.log(`[${label}] Client sent:`, typeof event.data, event.data);
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
                // Echo ONLY the client's subprotocol back to the browser (never the token)
                if (selectedClientProto) {
                    headers.set("Sec-WebSocket-Protocol", selectedClientProto);
                }

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