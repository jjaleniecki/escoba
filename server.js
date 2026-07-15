// ═══════════════════════════════════════════════════════════════
// server.js  (Ejercicio 3 — salas + agente IA con Gemini)
// ═══════════════════════════════════════════════════════════════

const path  = require("path");
const fs    = require("fs");
const http  = require("http");
const SWIPL = require("swipl-wasm");
const { WebSocketServer } = require("ws");

const WEBAPP_DIR     = path.join(__dirname, "webapp");
const LOGICA_PL_PATH = path.join(__dirname, "logica.pl");
const CODIGO_PL      = fs.readFileSync(LOGICA_PL_PATH, "utf8");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL     = "https://generativelanguage.googleapis.com/v1beta/chat/completions";
const GEMINI_MODEL   = "gemini-2.0-flash";

// ───────────────────────────────────────────────────────────────
// Salas
// ───────────────────────────────────────────────────────────────

const salas = new Map();
let contadorSalas = 0;
let salaEsperando = null; // sala esperando un segundo jugador humano

async function crearSala(conIA = false) {
    const id = ++contadorSalas;
    const swiplInst = await SWIPL({ arguments: ["-q"] });
    swiplInst.FS.writeFile("/logica.pl", CODIGO_PL);
    const r = swiplInst.prolog.query("consult('/logica.pl')").once();
    if (!r || r.success !== true) throw new Error(`Sala ${id}: fallo consult`);
    swiplInst.prolog.query("reiniciar_juego").once();

    const sala = {
        id,
        swipl: swiplInst,
        sockets: { player1: null, player2: null },
        conIA,
        // Si hay IA, guarda el nombre del jugador humano para los mensajes
        nombreHumano: null,
    };
    salas.set(id, sala);
    console.log(`[sala ${id}] Creada ${conIA ? "(con IA)" : "(2 humanos)"}`);
    return sala;
}

function destruirSala(sala) {
    salas.delete(sala.id);
    if (salaEsperando && salaEsperando.id === sala.id) salaEsperando = null;
    console.log(`[sala ${sala.id}] Destruida (activas: ${salas.size})`);
}

// ───────────────────────────────────────────────────────────────
// Helpers Prolog
// ───────────────────────────────────────────────────────────────

function prologCall(sala, goal) {
    const r = sala.swipl.prolog.query(goal).once();
    if (!r || r.success !== true) {
        console.error(`[sala ${sala.id}] Goal fallo: ${goal}`);
        return false;
    }
    return true;
}

function prologCheck(sala, goal) {
    const r = sala.swipl.prolog.query(goal).once();
    return !!r && r.success === true;
}

function sacarMensajesPendientes(sala) {
    const r = sala.swipl.prolog.query("sacar_mensajes_pendientes(Lineas)").once();
    if (!r || r.success !== true || !Array.isArray(r.Lineas)) return [];
    return r.Lineas.map((linea) => {
        const idx = linea.indexOf("\u0001");
        return { jugador: linea.slice(0, idx), texto: linea.slice(idx + 1) };
    });
}

function enviarTexto(sala, playerId, texto) {
    const ws = sala.sockets[playerId];
    if (ws && ws.readyState === ws.OPEN) ws.send(texto);
}

function repartirMensajesPendientes(sala) {
    for (const { jugador, texto } of sacarMensajesPendientes(sala)) {
        // Si hay IA, player2 no tiene socket — los mensajes que le
        // corresponden van igualmente al jugador humano (player1) para
        // que pueda ver qué hizo la IA. Excepcion: el bloque de estado
        // del juego desde la perspectiva de player2 NO se manda, porque
        // contiene "Jugador: IA (Gemini)" y confundiria al cliente.
        if (sala.conIA && jugador === "player2") {
            // Mensajes del estado del juego y de fin de partida NO se
            // mandan al humano desde la perspectiva de player2 — el
            // humano ya los recibe desde su propia perspectiva (player1).
            // Solo se reenvian mensajes informativos como capturas y escobas.
            const esMensajeEstado = texto.includes("--- Estado del juego ---");
            const esMensajeFin    = texto.includes("=== Resultado final ===")
                                 || texto.includes("Felicitaciones")
                                 || texto.includes("Empate entre")
                                 || /gan[oó] con/.test(texto)
                                 || texto.includes("Mas suerte la proxima");
            if (!esMensajeEstado && !esMensajeFin) {
                enviarTexto(sala, "player1", `[IA] ${texto}`);
            }
        } else {
            enviarTexto(sala, jugador, texto);
        }
    }
}

// Extraer la mano actual de un jugador del game_state de Prolog
// Devuelve array de strings como ["oro-7", "espada-3", ...]
function obtenerMano(sala, playerId) {
    const field = playerId === "player1" ? "Mano1" : "Mano2";
    const r = sala.swipl.prolog.query(
        `game_state(estado(_, jugador(_,Mano1,_,_,_), jugador(_,Mano2,_,_,_), _, _))`
    ).once();
    if (!r || r.success !== true) return [];
    const mano = r[field];
    if (!Array.isArray(mano)) return [];
    return mano.map(c => {
        // c es PrologCompound { '-': [[palo, numero]] }
        const [palo, num] = c["-"][0];
        return `${palo}-${num}`;
    });
}

function obtenerMesa(sala) {
    const r = sala.swipl.prolog.query(
        `game_state(estado(_, _, _, Mesa, _))`
    ).once();
    if (!r || r.success !== true) return [];
    if (!Array.isArray(r.Mesa)) return [];
    return r.Mesa.map(c => {
        const [palo, num] = c["-"][0];
        return `${palo}-${num}`;
    });
}

// ───────────────────────────────────────────────────────────────
// Agente IA
// ───────────────────────────────────────────────────────────────

// Pide a Gemini que elija una carta dada la mano y la mesa.
// Devuelve un string tipo "oro-7" o null si falla.
async function pedirCartaAGemini(mano, mesa, nombreHumano) {
    if (!GEMINI_API_KEY) {
        console.warn("[IA] GEMINI_API_KEY no configurada, usando fallback");
        return null;
    }

    const valorDesc = "1→1, 2→2, 3→3, 4→4, 5→5, 6→6, 7→7, 10→8, 11→9, 12→10";
    const prompt = [
        `Sos un jugador de Escoba de 15, un juego de cartas argentino.`,
        `Jugas contra ${nombreHumano || "un humano"}.`,
        ``,
        `Reglas clave:`,
        `- Los palos son: oro, espada, basto, copa`,
        `- Valores de cartas: ${valorDesc}`,
        `- Podés capturar cartas de la mesa si tu carta + las cartas elegidas suman exactamente 15`,
        `- Si la mesa queda vacía después de capturar, es una "escoba" (+1 punto)`,
        `- Si no podés capturar, la carta se coloca en la mesa`,
        ``,
        `Tu mano: ${mano.join(", ")}`,
        `Mesa actual: ${mesa.length ? mesa.join(", ") : "(vacía)"}`,
        ``,
        `Respondé ÚNICAMENTE con una carta de tu mano en formato palo-numero.`,
        `Ejemplos válidos: oro-7, espada-3, copa-10, basto-1`,
        `No escribas nada más, solo la carta.`,
    ].join("\n");

    try {
        const res = await fetch(GEMINI_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY,
            },
            body: JSON.stringify({
                model: GEMINI_MODEL,
                messages: [{ role: "user", content: prompt }],
            }),
        });

        if (!res.ok) {
            console.error(`[IA] Gemini HTTP ${res.status}`);
            return null;
        }

        const data = await res.json();
        const respuesta = data?.choices?.[0]?.message?.content?.trim().toLowerCase();
        console.log(`[IA] Gemini respondio: "${respuesta}"`);
        return respuesta || null;
    } catch (err) {
        console.error("[IA] Error llamando a Gemini:", err.message);
        return null;
    }
}

// Valida que la carta sugerida por Gemini exista y esté en la mano
function validarCartaIA(sala, cartaStr, mano) {
    if (!cartaStr) return false;
    // Normalizar: quitar punto final si viene, minusculas
    const limpia = cartaStr.replace(/\.$/, "").trim();
    if (!mano.includes(limpia)) return false;
    // Verificar que Prolog también la reconoce como carta válida
    return prologCheck(sala, `carta(${limpia})`);
}

// Obtiene la carta fallback de Prolog
function cartaFallback(sala, playerId) {
    const mano = obtenerMano(sala, playerId);
    const mesa = obtenerMesa(sala);
    if (!mano.length) return null;

    const manoProlog = `[${mano.join(",")}]`;
    const mesaProlog = mesa.length ? `[${mesa.join(",")}]` : `[]`;

    const r = sala.swipl.prolog.query(
        `elegir_carta_fallback(${manoProlog}, ${mesaProlog}, C), carta_a_atom(C, Atom)`
    ).once();

    if (r && r.success === true && r.Atom) {
        console.log(`[sala ${sala.id}] Fallback eligio: ${r.Atom}`);
        return r.Atom;
    }
    return mano[0]; // ultimo recurso absoluto
}

// Ejecuta el turno de la IA: pregunta a Gemini, valida con Prolog,
// cae a fallback si hace falta, y ejecuta la jugada.
async function ejecutarTurnoIA(sala) {
    const mano = obtenerMano(sala, "player2");
    const mesa = obtenerMesa(sala);

    if (!mano.length) {
        console.log(`[sala ${sala.id}] IA sin cartas, esperando reparticion`);
        return;
    }

    // Avisar al humano que la IA está pensando
    enviarTexto(sala, "player1", "La IA está pensando...");

    // Pequeña pausa para que se sienta más natural
    await new Promise(r => setTimeout(r, 800));

    const sugerencia = await pedirCartaAGemini(mano, mesa, sala.nombreHumano);
    let cartaElegida;

    if (validarCartaIA(sala, sugerencia, mano)) {
        cartaElegida = sugerencia.replace(/\.$/, "").trim();
        console.log(`[sala ${sala.id}] IA juega (Gemini): ${cartaElegida}`);
    } else {
        if (sugerencia) {
            console.warn(`[sala ${sala.id}] Gemini sugirió carta inválida: "${sugerencia}", usando fallback`);
        }
        cartaElegida = cartaFallback(sala, "player2");
        console.log(`[sala ${sala.id}] IA juega (fallback): ${cartaElegida}`);
    }

    // Anunciar al humano qué jugó la IA
    enviarTexto(sala, "player1", `La IA jugó: ${cartaElegida}`);

    // Ejecutar la jugada en Prolog
    prologCall(sala, `jugar_carta(player2, '${cartaElegida}.')`);
    repartirMensajesPendientes(sala);

    // Si después del turno de la IA vuelve a ser turno de la IA
    // (ej. repartición nueva donde la IA volvió a ser el siguiente),
    // volvemos a ejecutar. Esto no debería pasar normalmente pero lo
    // cubrimos para no dejar el juego trabado.
    const turno = sala.swipl.prolog.query(
        "game_state(estado(Turno, _, _, _, _))"
    ).once();
    if (turno && turno.Turno === "player2") {
        setTimeout(() => ejecutarTurnoIA(sala), 500);
    }
}

// ───────────────────────────────────────────────────────────────
// Logica de mensajes de jugadores humanos
// ───────────────────────────────────────────────────────────────

async function manejarMensaje(sala, playerId, texto) {
    const textoEscapado = texto.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const yaTieneNombre = prologCheck(sala, `player_name(${playerId}, _)`);

    if (!yaTieneNombre) {
        // Es el nombre del jugador
        if (sala.conIA && playerId === "player1") {
            sala.nombreHumano = texto;
        }
        prologCall(sala, `registrar_nombre(${playerId}, '${textoEscapado}')`);
        repartirMensajesPendientes(sala);

        // Si es sala con IA, registrar la IA como player2 automáticamente
        if (sala.conIA && playerId === "player1") {
            prologCall(sala, "registrar_nombre(player2, 'IA')");
            repartirMensajesPendientes(sala);
        }
    } else {
        // Es una jugada
        prologCall(sala, `jugar_carta(${playerId}, '${textoEscapado}')`);
        repartirMensajesPendientes(sala);

        // Si ahora le toca a la IA, ejecutar su turno
        if (sala.conIA) {
            const turno = sala.swipl.prolog.query(
                "game_state(estado(Turno, _, _, _, _))"
            ).once();
            if (turno && turno.Turno === "player2") {
                await ejecutarTurnoIA(sala);
            }
        }
    }
}

function manejarDesconexion(sala, playerId) {
    console.log(`[sala ${sala.id}] ${playerId} desconectado`);
    sala.sockets[playerId] = null;
    const otroId = playerId === "player1" ? "player2" : "player1";
    const otroWs = sala.sockets[otroId];
    if (!sala.conIA && otroWs && otroWs.readyState === otroWs.OPEN) {
        prologCall(sala, `notificar_desconexion(${playerId})`);
        repartirMensajesPendientes(sala);
        setTimeout(() => otroWs.close(1000, "El otro jugador se desconecto"), 200);
    }
    destruirSala(sala);
}

// ───────────────────────────────────────────────────────────────
// WebSocket
// ───────────────────────────────────────────────────────────────

function configurarWs(wss) {
    wss.on("connection", async (ws, req) => {
        // Detectar si el jugador quiere IA via query param: /ws?ia=1
        const url = new URL(req.url, "http://localhost");
        const quiereIA = url.searchParams.get("ia") === "1";

        let sala, playerId;

        try {
            if (quiereIA) {
                // Sala exclusiva para este jugador + IA
                sala = await crearSala(true);
                playerId = "player1";
                sala.sockets.player1 = ws;
            } else if (salaEsperando) {
                sala = salaEsperando;
                playerId = "player2";
                salaEsperando = null;
                sala.sockets.player2 = ws;
                console.log(`[sala ${sala.id}] player2 se unio`);
            } else {
                sala = await crearSala(false);
                playerId = "player1";
                salaEsperando = sala;
                sala.sockets.player1 = ws;
                console.log(`[sala ${sala.id}] player1 esperando rival`);
            }
        } catch (err) {
            console.error("Error al asignar sala:", err);
            ws.close(1011, "Error interno");
            return;
        }

        ws.send(`ROL:${playerId}`);
        ws.send("Envia tu nombre:");

        ws.on("message", async (data) => {
            await manejarMensaje(sala, playerId, data.toString().trim());
        });

        ws.on("close", () => {
            if (!salas.has(sala.id)) return;
            manejarDesconexion(sala, playerId);
        });
    });
}

// ───────────────────────────────────────────────────────────────
// Servidor de archivos estaticos
// ───────────────────────────────────────────────────────────────

const MIME_TYPES = {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml", ".json": "application/json",
};

function servirArchivoEstatico(req, res) {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(WEBAPP_DIR, urlPath);
    if (!filePath.startsWith(WEBAPP_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("No encontrado"); return; }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
    });
}

// ───────────────────────────────────────────────────────────────
// PUNTO DE ENTRADA
// ───────────────────────────────────────────────────────────────

async function main() {
    if (!GEMINI_API_KEY) {
        console.warn("[server] GEMINI_API_KEY no configurada — la IA usara solo fallback Prolog");
    }

    const httpServer = http.createServer(servirArchivoEstatico);
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    configurarWs(wss);

    const PORT = process.env.PORT || 8000;
    httpServer.listen(PORT, () => {
        console.log(`[server] Escuchando en puerto ${PORT}`);
        console.log(`[server] Webapp: http://localhost:${PORT}/`);
        console.log(`[server] WebSocket: ws://localhost:${PORT}/ws`);
        console.log(`[server] IA: ws://localhost:${PORT}/ws?ia=1`);
    });
}

main().catch(err => { console.error("Error fatal:", err); process.exit(1); });