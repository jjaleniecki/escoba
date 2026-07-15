// ═══════════════════════════════════════════════════════════════
// bridge_ws.js
// Cliente WebSocket. Ya no hay puertos separados por jugador:
// el servidor asigna el rol (player1/player2) automaticamente
// segun el orden de conexion, y lo comunica con el mensaje
// "ROL:playerX" al conectarse.
// ═══════════════════════════════════════════════════════════════

let socket = null;
let estadoFinalRecibido = false;
let desglosePendiente = null;
let rolConfirmado = false;
let colaAntesDeLrol = []; // mensajes que llegaron antes de confirmar el rol

// ───────────────────────────────────────────────────────────────
// Conexion
// ───────────────────────────────────────────────────────────────

function conectar(modoIA = false) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sufijo = modoIA ? "?ia=1" : "";
    const url = `${proto}//${location.host}/ws${sufijo}`;

    rolConfirmado = false;
    colaAntesDeLrol = [];

    window.log(`Conectando${modoIA ? " (modo IA)" : ""}...`, 'info');
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
        window.log('Conectado al servidor. Esperando asignacion de rol...', 'info');
    });

    socket.addEventListener('message', (event) => {
        manejarMensaje(event.data);
    });

    socket.addEventListener('close', () => {
        window.log('Conexion con el servidor cerrada.', 'descarte');
        window.onConexionPerdida && window.onConexionPerdida();
    });

    socket.addEventListener('error', () => {
        window.log('Error de conexion con el servidor.', 'descarte');
    });
}

function enviarMensaje(texto) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(texto);
}
function enviarNombre(nombre) { enviarMensaje(nombre); }
window.enviarCartaAlServidor = function(carta) { enviarMensaje(carta + "."); };

// ───────────────────────────────────────────────────────────────
// Procesamiento de mensajes entrantes
// ───────────────────────────────────────────────────────────────

function manejarMensaje(texto) {
    // ROL siempre se procesa primero, sin importar nada
    if (texto.startsWith('ROL:')) {
        const rol = texto.slice(4).trim();
        const num = rol === 'player1' ? 1 : 2;
        rolConfirmado = true;
        window.onRolAsignado && window.onRolAsignado(num);
        // Procesar mensajes que llegaron antes de confirmar el rol
        const pendientes = colaAntesDeLrol.splice(0);
        pendientes.forEach(manejarMensaje);
        return;
    }

    // Si el rol todavia no fue confirmado, encolar y esperar
    if (!rolConfirmado) {
        colaAntesDeLrol.push(texto);
        return;
    }

    if (texto.includes('Envia tu nombre:')) {
        window.onPedirNombre && window.onPedirNombre();
        return;
    }

    if (texto.includes('Esperando al otro jugador')) {
        window.log('Esperando al otro jugador...', 'info');
        return;
    }

    if (texto.includes('Ambos jugadores listos')) {
        window.onJuegoListo && window.onJuegoListo();
        window.log('¡Comienza la partida!', 'info');
        return;
    }

    if (texto.includes('--- Estado del juego ---')) {
        const estado = parsearEstado(texto);
        window.renderizarTablero && window.renderizarTablero(estado);
        return;
    }

    if (texto.includes('=== Resultado final ===')) {
        desglosePendiente = parsearDesglose(texto);
        return;
    }

    if (texto.includes('Felicitaciones') || texto.includes('Empate entre') || /gan[oó] con/.test(texto)) {
        window.onFinDePartida && window.onFinDePartida(texto, desglosePendiente);
        desglosePendiente = null;
        return;
    }

    if (texto.includes('Escoba de mesa')) {
        window.log(texto.replace('¡', '🧹 ¡'), 'escoba');
        return;
    }

    if (texto.includes('Escoba!')) {
        window.log('¡Escoba! Mesa barrida.', 'escoba');
        window.mostrarEscobaFlash && window.mostrarEscobaFlash();
        return;
    }

    if (texto.includes('El otro jugador se desconecto') || texto.includes('desconecto')) {
        window.onRivalDesconectado && window.onRivalDesconectado();
        return;
    }

    if (texto.trim().length > 0) {
        window.log(texto.trim(), 'info');
    }
}

// ───────────────────────────────────────────────────────────────
// Parseo del bloque "--- Estado del juego ---"
// ───────────────────────────────────────────────────────────────
//
// Jugador: <nombre> | Puntos: <n> | Pozo: <n>
// Rival: <nombre> | Puntos: <n> | Pozo: <n>
// Tu mano: ...   Mesa: ...   Cartas en mazo: <n>

function parsearEstado(texto) {
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const datos = {
        nombre: null, nombreRival: null, puntos: 0, puntosRival: 0,
        pozoMio: 0, pozoRival: 0,
        mano: [], mesa: [], mazoRestante: 0,
        esMiTurno: false, juegoTerminado: false,
    };
    for (const linea of lineas) {
        if (linea.startsWith('Jugador:')) {
            const m = linea.match(/Jugador:\s*(.+?)\s*\|\s*Puntos:\s*(\d+)\s*\|\s*Pozo:\s*(\d+)/);
            if (m) { datos.nombre = m[1]; datos.puntos = parseInt(m[2], 10); datos.pozoMio = parseInt(m[3], 10); }
        } else if (linea.startsWith('Rival:')) {
            const m = linea.match(/Rival:\s*(.+?)\s*\|\s*Puntos:\s*(\d+)\s*\|\s*Pozo:\s*(\d+)/);
            if (m) { datos.nombreRival = m[1]; datos.puntosRival = parseInt(m[2], 10); datos.pozoRival = parseInt(m[3], 10); }
        } else if (linea.startsWith('Tu mano:')) {
            datos.mano = parsearListaCartas(linea.replace('Tu mano:', ''));
        } else if (linea.startsWith('Mesa:')) {
            datos.mesa = parsearListaCartas(linea.replace('Mesa:', ''));
        } else if (linea.startsWith('Cartas en mazo:')) {
            const m = linea.match(/Cartas en mazo:\s*(\d+)/);
            if (m) datos.mazoRestante = parseInt(m[1], 10);
        } else if (linea.includes('ES TU TURNO')) {
            datos.esMiTurno = true;
        } else if (linea.includes('El juego ha terminado')) {
            datos.juegoTerminado = true;
        }
    }
    return datos;
}

function parsearListaCartas(str) {
    const s = str.trim();
    if (!s || s === '[]') return [];
    return s.split(',').map(c => c.trim()).filter(c => c.length > 0);
}

// ───────────────────────────────────────────────────────────────
// Parseo del bloque "=== Resultado final ==="
// ───────────────────────────────────────────────────────────────
// Formato que manda logica.pl (desglose_puntos/6):
//
// === Resultado final ===
// Ana -- Total: 4 puntos
//   + 2 punto/s por escobas durante la partida
//   + 1 punto: mayoria de cartas
//   Cartas en pozo: 22 | Oros: 5 | Sietes: 2
//
// Beto -- Total: 3 puntos
//   ...

function parsearDesglose(texto) {
    const jugadores = [];
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    let jugadorActual = null;

    for (const linea of lineas) {
        if (linea.includes('Resultado final')) continue;

        // Linea de nombre y total: "Ana -- Total: 4 puntos"
        const mNombre = linea.match(/^(.+?)\s*--\s*Total:\s*(\d+)/);
        if (mNombre) {
            jugadorActual = {
                nombre: mNombre[1].trim(),
                total: parseInt(mNombre[2], 10),
                detalles: [],
                cartas: 0, oros: 0, sietes: 0,
            };
            jugadores.push(jugadorActual);
            continue;
        }

        if (!jugadorActual) continue;

        // Linea de stats: "Cartas en pozo: 22 | Oros: 5 | Sietes: 2"
        const mStats = linea.match(/Cartas en pozo:\s*(\d+)\s*\|\s*Oros:\s*(\d+)\s*\|\s*Sietes:\s*(\d+)/);
        if (mStats) {
            jugadorActual.cartas  = parseInt(mStats[1], 10);
            jugadorActual.oros    = parseInt(mStats[2], 10);
            jugadorActual.sietes  = parseInt(mStats[3], 10);
            continue;
        }

        // Cualquier otra linea con "+" es un detalle de punto
        if (linea.startsWith('+')) {
            jugadorActual.detalles.push(linea.slice(1).trim());
        }
    }

    return jugadores;
}

// ───────────────────────────────────────────────────────────────
// API publica (llamada desde index.html)
// ───────────────────────────────────────────────────────────────

window.conectarAlServidor = conectar;
window.enviarNombreAlServidor = enviarNombre;