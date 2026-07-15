%--------------------------------------------------------------
%-------------------------- LIBRERIAS -------------------------
%--------------------------------------------------------------
:- use_module(library(lists)).

%--------------------------------------------------------------
%----------------------- ESTADO GLOBAL ------------------------
%--------------------------------------------------------------

:- dynamic player_name/2.
:- dynamic game_state/1.
:- dynamic mensaje_saliente/2.

% jugador/5: jugador(Nombre, Mano, Pozo, Puntos, Escobas)

%--------------------------------------------------------------
%--------------------------- CARTA ----------------------------
%--------------------------------------------------------------

carta(Palo-Numero) :-
    member(Palo, [oro, espada, basto, copa]),
    member(Numero, [12,11,10,7,6,5,4,3,2,1]).

valor_carta(C, V) :- carta(C), valor_carta_(C, V).

valor_carta_(_-1,  1).
valor_carta_(_-2,  2).
valor_carta_(_-3,  3).
valor_carta_(_-4,  4).
valor_carta_(_-5,  5).
valor_carta_(_-6,  6).
valor_carta_(_-7,  7).
valor_carta_(_-10, 8).
valor_carta_(_-11, 9).
valor_carta_(_-12, 10).

%--------------------------------------------------------------
%--------------------------- MAZO -----------------------------
%--------------------------------------------------------------

crear_mazo(Mazo) :-
    findall(Palo-Numero, carta(Palo-Numero), Mazo).

mezclar([], []).
mezclar(Lista, [Elem|Mezclada]) :-
    length(Lista, Len),
    Len > 0,
    random_between(1, Len, Index),
    nth1(Index, Lista, Elem),
    select(Elem, Lista, Resto),
    mezclar(Resto, Mezclada).

%--------------------------------------------------------------
%------------------- API PARA NODE.JS -------------------------
%--------------------------------------------------------------

reiniciar_juego :-
    retractall(player_name(_, _)),
    retractall(game_state(_)),
    retractall(mensaje_saliente(_, _)).

registrar_nombre(PlayerID, Nombre) :-
    assert(player_name(PlayerID, Nombre)),
    encolar_mensaje(PlayerID, 'Nombre registrado. Esperando al otro jugador...'),
    check_and_start_game.

check_and_start_game :-
    player_name(player1, _),
    player_name(player2, _),
    !,
    encolar_mensaje(player1, 'Ambos jugadores listos. Comenzando juego...'),
    encolar_mensaje(player2, 'Ambos jugadores listos. Comenzando juego...'),
    start_game.
check_and_start_game.

start_game :-
    player_name(player1, N1),
    player_name(player2, N2),
    crear_mazo(Mazo),
    mezclar(Mazo, MazoMezclado),
    MazoMezclado = [C1,C2,C3,C4,C5,C6|RestoMazo],
    Mano1 = [C1,C3,C5],
    Mano2 = [C2,C4,C6],
    RestoMazo = [M1,M2,M3,M4|MazoFinal],
    MesaInicial = [M1,M2,M3,M4],
    verificar_escoba_mazo(MesaInicial, PtsMesa),
    ( PtsMesa > 0 ->
        Pts1i = 0, Pts2i = PtsMesa,
        Esc1i = 0, Esc2i = 1,
        Pozo1i = [], Pozo2i = MesaInicial,
        MesaFinal = [],
        ( PtsMesa =:= 2 -> TextoPts = '2 puntos' ; TextoPts = '1 punto' ),
        format_cartas(MesaInicial, MesaStr),
        atomic_list_concat([
            '\u00a1La mesa suma 15 o 30! Escoba de mesa: ', MesaStr, '.\n',
            'Esas cartas van al pozo de ', N2, ' (el repartidor), que suma ', TextoPts, '.'
        ], MsgEscobaMesa),
        encolar_mensaje(player1, MsgEscobaMesa),
        encolar_mensaje(player2, MsgEscobaMesa)
    ;
        Pts1i = 0, Pts2i = 0,
        Esc1i = 0, Esc2i = 0,
        Pozo1i = [], Pozo2i = [],
        MesaFinal = MesaInicial
    ),
    J1 = jugador(N1, Mano1, Pozo1i, Pts1i, Esc1i),
    J2 = jugador(N2, Mano2, Pozo2i, Pts2i, Esc2i),
    Estado = estado(player1, J1, J2, MesaFinal, MazoFinal),
    assert(game_state(Estado)),
    enviar_estado_a_todos(Estado),
    encolar_mensaje(player2, 'Esperando turno de Jugador 1...').

jugar_carta(PlayerID, TextoCarta) :-
    ( \+ game_state(_) ->
        encolar_mensaje(PlayerID, 'Todavia no comenzo la partida.')
    ; game_state(estado(fin, _, _, _, _)) ->
        encolar_mensaje(PlayerID, 'El juego ya termino.')
    ; game_state(estado(TurnoActual, _, _, _, _)), TurnoActual \== PlayerID ->
        encolar_mensaje(PlayerID, 'No es tu turno. Espera...')
    ;
        parse_carta(TextoCarta, Carta),
        ( Carta == invalid ->
            encolar_mensaje(PlayerID, 'Formato invalido. Usa palo-numero. (ej: oro-7.)')
        ;
            process_turn(PlayerID, Carta)
        )
    ).

parse_carta(Texto, Carta) :-
    ( atom(Texto) -> TextoAtomo = Texto ; atom_string(TextoAtomo, Texto) ),
    ( sub_atom(TextoAtomo, _, 1, 0, '.') -> TextoConPunto = TextoAtomo
    ; atom_concat(TextoAtomo, '.', TextoConPunto) ),
    ( catch(atom_to_term(TextoConPunto, CartaParseada, []), _, fail),
      carta(CartaParseada)
    ->
        Carta = CartaParseada
    ;
        Carta = invalid
    ).

sacar_mensajes_pendientes(Lineas) :-
    findall(PlayerID-Texto, mensaje_saliente(PlayerID, Texto), Pares),
    retractall(mensaje_saliente(_, _)),
    maplist(par_a_linea, Pares, Lineas).

par_a_linea(PlayerID-Texto, Linea) :-
    atomic_list_concat([PlayerID, '\u0001', Texto], Linea).

notificar_desconexion(PlayerID) :-
    ( PlayerID == player1 -> Otro = player2 ; Otro = player1 ),
    encolar_mensaje(Otro, 'El otro jugador se desconecto. El juego ha terminado.').

%--------------------------------------------------------------
%------------------ PROCESAMIENTO DE TURNO ------------------
%--------------------------------------------------------------

process_turn(PlayerID, Carta) :-
    retract(game_state(Estado)),
    Estado = estado(PlayerID, J1, J2, Mesa, Mazo),
    ( PlayerID == player1 -> JActivo = J1, JEspera = J2
    ; JActivo = J2, JEspera = J1 ),
    JActivo = jugador(N, Mano, Pozo, Pts, Escobas),
    ( select(Carta, Mano, ManoNueva)
    ->
        ( puede_levantar(Carta, Mesa, Levantadas)
        ->
            append([Carta|Levantadas], Pozo, PozoNuevo),
            sacar_cartas(Levantadas, Mesa, MesaTemp),
            ( MesaTemp = [] ->
                PtsNuevo is Pts + 1,
                EscobasNuevo is Escobas + 1,
                encolar_mensaje(PlayerID, 'Escoba! +1 punto.')
            ;
                PtsNuevo = Pts,
                EscobasNuevo = Escobas
            ),
            format_cartas(Levantadas, LevStr),
            atomic_list_concat(['Levantaste: ', LevStr], MsgLev),
            encolar_mensaje(PlayerID, MsgLev),
            JActivoNuevo = jugador(N, ManoNueva, PozoNuevo, PtsNuevo, EscobasNuevo),
            MesaNueva = MesaTemp
        ;
            encolar_mensaje(PlayerID, 'No suma 15. Carta colocada en la mesa.'),
            JActivoNuevo = jugador(N, ManoNueva, Pozo, Pts, Escobas),
            MesaNueva = [Carta|Mesa]
        ),
        ( PlayerID == player1 ->
            J1Nuevo = JActivoNuevo, J2Nuevo = JEspera
        ;
            J1Nuevo = JEspera, J2Nuevo = JActivoNuevo
        ),
        J1Nuevo = jugador(_, Mano1Nuevo, _, _, _),
        J2Nuevo = jugador(_, Mano2Nuevo, _, _, _),
        siguiente_estado(PlayerID, J1Nuevo, J2Nuevo, Mano1Nuevo, Mano2Nuevo, MesaNueva, Mazo, EstadoNuevo),
        assert(game_state(EstadoNuevo)),
        EstadoNuevo = estado(SiguienteTurno, _, _, _, _),
        ( SiguienteTurno == fin ->
            true
        ;
            enviar_estado_a_todos(EstadoNuevo),
            ( SiguienteTurno == player1 -> OtroPlayer = player2 ; OtroPlayer = player1 ),
            encolar_mensaje(OtroPlayer, 'Esperando turno del otro jugador...')
        )
    ;
        assert(game_state(Estado)),
        encolar_mensaje(PlayerID, 'Esa carta no esta en tu mano. Intenta de nuevo.')
    ).

siguiente_estado(TurnoActual, J1, J2, Mano1, Mano2, Mesa, Mazo, EstadoNuevo) :-
    ( TurnoActual == player1 -> SiguienteTurno = player2 ; SiguienteTurno = player1 ),
    ( Mano1 = [], Mano2 = [] ->
        ( Mazo = [] ->
            EstadoNuevo = estado(fin, J1, J2, Mesa, []),
            finalizar_juego(J1, J2, Mesa)
        ;
            repartir_nuevas(J1, J2, Mazo, J1b, J2b, MazoNuevo),
            EstadoNuevo = estado(SiguienteTurno, J1b, J2b, Mesa, MazoNuevo)
        )
    ;
        EstadoNuevo = estado(SiguienteTurno, J1, J2, Mesa, Mazo)
    ).

repartir_nuevas(J1, J2, Mazo, J1Nuevo, J2Nuevo, MazoNuevo) :-
    J1 = jugador(N1, _, Pozo1, Pts1, Esc1),
    J2 = jugador(N2, _, Pozo2, Pts2, Esc2),
    ( Mazo = [A,B,C,D,E,F|Resto] ->
        J1Nuevo = jugador(N1, [A,C,E], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [B,D,F], Pozo2, Pts2, Esc2),
        MazoNuevo = Resto
    ; Mazo = [A,B,C,D,E] ->
        J1Nuevo = jugador(N1, [A,C,E], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [B,D], Pozo2, Pts2, Esc2),
        MazoNuevo = []
    ; Mazo = [A,B,C,D] ->
        J1Nuevo = jugador(N1, [A,C], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [B,D], Pozo2, Pts2, Esc2),
        MazoNuevo = []
    ; Mazo = [A,B,C] ->
        J1Nuevo = jugador(N1, [A,C], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [B], Pozo2, Pts2, Esc2),
        MazoNuevo = []
    ; Mazo = [A,B] ->
        J1Nuevo = jugador(N1, [A], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [B], Pozo2, Pts2, Esc2),
        MazoNuevo = []
    ; Mazo = [A] ->
        J1Nuevo = jugador(N1, [A], Pozo1, Pts1, Esc1),
        J2Nuevo = jugador(N2, [], Pozo2, Pts2, Esc2),
        MazoNuevo = []
    ;
        J1Nuevo = J1, J2Nuevo = J2, MazoNuevo = []
    ),
    encolar_mensaje(player1, 'Se repartieron nuevas cartas.'),
    encolar_mensaje(player2, 'Se repartieron nuevas cartas.').

%--------------------------------------------------------------
%-------------------- FIN DEL JUEGO -------------------------
%--------------------------------------------------------------

finalizar_juego(J1, J2, Mesa) :-
    J1 = jugador(N1, _, Pozo1, Pts1, Esc1),
    J2 = jugador(N2, _, Pozo2, Pts2, Esc2),
    append(Mesa, Pozo1, Pozo1Final),
    J1f = jugador(N1, [], Pozo1Final, Pts1, Esc1),
    J2f = jugador(N2, [], Pozo2,     Pts2, Esc2),
    ganadores_cartas(J1f, J2f, GanCartas),
    ganadores_oros(J1f, J2f, GanOros),
    ganadores_sietes(J1f, J2f, GanSietes),
    aplicar_puntos(J1f, GanCartas, GanOros, GanSietes, J1Final),
    aplicar_puntos(J2f, GanCartas, GanOros, GanSietes, J2Final),
    J1Final = jugador(_, _, _, PF1, _),
    J2Final = jugador(_, _, _, PF2, _),
    desglose_puntos(J1Final, Esc1, GanCartas, GanOros, GanSietes, Desglose1),
    desglose_puntos(J2Final, Esc2, GanCartas, GanOros, GanSietes, Desglose2),
    atomic_list_concat([
        '\n=== Resultado final ===\n',
        Desglose1, '\n',
        Desglose2
    ], ResumenTotal),
    encolar_mensaje(player1, ResumenTotal),
    encolar_mensaje(player2, ResumenTotal),
    ( PF1 > PF2 ->
        atomic_list_concat(['\nFelicitaciones ', N1, ', ganaste con ', PF1, ' puntos contra ', PF2, ' de ', N2, '!'], MsgP1),
        atomic_list_concat(['\n', N1, ' gano con ', PF1, ' puntos. Vos hiciste ', PF2, '. Mas suerte la proxima!'], MsgP2)
    ; PF2 > PF1 ->
        atomic_list_concat(['\n', N2, ' gano con ', PF2, ' puntos. Vos hiciste ', PF1, '. Mas suerte la proxima!'], MsgP1),
        atomic_list_concat(['\nFelicitaciones ', N2, ', ganaste con ', PF2, ' puntos contra ', PF1, ' de ', N1, '!'], MsgP2)
    ;
        atomic_list_concat(['\nEmpate entre ', N1, ' y ', N2, ' con ', PF1, ' puntos cada uno!'], MsgEmpate),
        MsgP1 = MsgEmpate, MsgP2 = MsgEmpate
    ),
    encolar_mensaje(player1, MsgP1),
    encolar_mensaje(player2, MsgP2).

aplicar_puntos(jugador(N, Mano, Pozo, Pts, Esc), GanCartas, GanOros, GanSietes,
               jugador(N, Mano, Pozo, PtsFinal, Esc)) :-
    ( member(N, GanCartas) -> P1 = 1 ; P1 = 0 ),
    ( member(N, GanOros)   -> P2 = 1 ; P2 = 0 ),
    ( member(oro-7, Pozo)  -> P3 = 1 ; P3 = 0 ),
    ( member(N, GanSietes) -> P4 = 1 ; P4 = 0 ),
    PtsFinal is Pts + P1 + P2 + P3 + P4.

desglose_puntos(jugador(N, _, Pozo, PtsFinal, _), PtsEscobas, GanCartas, GanOros, GanSietes, Desglose) :-
    length(Pozo, CantCartas),
    contar_oros(Pozo, CantOros),
    contar_sietes(Pozo, CantSietes),
    ( member(N, GanCartas)  -> LineaCartas  = '  + 1 punto: mayoria de cartas\n'  ; LineaCartas  = '' ),
    ( member(N, GanOros)    -> LineaOros    = '  + 1 punto: mayoria de oros\n'    ; LineaOros    = '' ),
    ( member(oro-7, Pozo)   -> Linea7Oro    = '  + 1 punto: tiene el 7 de oro\n'  ; Linea7Oro    = '' ),
    ( member(N, GanSietes)  -> LineaSietes  = '  + 1 punto: mayoria de sietes\n'  ; LineaSietes  = '' ),
    atomic_list_concat([
        N, ' -- Total: ', PtsFinal, ' puntos\n',
        '  + ', PtsEscobas, ' punto/s por escobas durante la partida\n',
        LineaCartas, LineaOros, Linea7Oro, LineaSietes,
        '  Cartas en pozo: ', CantCartas, ' | Oros: ', CantOros, ' | Sietes: ', CantSietes
    ], Desglose).

%--------------------------------------------------------------
%------------------ CALCULO DE PUNTOS FINALES ----------------
%--------------------------------------------------------------

ganadores_cartas(jugador(N1,_,P1,_,_), jugador(N2,_,P2,_,_), Ganadores) :-
    length(P1, C1), length(P2, C2),
    ( C1 > C2 -> Ganadores = [N1] ; C2 > C1 -> Ganadores = [N2] ; Ganadores = [N1, N2] ).

ganadores_oros(jugador(N1,_,P1,_,_), jugador(N2,_,P2,_,_), Ganadores) :-
    contar_oros(P1, O1), contar_oros(P2, O2),
    ( O1 > O2 -> Ganadores = [N1] ; O2 > O1 -> Ganadores = [N2] ; Ganadores = [N1, N2] ).

ganadores_sietes(jugador(N1,_,P1,_,_), jugador(N2,_,P2,_,_), Ganadores) :-
    contar_sietes(P1, S1), contar_sietes(P2, S2),
    ( S1 > S2 -> Ganadores = [N1] ; S2 > S1 -> Ganadores = [N2] ; Ganadores = [N1, N2] ).

contar_oros([], 0).
contar_oros([Palo-_|Cs], N) :- Palo \= oro, contar_oros(Cs, N).
contar_oros([oro-_|Cs], N) :- contar_oros(Cs, N1), N is N1 + 1.

contar_sietes([], 0).
contar_sietes([_-7|Cs], N) :- contar_sietes(Cs, N1), N is N1 + 1.
contar_sietes([_-Num|Cs], N) :- Num \= 7, contar_sietes(Cs, N).

%--------------------------------------------------------------
%------------------- LOGICA DEL JUEGO ------------------------
%--------------------------------------------------------------

verificar_escoba_mazo(Mesa, Puntos) :-
    suma_cartas(Mesa, Total),
    ( Total =:= 15 -> Puntos = 1 ; Total =:= 30 -> Puntos = 2 ; Puntos = 0 ).

puede_levantar(Carta, Mesa, Levantadas) :-
    valor_carta(Carta, VC),
    subconjunto(Mesa, Levantadas),
    Levantadas \= [],
    suma_cartas(Levantadas, SM),
    VC + SM =:= 15.

subconjunto([], []).
subconjunto([X|Xs], [X|Ys]) :- subconjunto(Xs, Ys).
subconjunto([_|Xs], Ys)     :- subconjunto(Xs, Ys).

suma_cartas([], 0).
suma_cartas([C|Cs], S) :-
    valor_carta(C, V),
    suma_cartas(Cs, S1),
    S is V + S1.

sacar_cartas([], Mesa, Mesa).
sacar_cartas([C|Cs], Mesa, MesaFinal) :-
    select(C, Mesa, MesaRestante),
    sacar_cartas(Cs, MesaRestante, MesaFinal).

%--------------------------------------------------------------
%------------------- ENVIO DE MENSAJES -----------------------
%--------------------------------------------------------------

enviar_estado_a_todos(Estado) :-
    construir_estado_msg(player1, Estado, Msg1),
    construir_estado_msg(player2, Estado, Msg2),
    encolar_mensaje(player1, Msg1),
    encolar_mensaje(player2, Msg2).

construir_estado_msg(PlayerID, Estado, Msg) :-
    Estado = estado(Turno, J1, J2, Mesa, Mazo),
    ( PlayerID == player1 -> MiJugador = J1, RivalJugador = J2
    ; MiJugador = J2, RivalJugador = J1 ),
    MiJugador    = jugador(N,      Mano, PozoMio,   Pts,      _),
    RivalJugador = jugador(NRival, _,    PozoRival, PtsRival, _),
    length(PozoMio,   CantPozoMio),
    length(PozoRival, CantPozoRival),
    format_cartas(Mano, ManoStr),
    format_cartas(Mesa, MesaStr),
    length(Mazo, CartasRestantes),
    ( Turno == PlayerID ->
        TurnoMsg = 'ES TU TURNO. Ingresa una carta (ej: oro-7.):'
    ; Turno == fin ->
        TurnoMsg = 'El juego ha terminado.'
    ;
        TurnoMsg = 'Esperando turno del otro jugador...'
    ),
    atomic_list_concat([
        '\n--- Estado del juego ---\n',
        'Jugador: ', N,      ' | Puntos: ', Pts,      ' | Pozo: ', CantPozoMio,   '\n',
        'Rival: ',   NRival, ' | Puntos: ', PtsRival, ' | Pozo: ', CantPozoRival, '\n',
        'Tu mano: ', ManoStr, '\n',
        'Mesa:    ', MesaStr, '\n',
        'Cartas en mazo: ', CartasRestantes, '\n',
        TurnoMsg
    ], Msg).

encolar_mensaje(PlayerID, Msg) :-
    ( atom(Msg) -> MsgAtom = Msg ; atomic_list_concat([Msg], MsgAtom) ),
    assert(mensaje_saliente(PlayerID, MsgAtom)).

format_cartas([], '[]').
format_cartas(Cartas, Str) :-
    Cartas \= [],
    maplist(carta_a_atom, Cartas, Atoms),
    atomic_list_concat(Atoms, ', ', Str).

carta_a_atom(Palo-Num, Atom) :-
    atomic_list_concat([Palo, '-', Num], Atom).

%--------------------------------------------------------------
%------------- FALLBACK PARA AGENTE IA -----------------------
%--------------------------------------------------------------

elegir_carta_fallback(Mano, Mesa, Carta) :-
    % Prioridad 1: escoba
    member(Carta, Mano),
    puede_levantar(Carta, Mesa, Levantadas),
    sacar_cartas(Levantadas, Mesa, []),
    !.
elegir_carta_fallback(Mano, Mesa, Carta) :-
    % Prioridad 2: cualquier captura
    member(Carta, Mano),
    puede_levantar(Carta, Mesa, _),
    !.
elegir_carta_fallback(Mano, _Mesa, Carta) :-
    % Prioridad 3: menor valor
    maplist(valor_carta, Mano, Valores),
    min_list(Valores, MinVal),
    nth1(Idx, Valores, MinVal),
    nth1(Idx, Mano, Carta),
    !.
elegir_carta_fallback([Carta|_], _, Carta).