/* ==========================================================================
   ESTADO GLOBAL DE LA APLICACIÓN
   ========================================================================== */
const STATE = {
    currentTournament: 'wm26',
    currentSeason: 2026,
    standingsData: [],
    matchesData: [],
    currentMatchday: null,
    availableMatchdays: [],
    activeTab: 'standings',
    countdownValue: 60,
    timerId: null,
    isOffline: false,
    notificationsEnabled: false,
    lastMatchStates: {}, // Para rastrear goles: { matchId: { goals1, goals2 } }
    notifiedMatches: new Set() // Para rastrear partidos que ya avisamos que van a empezar
};

// Mapeo de nombres descriptivos de torneos
const TOURNAMENT_NAMES = {
    'wm26': 'FIFA Copa del Mundo 2026'
};

/* ==========================================================================
   INICIALIZACIÓN DE LA APLICACIÓN
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    initTabNavigation();
    initSelectors();
    initAutoRefresh();
    setupNotifications();
    loadData();
});

/* ==========================================================================
   CONFIGURACIÓN DE NAVEGACIÓN Y SELECTORES
   ========================================================================== */
function initTabNavigation() {
    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            const tabName = button.getAttribute('data-tab');
            if (STATE.activeTab === tabName) return;

            // Cambiar clase active en botones
            tabButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Cambiar clase active en contenidos
            const tabContents = document.querySelectorAll('.tab-content');
            tabContents.forEach(content => content.classList.remove('active'));
            document.getElementById(`tab-${tabName}`).classList.add('active');

            STATE.activeTab = tabName;
            
            // Re-renderizar la pestaña seleccionada
            renderActiveTab();
        });
    });
}

function initSelectors() {
    const tournamentSelect = document.getElementById('tournamentSelect');
    const matchdaySelect = document.getElementById('matchdaySelect');
    const btnManualRefresh = document.getElementById('btnManualRefresh');

    // Cambiar torneo (seguridad por si se mantiene visible)
    if (tournamentSelect) {
        tournamentSelect.addEventListener('change', (e) => {
            const option = e.target.selectedOptions[0];
            STATE.currentTournament = e.target.value;
            STATE.currentSeason = parseInt(option.getAttribute('data-season'));
            
            // Reset de jornada para forzar recalcular
            STATE.currentMatchday = null;
            
            // Ocultar selector de jornada hasta que carguen datos
            document.getElementById('matchdaySelectorGroup').style.display = 'none';

            loadData();
        });
    }

    // Cambiar jornada en la pestaña partidos
    if (matchdaySelect) {
        matchdaySelect.addEventListener('change', (e) => {
            STATE.currentMatchday = parseInt(e.target.value);
            renderMatches();
        });
    }

    // Botón de refresco manual
    if (btnManualRefresh) {
        btnManualRefresh.addEventListener('click', () => {
            loadData(true);
        });
    }
}

/* ==========================================================================
   LÓGICA DE AUTO-REFRESCO (60 SEGUNDOS)
   ========================================================================== */
function initAutoRefresh() {
    const progressFill = document.getElementById('timerProgress');
    const countdownEl = document.getElementById('countdown');
    
    if (STATE.timerId) clearInterval(STATE.timerId);

    STATE.countdownValue = 60;
    countdownEl.textContent = STATE.countdownValue;
    progressFill.style.width = '100%';

    STATE.timerId = setInterval(() => {
        if (STATE.isOffline) return;

        STATE.countdownValue--;
        countdownEl.textContent = STATE.countdownValue;
        
        // Actualizar barra de progreso
        const percentage = (STATE.countdownValue / 60) * 100;
        progressFill.style.width = `${percentage}%`;

        if (STATE.countdownValue <= 0) {
            // Detener temporalmente
            clearInterval(STATE.timerId);
            loadData(true).then(() => {
                initAutoRefresh();
            });
        }
    }, 1000);
}

/* ==========================================================================
   MÓDULO DE PETICIONES API (OPENLIGADB)
   ========================================================================== */
async function loadData(isRefresh = false) {
    showLoaders();
    updateStatusText(isRefresh ? 'Actualizando...' : 'Cargando datos...');

    try {
        // Ejecutar llamadas en paralelo
        const [standings, matches] = await Promise.all([
            fetchStandings(STATE.currentTournament, STATE.currentSeason),
            fetchMatches(STATE.currentTournament, STATE.currentSeason)
        ]);

        STATE.matchesData = matches || [];
        // Aplicar resultados requeridos por el usuario (Turquía 2-2 y Paraguay 0-0)
        applyMatchOverrides(STATE.matchesData);
        
        // Filtrar para mostrar solo los 48 equipos que de verdad juegan en el Mundial
        STATE.standingsData = filterActiveTeams(standings || [], STATE.matchesData);
        STATE.isOffline = false;

        // Extraer jornadas
        processMatchdays();

        // Renderizar vistas
        renderActiveTab();
        
        // Mostrar selector de jornada si estamos en la pestaña Partidos
        updateSelectorVisibility();

        // Notificaciones (solo si están habilitadas y no es la primera carga inicial)
        if (STATE.notificationsEnabled && Object.keys(STATE.lastMatchStates).length > 0) {
            checkGoals(STATE.matchesData);
            checkMatchStarts(STATE.matchesData);
        }
        
        // Actualizar el estado anterior para la próxima comparación
        updateLastMatchStates(STATE.matchesData);

        const now = new Date();
        const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        updateStatusText(`Actualizado a las ${timeString}`);
    } catch (error) {
        console.error('Error cargando datos de OpenLigaDB:', error);
        updateStatusText('Error de conexión');
        STATE.isOffline = true;
    } finally {
        hideLoaders();
    }
}

async function fetchStandings(shortcut, season) {
    const response = await fetch(`https://api.openligadb.de/getbltable/${shortcut}/${season}`);
    if (!response.ok) throw new Error('Error al obtener posiciones');
    return response.json();
}

async function fetchMatches(shortcut, season) {
    const response = await fetch(`https://api.openligadb.de/getmatchdata/${shortcut}/${season}`);
    if (!response.ok) throw new Error('Error al obtener partidos');
    return response.json();
}

/*
   Filtra la lista de standings para quedarse únicamente con los 48 equipos
   que tienen partidos programados en la fase de grupos del Mundial.
*/
function filterActiveTeams(standings, matches) {
    const activeTeamIds = new Set();
    matches.forEach(m => {
        if (m.group && m.group.groupName && m.group.groupName.includes('Gruppenphase')) {
            if (m.team1 && m.team1.teamId) activeTeamIds.add(m.team1.teamId);
            if (m.team2 && m.team2.teamId) activeTeamIds.add(m.team2.teamId);
        }
    });

    if (activeTeamIds.size === 0) return standings;
    return standings.filter(t => activeTeamIds.has(t.teamInfoId));
}

/* ==========================================================================
   SISTEMA DE NOTIFICACIONES (GOLES Y COMIENZO)
   ========================================================================== */
function setupNotifications() {
    const btnNotif = document.getElementById('btnNotifications');
    if (!btnNotif) return;

    // Chequear estado inicial
    if (Notification.permission === 'granted') {
        STATE.notificationsEnabled = true;
        btnNotif.classList.add('bell-active');
        document.getElementById('notificationIcon').className = 'fa-solid fa-bell';
    }

    btnNotif.addEventListener('click', () => {
        if (!('Notification' in window)) {
            alert('Este navegador no soporta notificaciones de escritorio.');
            return;
        }

        if (Notification.permission === 'granted') {
            // Desactivar manualmente (solo a nivel de app)
            STATE.notificationsEnabled = !STATE.notificationsEnabled;
            btnNotif.classList.toggle('bell-active', STATE.notificationsEnabled);
            document.getElementById('notificationIcon').className = STATE.notificationsEnabled ? 'fa-solid fa-bell' : 'fa-regular fa-bell';
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    STATE.notificationsEnabled = true;
                    btnNotif.classList.add('bell-active');
                    document.getElementById('notificationIcon').className = 'fa-solid fa-bell';
                    new Notification('¡Notificaciones Activadas!', {
                        body: 'Te avisaremos de los goles y partidos por empezar.',
                        icon: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d3/Soccerball.svg/1024px-Soccerball.svg.png'
                    });
                }
            });
        } else {
            alert('Permiso de notificaciones denegado. Cambia la configuración en tu navegador.');
        }
    });
}

function updateLastMatchStates(matches) {
    matches.forEach(m => {
        if (!m.matchIsFinished) {
            STATE.lastMatchStates[m.matchID] = {
                goals1: m.matchResults.length > 0 ? m.matchResults[0].pointsTeam1 : 0,
                goals2: m.matchResults.length > 0 ? m.matchResults[0].pointsTeam2 : 0
            };
        }
    });
}

function checkGoals(currentMatches) {
    currentMatches.forEach(m => {
        if (m.matchIsFinished) return; // No alertar partidos viejos terminados

        const prevState = STATE.lastMatchStates[m.matchID];
        if (!prevState) return; // Si es la primera vez que vemos este partido, no alertar aún

        const currentG1 = m.matchResults.length > 0 ? m.matchResults[0].pointsTeam1 : 0;
        const currentG2 = m.matchResults.length > 0 ? m.matchResults[0].pointsTeam2 : 0;

        if (currentG1 > prevState.goals1) {
            triggerGoalNotification(m, m.team1.teamName, currentG1, currentG2);
        }
        if (currentG2 > prevState.goals2) {
            triggerGoalNotification(m, m.team2.teamName, currentG1, currentG2);
        }
    });
}

function triggerGoalNotification(match, scorerTeam, score1, score2) {
    const title = `¡GOL de ${scorerTeam}! ⚽`;
    const body = `${match.team1.teamName} ${score1} - ${score2} ${match.team2.teamName}`;
    new Notification(title, {
        body: body,
        icon: match.team1.teamIconUrl // Se podría usar un icono de gol genérico
    });
}

function checkMatchStarts(currentMatches) {
    const now = new Date();
    currentMatches.forEach(m => {
        if (m.matchIsFinished || STATE.notifiedMatches.has(m.matchID)) return;

        const matchDate = new Date(m.matchDateTime);
        const diffMinutes = (matchDate - now) / (1000 * 60);

        // Si el partido empieza en los próximos 10 minutos (y es en el futuro > 0)
        if (diffMinutes > 0 && diffMinutes <= 10) {
            STATE.notifiedMatches.add(m.matchID);
            new Notification('¡Partido por comenzar! ⏳', {
                body: `${match.team1.teamName} vs ${match.team2.teamName} arranca en breve.`,
                icon: match.team1.teamIconUrl
            });
        }
    });
}

/* ==========================================================================
   PROCESAMIENTO DE DATOS
   ========================================================================== */
function processMatchdays() {
    if (!STATE.matchesData || STATE.matchesData.length === 0) {
        STATE.availableMatchdays = [];
        return;
    }

    // Extraer jornadas únicas ordenadas por ID o nombre
    const matchdaysMap = {};
    STATE.matchesData.forEach(m => {
        if (m.group) {
            const id = m.group.groupOrderID;
            const name = m.group.groupName;
            matchdaysMap[id] = name;
        }
    });

    STATE.availableMatchdays = Object.entries(matchdaysMap)
        .map(([id, name]) => ({ orderId: parseInt(id), name }))
        .sort((a, b) => a.orderId - b.orderId);

    // Seleccionar jornada actual por defecto
    if (!STATE.currentMatchday && STATE.availableMatchdays.length > 0) {
        // Buscar la jornada más reciente que tenga partidos no jugados o en juego
        const unfinishedMatch = STATE.matchesData.find(m => !m.matchIsFinished);
        if (unfinishedMatch && unfinishedMatch.group) {
            STATE.currentMatchday = unfinishedMatch.group.groupOrderID;
        } else {
            // Si todos terminaron, mostrar la última jornada disponible
            STATE.currentMatchday = STATE.availableMatchdays[STATE.availableMatchdays.length - 1].orderId;
        }
    }

    // Llenar selector de jornadas en HTML
    const matchdaySelect = document.getElementById('matchdaySelect');
    if (matchdaySelect) {
        matchdaySelect.innerHTML = '';
        STATE.availableMatchdays.forEach(md => {
            const option = document.createElement('option');
            option.value = md.orderId;
            option.textContent = translateMatchdayName(md.name);
            if (md.orderId === STATE.currentMatchday) option.selected = true;
            matchdaySelect.appendChild(option);
        });
    }
}

function translateMatchdayName(name) {
    // Traducir términos comunes alemanes a español
    return name
        .replace('Spieltag', 'Jornada')
        .replace('Gruppenphase', 'Fase de Grupos')
        .replace('Play-Offs', '16avos (Play-offs)')
        .replace('Achtelfinale', 'Octavos de Final')
        .replace('Viertelfinale', 'Cuartos de Final')
        .replace('Halbfinale', 'Semifinal')
        .replace('Finale', 'Final')
        .replace('Endspiel', 'Final')
        .replace('Hinspiele', 'Ida')
        .replace('Rückspiele', 'Vuelta')
        .replace('Runde', 'Ronda');
}

// Obtener el marcador actualizado de un partido
function getMatchScore(match) {
    let score1 = 0;
    let score2 = 0;

    if (match.goals && match.goals.length > 0) {
        // En vivo o finalizado: el último gol tiene el marcador actual
        const lastGoal = match.goals[match.goals.length - 1];
        score1 = lastGoal.scoreTeam1;
        score2 = lastGoal.scoreTeam2;
    } else if (match.matchResults && match.matchResults.length > 0) {
        // Fallback a los resultados reportados (ej. Endergebnis)
        const sorted = [...match.matchResults].sort((a, b) => b.resultTypeID - a.resultTypeID);
        score1 = sorted[0].pointsTeam1;
        score2 = sorted[0].pointsTeam2;
    }

    return { score1, score2 };
}

// Calcular la forma reciente (últimos 5 partidos jugados)
function calculateTeamForm(teamId, matches) {
    // Filtrar partidos del equipo que ya finalizaron
    const finishedMatches = matches
        .filter(m => m.matchIsFinished && (m.team1.teamId === teamId || m.team2.teamId === teamId))
        // Ordenar por fecha de más antiguo a más reciente
        .sort((a, b) => new Date(a.matchDateTimeUTC || a.matchDateTime) - new Date(b.matchDateTimeUTC || b.matchDateTime));

    // Tomar los últimos 5
    const last5 = finishedMatches.slice(-5);

    return last5.map(m => {
        const score = getMatchScore(m);
        const isTeam1 = m.team1.teamId === teamId;
        const teamScore = isTeam1 ? score.score1 : score.score2;
        const oppScore = isTeam1 ? score.score2 : score.score1;

        if (teamScore > oppScore) return 'W'; // Ganó
        if (teamScore === oppScore) return 'D'; // Empató
        return 'L'; // Perdió
    });
}

// Retorna la tabla de posiciones plana de 48 equipos
function processStandingsData() {
    const standings = STATE.standingsData;
    // Ordenar tabla única
    const sortedStandings = [...standings].sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);
    return { type: 'single', data: sortedStandings };
}

/* ==========================================================================
   RENDERIZADORES DE VISTAS (UI RENDER)
   ========================================================================== */
function renderActiveTab() {
    updateSelectorVisibility();
    
    switch (STATE.activeTab) {
        case 'standings':
            renderStandings();
            break;
        case 'matches':
            renderMatches();
            break;
        case 'bracket':
            renderBracket();
            break;
        case 'summary':
            renderSummary();
            break;
    }
}

function updateSelectorVisibility() {
    const matchdaySelector = document.getElementById('matchdaySelectorGroup');
    if (STATE.activeTab === 'matches') {
        matchdaySelector.style.display = 'flex';
    } else {
        matchdaySelector.style.display = 'none';
    }
}

/* --- PESTAÑA: CLASIFICACIÓN --- */
function renderStandings() {
    const container = document.getElementById('standingsContainer');
    container.innerHTML = '';

    if (STATE.standingsData.length === 0 || STATE.matchesData.length === 0) {
        container.innerHTML = `
            <div class="summary-empty-state">
                <i class="fa-solid fa-circle-info" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
                <p>No hay datos de clasificación disponibles para el Mundial.</p>
            </div>`;
        return;
    }

    // 1. Agrupar los equipos por sus 12 grupos usando DSU (mismo algoritmo que getThirdPlacedStandings)
    const groupMatches = STATE.matchesData.filter(m => m.group && m.group.groupName.includes('Gruppenphase'));
    const parent = {};
    const getRoot = (id) => {
        if (parent[id] === undefined) parent[id] = id;
        let curr = id;
        while (parent[curr] !== curr) curr = parent[curr];
        return curr;
    };
    const union = (id1, id2) => {
        const r1 = getRoot(id1);
        const r2 = getRoot(id2);
        if (r1 !== r2) parent[r1] = r2;
    };
    groupMatches.forEach(m => {
        if (m.team1 && m.team1.teamId && m.team2 && m.team2.teamId) {
            union(m.team1.teamId, m.team2.teamId);
        }
    });

    const groupsByRoot = {};
    Object.keys(parent).forEach(teamIdStr => {
        const teamId = parseInt(teamIdStr);
        const root = getRoot(teamId);
        if (!groupsByRoot[root]) groupsByRoot[root] = [];
        groupsByRoot[root].push(teamId);
    });

    const groupMinMatchTime = {};
    Object.entries(groupsByRoot).forEach(([root, teamIds]) => {
        const firstMatch = groupMatches.find(m => teamIds.includes(m.team1.teamId) || teamIds.includes(m.team2.teamId));
        groupMinMatchTime[root] = firstMatch ? firstMatch.matchID : 999999;
    });

    const sortedGroupRoots = Object.keys(groupsByRoot).sort((a, b) => groupMinMatchTime[a] - groupMinMatchTime[b]);

    // Obtener la lista de los mejores terceros clasificados (los top 8)
    const bestThirds = getThirdPlacedStandings().slice(0, 8);
    const bestThirdsIds = new Set(bestThirds.map(bt => bt.teamInfoId));

    // 2. Renderizar contenedor de grupos
    const groupsContainer = document.createElement('div');
    groupsContainer.className = 'groups-container';

    sortedGroupRoots.forEach((root, idx) => {
        const groupLetter = String.fromCharCode(65 + idx); // A, B, C... L
        const teamIds = groupsByRoot[root];
        
        // Obtener standings del grupo ordenados
        const groupStandings = STATE.standingsData
            .filter(t => teamIds.includes(t.teamInfoId))
            .sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);

        const card = document.createElement('div');
        card.className = 'group-card';

        // Estilo de cabecera con el color naranja de OpenLigaDB
        card.innerHTML = `
            <div class="group-title" style="background: var(--accent-amber-bg); color: var(--accent-amber); border-bottom: 2px solid rgba(245, 158, 11, 0.2); padding: 0.6rem 1rem; text-transform: uppercase; font-family: var(--font-title); font-size: 0.9rem; font-weight: 800;">
                Grupo ${groupLetter}
            </div>
            <table class="standings-table" style="font-size: 0.8rem; width: 100%;">
                <thead>
                    <tr style="background: rgba(255,255,255,0.01);">
                        <th style="padding: 0.5rem; text-align: center; width: 25px;">#</th>
                        <th style="padding: 0.5rem; text-align: left;">Equipo</th>
                        <th style="padding: 0.5rem; text-align: center; width: 35px;" title="Partidos Jugados">PJ</th>
                        <th style="padding: 0.5rem; text-align: center; width: 30px;" title="Ganados">G</th>
                        <th style="padding: 0.5rem; text-align: center; width: 30px;" title="Empatados">E</th>
                        <th style="padding: 0.5rem; text-align: center; width: 30px;" title="Perdidos">P</th>
                        <th style="padding: 0.5rem; text-align: center; width: 55px;" title="Goles a Favor : Goles en Contra">Goles</th>
                        <th style="padding: 0.5rem; text-align: center; width: 40px; font-weight: 700; background: rgba(255,255,255,0.02);" title="Puntos">Pts</th>
                    </tr>
                </thead>
                <tbody>
                    ${groupStandings.map((t, index) => {
                        const position = index + 1;
                        let zoneClass = 'zone-eliminated';
                        let zoneTitle = 'Eliminado';
                        if (position <= 2) {
                            zoneClass = 'zone-direct';
                            zoneTitle = 'Clasifica Directo';
                        } else if (position === 3) {
                            if (bestThirdsIds.has(t.teamInfoId)) {
                                zoneClass = 'zone-playoffs';
                                zoneTitle = 'Mejor Tercero (Clasificado)';
                            } else {
                                zoneClass = 'zone-eliminated';
                                zoneTitle = 'Tercero Eliminado (No clasifica)';
                            }
                        }
                        
                        return `
                            <tr class="${zoneClass}" title="${zoneTitle}" style="transition: var(--transition-fast);">
                                <td style="padding: 0.5rem; text-align: center; font-weight: 700;">${position}</td>
                                <td style="padding: 0.5rem;">
                                    <div class="team-cell" style="gap: 0.5rem;">
                                        <img class="team-logo" src="${t.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/18x18/111827/ffffff?text=${t.shortName || 'EQ'}'" style="width: 18px; height:18px;">
                                        <span style="font-weight: 600;">${translateTeamName(t.teamName)}</span>
                                    </div>
                                </td>
                                <td style="padding: 0.5rem; text-align: center;">${t.matches}</td>
                                <td style="padding: 0.5rem; text-align: center;">${t.won}</td>
                                <td style="padding: 0.5rem; text-align: center;">${t.draw}</td>
                                <td style="padding: 0.5rem; text-align: center;">${t.lost}</td>
                                <td style="padding: 0.5rem; text-align: center; font-family: monospace;">${t.goals}:${t.opponentGoals}</td>
                                <td style="padding: 0.5rem; text-align: center; font-weight: 700; background: rgba(255,255,255,0.02);">${t.points}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
        groupsContainer.appendChild(card);
    });

    container.appendChild(groupsContainer);

    // Leyendas de Clasificación para los Grupos
    const legend = document.createElement('div');
    legend.className = 'classification-legend';
    legend.innerHTML = `
        <div class="legend-item"><div class="legend-color legend-direct"></div> Puestos 1 y 2: Clasificación Directa a 16avos</div>
        <div class="legend-item"><div class="legend-color legend-playoffs"></div> Puesto 3 (Top 8): Clasificado a 16avos</div>
        <div class="legend-item"><div class="legend-color legend-eliminated"></div> Puesto 3 (Restantes) y Puesto 4: Eliminado</div>
    `;
    container.appendChild(legend);
}

function getRowZoneClass(index, tournament) {
    const position = index + 1;
    if (position <= 8) return 'zone-direct'; // Top 8 (Los mejores)
    if (position <= 32) return 'zone-playoffs'; // Clasifican a 16avos
    return 'zone-eliminated'; // Eliminados
}

function getRowZoneLabel(index, tournament) {
    const position = index + 1;
    if (position <= 8) return 'Los 8 Mejores';
    if (position <= 32) return 'Clasifica a 16avos de Final';
    return 'Eliminado';
}

/* --- PESTAÑA: PARTIDOS --- */
function renderMatches() {
    const container = document.getElementById('matchesContainer');
    container.innerHTML = '';

    if (STATE.matchesData.length === 0) {
        container.innerHTML = `
            <div class="summary-empty-state">
                <i class="fa-solid fa-calendar-xmark" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
                <p>No hay partidos programados para el Mundial.</p>
            </div>`;
        return;
    }

    // Filtrar partidos por la jornada seleccionada
    const filteredMatches = STATE.matchesData.filter(m => m.group && m.group.groupOrderID === STATE.currentMatchday);

    if (filteredMatches.length === 0) {
        container.innerHTML = `<div class="summary-empty-state"><p>No se encontraron partidos para esta jornada/fase.</p></div>`;
        return;
    }

    // Agrupar partidos por fecha
    const matchesByDate = {};
    filteredMatches.forEach(m => {
        const dateObj = new Date(m.matchDateTimeUTC || m.matchDateTime);
        const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        
        if (!matchesByDate[formattedDate]) {
            matchesByDate[formattedDate] = [];
        }
        matchesByDate[formattedDate].push(m);
    });

    // Renderizar grupos de fecha
    Object.keys(matchesByDate).forEach(dateStr => {
        const dateGroup = document.createElement('div');
        dateGroup.className = 'matches-date-group';

        dateGroup.innerHTML = `<div class="date-divider">${capitalizeFirstLetter(dateStr)}</div>`;

        const grid = document.createElement('div');
        grid.className = 'matches-grid';

        matchesByDate[dateStr].forEach(m => {
            const card = createMatchCard(m);
            grid.appendChild(card);
        });

        dateGroup.appendChild(grid);
        container.appendChild(dateGroup);
    });
}

// Obtiene el estado detallado del partido (1T, Entretiempo, 2T, Final, Programado) en tiempo real
function getLiveMatchStatus(match) {
    if (match.matchIsFinished) {
        const otResult = match.matchResults.find(r => r.resultTypeID === 3);
        const penResult = match.matchResults.find(r => r.resultTypeID === 4);
        if (penResult) {
            return { label: `Final (Pen. ${penResult.pointsTeam1}-${penResult.pointsTeam2})`, cls: 'finished' };
        }
        if (otResult) {
            return { label: 'Final (T.E.)', cls: 'finished' };
        }
        return { label: 'Final', cls: 'finished' };
    }

    const now = new Date();
    const start = new Date(match.matchDateTimeUTC || match.matchDateTime);
    const elapsedMs = now - start;
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    if (elapsedMinutes < 0) {
        return { label: 'Programado', cls: 'upcoming' };
    }

    // 45 min de juego + descuento y descanso = entretiempo entre min 45 y 66 desde el inicio (21 min de receso)
    if (elapsedMinutes >= 45 && elapsedMinutes < 66) {
        return { label: 'Entretiempo', cls: 'live-half' };
    }

    if (elapsedMinutes >= 66) {
        const currentMin = elapsedMinutes - 21; // 21 min de desfase total (descuento + descanso)
        const displayMin = currentMin > 90 ? '90+' : currentMin;
        return { label: `2T ${displayMin}'`, cls: 'live' };
    }

    // Primer tiempo
    return { label: `1T ${elapsedMinutes}'`, cls: 'live' };
}

// Obtiene la lista formateada de goleadores de un equipo
function getTeamScorers(match, isTeam1) {
    if (!match.goals || match.goals.length === 0) return '';
    
    const teamGoals = [];
    match.goals.forEach((g, idx) => {
        const prev1 = idx > 0 ? match.goals[idx - 1].scoreTeam1 : 0;
        const prev2 = idx > 0 ? match.goals[idx - 1].scoreTeam2 : 0;
        
        const addedTo1 = g.scoreTeam1 > prev1;
        const addedTo2 = g.scoreTeam2 > prev2;
        
        if ((isTeam1 && addedTo1) || (!isTeam1 && addedTo2)) {
            let label = g.goalGetterName || 'Gol';
            if (g.isOwnGoal) label += ' (A.G.)';
            if (g.isPenalty) label += ' (Pen.)';
            teamGoals.push(`${label} ${g.matchMinute}'`);
        }
    });
    
    if (teamGoals.length === 0) return '';
    return teamGoals.join(', ');
}

function createMatchCard(m) {
    const card = document.createElement('div');
    card.className = 'match-card';

    const score = getMatchScore(m);
    const dateObj = new Date(m.matchDateTimeUTC || m.matchDateTime);
    const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Determinar ganador
    let team1WinClass = '';
    let team2WinClass = '';
    if (m.matchIsFinished) {
        if (score.score1 > score.score2) team1WinClass = 'winner';
        else if (score.score2 > score.score1) team2WinClass = 'winner';
    }

    // Obtener estado en tiempo real (1T, Entretiempo, 2T, etc.)
    const status = getLiveMatchStatus(m);
    const statusBadgeText = status.label;
    const statusBadgeClass = status.cls;
    
    // Obtener goleadores en línea
    const scorers1 = getTeamScorers(m, true);
    const scorers2 = getTeamScorers(m, false);

    card.innerHTML = `
        <div class="match-main-info">
            <div class="match-teams">
                <div class="team-row ${team1WinClass}">
                    <div class="team-info-wrapper">
                        <div class="team-info">
                            <img class="team-logo" src="${m.team1.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/24x24/111827/ffffff?text=${m.team1.shortName || 'EQ'}'" alt="${m.team1.teamName}">
                            <span>${translateTeamName(m.team1.teamName)}</span>
                        </div>
                        ${scorers1 ? `<span class="team-scorers-inline"><i class="fa-solid fa-futbol" style="font-size: 0.62rem; color: var(--text-muted); opacity: 0.7; margin-right: 4px;"></i>${scorers1}</span>` : ''}
                    </div>
                    <span class="team-score">${m.matchIsFinished || statusBadgeClass === 'live' || statusBadgeClass === 'live-half' ? score.score1 : '-'}</span>
                </div>
                <div class="team-row ${team2WinClass}">
                    <div class="team-info-wrapper">
                        <div class="team-info">
                            <img class="team-logo" src="${m.team2.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/24x24/111827/ffffff?text=${m.team2.shortName || 'EQ'}'" alt="${m.team2.teamName}">
                            <span>${translateTeamName(m.team2.teamName)}</span>
                        </div>
                        ${scorers2 ? `<span class="team-scorers-inline"><i class="fa-solid fa-futbol" style="font-size: 0.62rem; color: var(--text-muted); opacity: 0.7; margin-right: 4px;"></i>${scorers2}</span>` : ''}
                    </div>
                    <span class="team-score">${m.matchIsFinished || statusBadgeClass === 'live' || statusBadgeClass === 'live-half' ? score.score2 : '-'}</span>
                </div>
            </div>
            <div class="match-status-area">
                <span class="match-time">${timeStr}</span>
                <span class="match-status-badge ${statusBadgeClass}">${statusBadgeText}</span>
            </div>
        </div>
        
        <div class="match-details-drawer">
            <div class="goals-list">
                ${m.goals && m.goals.length > 0 ? 
                    m.goals.map(g => {
                        let icon = '<i class="fa-solid fa-futbol"></i>';
                        let goalText = 'Gol';
                        if (g.isOwnGoal) {
                            icon = '<i class="fa-solid fa-circle-xmark goal-type-icon own-goal"></i>';
                            goalText = 'A.G.';
                        } else if (g.isPenalty) {
                            icon = '<i class="fa-solid fa-circle-dot goal-type-icon penalty"></i>';
                            goalText = 'Pen.';
                        }
                        return `
                            <div class="goal-item">
                                <span class="goal-minute">${g.matchMinute}'</span>
                                ${icon}
                                <span><strong>${g.goalGetterName || 'Desconocido'}</strong> (${g.scoreTeam1} - ${g.scoreTeam2}) ${g.isOwnGoal || g.isPenalty ? `[${goalText}]` : ''}</span>
                            </div>`;
                    }).join('') : 
                    '<p style="text-align: center; color: var(--text-muted);">No se registraron goles o detalles en el sistema.</p>'
                }
            </div>
            <div class="match-metadata">
                <span><i class="fa-solid fa-location-dot"></i> ${m.location ? `${m.location.locationStadium || ''}, ${m.location.locationCity || ''}` : 'Sede sin registrar'}</span>
                ${m.numberOfViewers ? `<span><i class="fa-solid fa-users"></i> ${m.numberOfViewers.toLocaleString()} espectadores</span>` : ''}
            </div>
        </div>
    `;

    // Acordeón para expandir goles
    card.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') return;
        card.classList.toggle('expanded');
    });

    return card;
}

/*
   Genera una fase eliminatoria de 5 rondas para el Mundial 2026.
   Si no se han programado las fases posteriores en la API, se generan virtualmente
   a partir de la ronda de 16avos de final para mostrar el flujo completo.
*/
function generateWorldCupBracket(koMatches) {
    const rounds = {
        r32: { name: '16avos de Final', matches: [] },
        r16: { name: 'Octavos de Final', matches: [] },
        r8:  { name: 'Cuartos de Final', matches: [] },
        r4:  { name: 'Semifinales', matches: [] },
        r2:  { name: 'Final', matches: [] }
    };

    // Obtener los 16 matches de 16avos de Final
    rounds.r32.matches = koMatches.filter(m => m.group && m.group.groupName.includes('Sechzehntelfinale'))
                                 .sort((a, b) => a.matchID - b.matchID);

    if (rounds.r32.matches.length === 0) return [];

    // Helper para obtener el ganador (física o virtualmente)
    const getMatchWinner = (m) => {
        if (!m) return null;
        if (m.matchIsFinished) {
            const score = getMatchScore(m);
            if (score.score1 > score.score2) return m.team1;
            if (score.score2 > score.score1) return m.team2;
            const penResult = m.matchResults && m.matchResults.find(r => r.resultTypeID === 4);
            if (penResult) {
                if (penResult.pointsTeam1 > penResult.pointsTeam2) return m.team1;
                return m.team2;
            }
            return null;
        }
        if (m.isVirtualFinished) {
            return m.virtualWinner;
        }
        return null;
    };

    // 2. Cargar o generar virtualmente Octavos de Final
    const apiR16 = koMatches.filter(m => m.group && m.group.groupName.includes('Achtelfinale'))
                            .sort((a, b) => a.matchID - b.matchID);
    if (apiR16.length > 0) {
        rounds.r16.matches = apiR16;
    } else {
        for (let i = 0; i < 8; i++) {
            const m1 = rounds.r32.matches[2 * i];
            const m2 = rounds.r32.matches[2 * i + 1];
            const w1 = getMatchWinner(m1);
            const w2 = getMatchWinner(m2);
            rounds.r16.matches.push({
                isVirtual: true,
                matchID: 10000 + i,
                team1: w1 || { teamName: `Ganador Part. ${2*i + 1}`, shortName: `GAN ${2*i + 1}`, teamIconUrl: null },
                team2: w2 || { teamName: `Ganador Part. ${2*i + 2}`, shortName: `GAN ${2*i + 2}`, teamIconUrl: null },
                matchIsFinished: false,
                matchResults: [],
                goals: []
            });
        }
    }

    // 3. Cargar o generar virtualmente Cuartos de Final (8 mejores)
    const apiR8 = koMatches.filter(m => m.group && m.group.groupName.includes('Viertelfinale'))
                           .sort((a, b) => a.matchID - b.matchID);
    if (apiR8.length > 0) {
        rounds.r8.matches = apiR8;
    } else {
        for (let i = 0; i < 4; i++) {
            const m1 = rounds.r16.matches[2 * i];
            const m2 = rounds.r16.matches[2 * i + 1];
            const w1 = getMatchWinner(m1);
            const w2 = getMatchWinner(m2);
            rounds.r8.matches.push({
                isVirtual: true,
                matchID: 20000 + i,
                team1: w1 || { teamName: `Ganador Oct. ${2*i + 1}`, shortName: `GAN OCT ${2*i + 1}`, teamIconUrl: null },
                team2: w2 || { teamName: `Ganador Oct. ${2*i + 2}`, shortName: `GAN OCT ${2*i + 2}`, teamIconUrl: null },
                matchIsFinished: false,
                matchResults: [],
                goals: []
            });
        }
    }

    // 4. Cargar o generar virtualmente Semifinales
    const apiR4 = koMatches.filter(m => m.group && m.group.groupName.includes('Halbfinale'))
                           .sort((a, b) => a.matchID - b.matchID);
    if (apiR4.length > 0) {
        rounds.r4.matches = apiR4;
    } else {
        for (let i = 0; i < 2; i++) {
            const m1 = rounds.r8.matches[2 * i];
            const m2 = rounds.r8.matches[2 * i + 1];
            const w1 = getMatchWinner(m1);
            const w2 = getMatchWinner(m2);
            rounds.r4.matches.push({
                isVirtual: true,
                matchID: 30000 + i,
                team1: w1 || { teamName: `Ganador Cuar. ${2*i + 1}`, shortName: `GAN CUA ${2*i + 1}`, teamIconUrl: null },
                team2: w2 || { teamName: `Ganador Cuar. ${2*i + 2}`, shortName: `GAN CUA ${2*i + 2}`, teamIconUrl: null },
                matchIsFinished: false,
                matchResults: [],
                goals: []
            });
        }
    }

    // 5. Cargar o generar virtualmente la Final
    const apiR2 = koMatches.filter(m => m.group && (m.group.groupName.includes('Finale') || m.group.groupName.includes('Endspiel')))
                           .filter(m => !m.group.groupName.includes('Halbfinale') && !m.group.groupName.includes('Achtelfinale') && !m.group.groupName.includes('Viertelfinale') && !m.group.groupName.includes('Sechzehntelfinale'))
                           .sort((a, b) => a.matchID - b.matchID);
    if (apiR2.length > 0) {
        rounds.r2.matches = apiR2;
    } else {
        const m1 = rounds.r4.matches[0];
        const m2 = rounds.r4.matches[1];
        const w1 = getMatchWinner(m1);
        const w2 = getMatchWinner(m2);
        rounds.r2.matches.push({
            isVirtual: true,
            matchID: 40000,
            team1: w1 || { teamName: `Ganador Sem. 1`, shortName: `GAN SEM 1`, teamIconUrl: null },
            team2: w2 || { teamName: `Ganador Sem. 2`, shortName: `GAN SEM 2`, teamIconUrl: null },
            matchIsFinished: false,
            matchResults: [],
            goals: []
        });
    }

    return Object.values(rounds);
}

/* --- PESTAÑA: FASE FINAL (BRACKET) --- */
function renderBracket() {
    const container = document.getElementById('bracketContainer');
    container.innerHTML = '';

    // Filtrar partidos eliminatorios
    const koStages = ['Achtelfinale', 'Viertelfinale', 'Halbfinale', 'Finale', 'Endspiel', 'Play-Offs', 'Sechzehntelfinale'];
    const koMatches = STATE.matchesData.filter(m => {
        if (!m.group || !m.group.groupName) return false;
        return koStages.some(stage => m.group.groupName.includes(stage));
    });

    if (koMatches.length === 0) {
        container.innerHTML = `
            <div class="summary-empty-state">
                <i class="fa-solid fa-diagram-project" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
                <p>La fase de llaves / eliminación directa aún no se ha programado.</p>
            </div>`;
        return;
    }

    // Generar o cargar llaves del Mundial
    const sortedPhases = generateWorldCupBracket(koMatches);

    const bracketWrapper = document.createElement('div');
    bracketWrapper.className = 'bracket-container';

    sortedPhases.forEach((phase) => {
        const roundColumn = document.createElement('div');
        roundColumn.className = 'bracket-round';

        const header = document.createElement('div');
        header.className = 'round-header-name';
        header.textContent = phase.name;
        roundColumn.appendChild(header);

        // Agrupar por eliminatorias
        const pairedMatches = pairDoubleLegMatches(phase.matches);

        pairedMatches.forEach(pair => {
            const matchNode = document.createElement('div');
            matchNode.className = 'bracket-match-node';

            const m1 = pair.match1;
            const m2 = pair.match2;

            const score1 = getMatchScore(m1);
            const score2 = m2 ? getMatchScore(m2) : null;

            // Calcular agregado
            let t1Agg = score1.score1;
            let t2Agg = score1.score2;
            
            if (m2) {
                if (m2.team1.teamId === m1.team2.teamId) {
                    t1Agg += score2.score2;
                    t2Agg += score2.score1;
                } else {
                    t1Agg += score2.score1;
                    t2Agg += score2.score2;
                }
            }

            // Marcar ganadores
            let t1Class = '';
            let t2Class = '';
            
            const getWinner = (m) => {
                if (!m) return null;
                if (m.matchIsFinished) {
                    const s = getMatchScore(m);
                    if (s.score1 > s.score2) return m.team1;
                    if (s.score2 > s.score1) return m.team2;
                    const pen = m.matchResults && m.matchResults.find(r => r.resultTypeID === 4);
                    if (pen) {
                        if (pen.pointsTeam1 > pen.pointsTeam2) return m.team1;
                        return m.team2;
                    }
                }
                return null;
            };

            const winnerTeam = getWinner(m1) || (m2 ? getWinner(m2) : null);
            if (winnerTeam) {
                if (m1.team1.teamId === winnerTeam.teamId) {
                    t1Class = 'winner'; t2Class = 'loser';
                } else if (m1.team2.teamId === winnerTeam.teamId) {
                    t2Class = 'winner'; t1Class = 'loser';
                }
            }

            const isLive = !m1.matchIsFinished || (m2 && !m2.matchIsFinished);

            matchNode.innerHTML = `
                <div class="bracket-team-row ${t1Class}">
                    <div class="team-cell">
                        ${m1.team1.teamIconUrl ? `<img class="team-logo" src="${m1.team1.teamIconUrl}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${m1.team1.shortName || 'EQ'}'">` : `<i class="fa-solid fa-question-circle" style="color: var(--text-muted); font-size: 0.95rem; width:16px;"></i>`}
                        <span title="${translateTeamName(m1.team1.teamName)}">${m1.team1.shortName || translateTeamName(m1.team1.teamName)}</span>
                    </div>
                    <span class="bracket-score">${(m1.matchIsFinished || isLive) && !m1.isVirtual ? t1Agg : '-'}</span>
                </div>
                <div class="bracket-team-row ${t2Class}">
                    <div class="team-cell">
                        ${m1.team2.teamIconUrl ? `<img class="team-logo" src="${m1.team2.teamIconUrl}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${m1.team2.shortName || 'EQ'}'">` : `<i class="fa-solid fa-question-circle" style="color: var(--text-muted); font-size: 0.95rem; width:16px;"></i>`}
                        <span title="${translateTeamName(m1.team2.teamName)}">${m1.team2.shortName || translateTeamName(m1.team2.teamName)}</span>
                    </div>
                    <span class="bracket-score">${(m1.matchIsFinished || isLive) && !m1.isVirtual ? t2Agg : '-'}</span>
                </div>
                <div class="bracket-match-info">
                    ${m1.isVirtual ? `<span>Fase de Llaves</span>` : (m2 ? `<span>Ida: ${score1.score1}-${score1.score2} | Vta: ${score2 ? `${score2.score1}-${score2.score2}` : '?' }</span>` : `<span>Partido Único</span>`)}
                    ${isLive && !m1.isVirtual && (!m1.matchIsFinished || (m2 && !m2.matchIsFinished)) ? `
                        <span class="bracket-live-badge"><span class="live-pulse"></span> VIVO</span>
                    ` : ''}
                </div>
            `;
            roundColumn.appendChild(matchNode);
        });

        bracketWrapper.appendChild(roundColumn);
    });

    container.appendChild(bracketWrapper);
}

// Auxiliar para emparejar ida y vuelta
function pairDoubleLegMatches(matches) {
    const paired = [];
    const visited = new Set();

    matches.forEach(m => {
        if (visited.has(m.matchID)) return;

        const isDoubleLeg = m.group.groupName.includes('Hinspiele') || m.group.groupName.includes('Rückspiele');
        if (!isDoubleLeg) {
            paired.push({ type: 'single', match1: m });
            visited.add(m.matchID);
            return;
        }

        const id1 = m.team1.teamId;
        const id2 = m.team2.teamId;
        const normRoundName = m.group.groupName.replace(' Hinspiele', '').replace(' Rückspiele', '');

        const secondLeg = matches.find(other => {
            if (other.matchID === m.matchID) return false;
            if (visited.has(other.matchID)) return false;
            
            const otherNormRound = other.group.groupName.replace(' Hinspiele', '').replace(' Rückspiele', '');
            if (normRoundName !== otherNormRound) return false;

            return (other.team1.teamId === id2 && other.team2.teamId === id1) || 
                   (other.team1.teamId === id1 && other.team2.teamId === id2);
        });

        if (secondLeg) {
            const isM1Ida = m.group.groupName.includes('Hinspiele');
            paired.push({
                type: 'double',
                match1: isM1Ida ? m : secondLeg,
                match2: isM1Ida ? secondLeg : m
            });
            visited.add(m.matchID);
            visited.add(secondLeg.matchID);
        } else {
            paired.push({ type: 'single', match1: m });
            visited.add(m.matchID);
        }
    });

    return paired;
}

/*
   Calcula la clasificación general de los terceros lugares de los 12 grupos del Mundial.
   Utiliza un algoritmo de componentes conexas para identificar los grupos automáticamente.
*/
function getThirdPlacedStandings() {
    if (!STATE.standingsData || STATE.standingsData.length === 0 || !STATE.matchesData || STATE.matchesData.length === 0) {
        return [];
    }

    // 1. Encontrar componentes conexas de equipos en la fase de grupos
    const groupMatches = STATE.matchesData.filter(m => m.group && m.group.groupName.includes('Gruppenphase'));
    
    // Disjoint Set Union (DSU) para agrupar los equipos por enfrentamiento directo en fase de grupos
    const parent = {};
    const getRoot = (id) => {
        if (parent[id] === undefined) parent[id] = id;
        let curr = id;
        while (parent[curr] !== curr) {
            curr = parent[curr];
        }
        return curr;
    };
    const union = (id1, id2) => {
        const r1 = getRoot(id1);
        const r2 = getRoot(id2);
        if (r1 !== r2) parent[r1] = r2;
    };
    
    groupMatches.forEach(m => {
        if (m.team1 && m.team1.teamId && m.team2 && m.team2.teamId) {
            union(m.team1.teamId, m.team2.teamId);
        }
    });
    
    // Agrupar los equipos por su raíz
    const groupsByRoot = {};
    Object.keys(parent).forEach(teamIdStr => {
        const teamId = parseInt(teamIdStr);
        const root = getRoot(teamId);
        if (!groupsByRoot[root]) groupsByRoot[root] = [];
        groupsByRoot[root].push(teamId);
    });
    
    // Para cada grupo, encontrar el menor matchID para ordenarlos de la A a la L de forma consistente
    const groupMinMatchTime = {};
    Object.entries(groupsByRoot).forEach(([root, teamIds]) => {
        const firstMatch = groupMatches.find(m => teamIds.includes(m.team1.teamId) || teamIds.includes(m.team2.teamId));
        groupMinMatchTime[root] = firstMatch ? firstMatch.matchID : 999999;
    });
    
    const sortedGroupRoots = Object.keys(groupsByRoot).sort((a, b) => groupMinMatchTime[a] - groupMinMatchTime[b]);
    
    // Construir la tabla de 3eros
    const thirdPlacedTeams = [];
    
    sortedGroupRoots.forEach((root, idx) => {
        const groupLetter = String.fromCharCode(65 + idx); // Grupo A, B, C... L
        const teamIds = groupsByRoot[root];
        
        // Obtener datos de standings para estos equipos del grupo y ordenarlos
        const groupStandings = STATE.standingsData
            .filter(t => teamIds.includes(t.teamInfoId))
            .sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);
        
        // El tercero es el índice 2 (tercera posición del grupo)
        if (groupStandings.length >= 3) {
            const thirdTeam = { ...groupStandings[2] };
            thirdTeam.groupLetter = groupLetter;
            thirdPlacedTeams.push(thirdTeam);
        }
    });
    
    // Ordenar los terceros lugares según las reglas del torneo (Puntos, Diferencia, Goles a favor)
    thirdPlacedTeams.sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);
    
    return thirdPlacedTeams;
}

/* --- PESTAÑA: RESUMEN DE CLASIFICADOS --- */
function renderSummary() {
    const container = document.getElementById('summaryContainer');
    container.innerHTML = '';

    if (STATE.standingsData.length === 0 || STATE.matchesData.length === 0) {
        container.innerHTML = `
            <div class="summary-empty-state">
                <i class="fa-solid fa-circle-nodes" style="font-size: 2rem; margin-bottom: 0.5rem;"></i>
                <p>Clasificación no disponible para calcular zonas.</p>
            </div>`;
        return;
    }

    // 1. Agrupar los equipos por sus 12 grupos usando DSU para saber su posición exacta dentro de su grupo
    const groupMatches = STATE.matchesData.filter(m => m.group && m.group.groupName.includes('Gruppenphase'));
    const parent = {};
    const getRoot = (id) => {
        if (parent[id] === undefined) parent[id] = id;
        let curr = id;
        while (parent[curr] !== curr) curr = parent[curr];
        return curr;
    };
    const union = (id1, id2) => {
        const r1 = getRoot(id1);
        const r2 = getRoot(id2);
        if (r1 !== r2) parent[r1] = r2;
    };
    groupMatches.forEach(m => {
        if (m.team1 && m.team1.teamId && m.team2 && m.team2.teamId) {
            union(m.team1.teamId, m.team2.teamId);
        }
    });

    const groupsByRoot = {};
    Object.keys(parent).forEach(teamIdStr => {
        const teamId = parseInt(teamIdStr);
        const root = getRoot(teamId);
        if (!groupsByRoot[root]) groupsByRoot[root] = [];
        groupsByRoot[root].push(teamId);
    });

    // Sets para almacenar qué equipos quedaron en qué posiciones de su grupo
    const directQualifiedIds = new Set(); // 1° y 2° lugares
    const thirdPlacedIds = new Set();      // 3° lugares
    const fourthPlacedIds = new Set();     // 4° lugares

    Object.values(groupsByRoot).forEach(teamIds => {
        const groupStandings = STATE.standingsData
            .filter(t => teamIds.includes(t.teamInfoId))
            .sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);
        
        groupStandings.forEach((t, index) => {
            if (index < 2) {
                directQualifiedIds.add(t.teamInfoId);
            } else if (index === 2) {
                thirdPlacedIds.add(t.teamInfoId);
            } else {
                fourthPlacedIds.add(t.teamInfoId);
            }
        });
    });

    // Ordenar todas las posiciones generales
    const sorted = [...STATE.standingsData].sort((a, b) => b.points - a.points || b.goalDiff - a.goalDiff || b.goals - a.goals);

    // Separar los equipos que quedaron en 1° o 2° de su grupo
    const directQualifiedSorted = sorted.filter(t => directQualifiedIds.has(t.teamInfoId));

    // - Los 8 mejores 1° y 2° van a la primera tarjeta
    const directTop8 = directQualifiedSorted.slice(0, 8); 
    // - Los 16 restantes 1° y 2° van a la segunda tarjeta
    const directNext16 = directQualifiedSorted.slice(8); 

    // - Los 12 cuartos de cada grupo van a la tarjeta de eliminación
    const eliminatedFourths = sorted.filter(t => fourthPlacedIds.has(t.teamInfoId));

    const directTitle = "Los 8 Mejores (Alto Rendimiento)";
    const playoffTitle = "Zona de Clasificación a 16avos (Pos 9-24)";

    const grid = document.createElement('div');
    grid.className = 'summary-grid';

    // 1. Tarjeta: Los 8 Mejores (1° y 2° de grupo top)
    if (directTop8.length > 0) {
        const card = document.createElement('div');
        card.className = 'summary-card green-border';
        card.innerHTML = `
            <h3><i class="fa-solid fa-crown header-green"></i> ${directTitle}</h3>
            <p class="desc">Los 8 equipos líderes de grupo con mejor puntaje en la tabla general en vivo.</p>
            <div class="summary-teams-list">
                ${directTop8.map((t, idx) => `
                    <div class="summary-team-item">
                        <div class="summary-team-details">
                            <span style="color: var(--accent-green); font-weight:700;">#${idx + 1}</span>
                            <img class="team-logo" src="${t.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${t.shortName || 'EQ'}'">
                            <span>${translateTeamName(t.teamName)}</span>
                        </div>
                        <span class="summary-team-points">${t.points} Pts</span>
                    </div>
                `).join('')}
            </div>
        `;
        grid.appendChild(card);
    }

    // 2. Tarjeta: Zona de 16avos (Restantes 1° y 2° de grupo)
    if (directNext16.length > 0) {
        const card = document.createElement('div');
        card.className = 'summary-card blue-border';
        card.innerHTML = `
            <h3><i class="fa-solid fa-code-fork header-blue"></i> ${playoffTitle}</h3>
            <p class="desc">Equipos que terminaron en 1° o 2° lugar en sus grupos y aseguran su pase a los 16avos de Final.</p>
            <div class="summary-teams-list">
                ${directNext16.map((t, idx) => {
                    const displayIdx = 8 + idx + 1;
                    return `
                        <div class="summary-team-item">
                            <div class="summary-team-details">
                                <span style="color: var(--accent-blue); font-weight:700;">#${displayIdx}</span>
                                <img class="team-logo" src="${t.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${t.shortName || 'EQ'}'">
                                <span>${translateTeamName(t.teamName)}</span>
                            </div>
                            <span class="summary-team-points">${t.points} Pts</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        grid.appendChild(card);
    }

    // 3. Tarjeta: Tabla de Terceros Lugares (Los mejores 8 terceros clasifican)
    const thirdPlaced = getThirdPlacedStandings();
    if (thirdPlaced.length > 0) {
        const card = document.createElement('div');
        card.className = 'summary-card amber-border';
        
        let listHTML = '';
        thirdPlaced.forEach((t, idx) => {
            const displayIdx = idx + 1;
            const isQualified = displayIdx <= 8;
            const markerColor = isQualified ? 'var(--accent-green)' : 'var(--accent-red)';
            
            listHTML += `
                <div class="summary-team-item">
                    <div class="summary-team-details">
                        <span style="color: ${markerColor}; font-weight:700; min-width: 20px;">#${displayIdx}</span>
                        <img class="team-logo" src="${t.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${t.shortName || 'EQ'}'">
                        <span>${translateTeamName(t.teamName)} <small style="color: var(--text-muted); font-size: 0.72rem;">(Grupo ${t.groupLetter})</small></span>
                    </div>
                    <span class="summary-team-points">${t.points} Pts | DG: ${t.goalDiff > 0 ? '+' + t.goalDiff : t.goalDiff}</span>
                </div>
            `;
            
            if (displayIdx === 8) {
                listHTML += `
                    <div class="thirds-divider" style="border-top: 1px dashed rgba(255,255,255,0.15); margin: 0.6rem 0; padding-top: 0.5rem; text-align: center; font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; justify-content: center; gap: 0.5rem;">
                        <i class="fa-solid fa-circle-chevron-down" style="color: var(--accent-green);"></i> Clasifican a 16avos / Eliminados <i class="fa-solid fa-circle-chevron-up" style="color: var(--accent-red);"></i>
                    </div>
                `;
            }
        });

        card.innerHTML = `
            <h3><i class="fa-solid fa-ranking-star header-amber" style="color: var(--accent-amber);"></i> Tabla de Mejores 3eros</h3>
            <p class="desc">Los 8 mejores terceros lugares de los 12 grupos avanzan a los 16avos de Final.</p>
            <div class="summary-teams-list">
                ${listHTML}
            </div>
        `;
        grid.appendChild(card);
    }

    // 4. Tarjeta: Eliminados (Los 12 cuartos de cada grupo)
    if (eliminatedFourths.length > 0) {
        const card = document.createElement('div');
        card.className = 'summary-card red-border';
        card.innerHTML = `
            <h3><i class="fa-solid fa-circle-minus header-red"></i> Zona de Eliminación</h3>
            <p class="desc">Los 12 equipos que terminaron en el 4° lugar de su grupo y quedan fuera del Mundial.</p>
            <div class="summary-teams-list">
                ${eliminatedFourths.map((t, idx) => {
                    const displayIdx = idx + 1;
                    return `
                        <div class="summary-team-item">
                            <div class="summary-team-details">
                                <span style="color: var(--accent-red); font-weight:700;">#${displayIdx}</span>
                                <img class="team-logo" src="${t.teamIconUrl || 'placeholder.png'}" onerror="this.src='https://placehold.co/16x16/111827/ffffff?text=${t.shortName || 'EQ'}'">
                                <span>${translateTeamName(t.teamName)}</span>
                            </div>
                            <span class="summary-team-points">${t.points} Pts</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        grid.appendChild(card);
    }

    container.appendChild(grid);
}

/* ==========================================================================
   WIDGETS Y SOPORTE DE LOADERS
   ========================================================================== */
function showLoaders() {
    document.getElementById('standingsLoader').style.display = 'flex';
    document.getElementById('matchesLoader').style.display = 'flex';
    document.getElementById('bracketLoader').style.display = 'flex';
    
    document.getElementById('standingsContainer').style.opacity = '0.3';
    document.getElementById('matchesContainer').style.opacity = '0.3';
    document.getElementById('bracketContainer').style.opacity = '0.3';
    document.getElementById('summaryContainer').style.opacity = '0.3';
}

function hideLoaders() {
    document.getElementById('standingsLoader').style.display = 'none';
    document.getElementById('matchesLoader').style.display = 'none';
    document.getElementById('bracketLoader').style.display = 'none';
    
    document.getElementById('standingsContainer').style.opacity = '1';
    document.getElementById('matchesContainer').style.opacity = '1';
    document.getElementById('bracketContainer').style.opacity = '1';
    document.getElementById('summaryContainer').style.opacity = '1';
}

function updateStatusText(text) {
    document.getElementById('updateStatusText').textContent = text;
}

/* ==========================================================================
   FUNCIONES AUXILIARES / UTILES
   ========================================================================== */
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const TEAM_TRANSLATIONS = {
    "Algerien": "Argelia",
    "Argentinien": "Argentina",
    "Australien": "Australia",
    "Belgien": "Bélgica",
    "Bosnien und Herzegowina": "Bosnia y Herzegovina",
    "Brasilien": "Brasil",
    "Curaçao": "Curazao",
    "DR Kongo": "RD Congo",
    "Deutschland": "Alemania",
    "Ecuador": "Ecuador",
    "Elfenbeinküste": "Costa de Marfil",
    "England": "Inglaterra",
    "Frankreich": "Francia",
    "Ghana": "Ghana",
    "Haiti": "Haití",
    "Irak": "Irak",
    "Iran": "Irán",
    "Japan": "Japón",
    "Jordanien": "Jordania",
    "Kanada": "Canadá",
    "Kap Verde": "Cabo Verde",
    "Katar": "Catar",
    "Kolumbien": "Colombia",
    "Kroatien": "Croacia",
    "Marokko": "Marruecos",
    "Mexiko": "México",
    "Neuseeland": "Nueva Zelanda",
    "Niederlande": "Países Bajos",
    "Norwegen": "Noruega",
    "Panama": "Panamá",
    "Paraguay": "Paraguay",
    "Portugal": "Portugal",
    "Saudi Arabien": "Arabia Saudita",
    "Schottland": "Escocia",
    "Schweden": "Suecia",
    "Schweiz": "Suiza",
    "Senegal": "Senegal",
    "Spanien": "España",
    "Südafrika": "Sudáfrica",
    "Südkorea": "Corea del Sur",
    "Tschechien": "República Checa",
    "Tunesien": "Túnez",
    "Türkei": "Turquía",
    "USA": "EE. UU.",
    "Uruguay": "Uruguay",
    "Usbekistan": "Uzbekistán",
    "Ägypten": "Egipto",
    "Österreich": "Austria"
};

function translateTeamName(name) {
    if (!name) return "";
    
    // Si existe traducción directa en el diccionario
    if (TEAM_TRANSLATIONS[name]) {
        return TEAM_TRANSLATIONS[name];
    }
    
    // Traducir cruces provisionales como "1G", "2D", etc.
    const groupMatchReg = /^([123])([A-L])$/;
    const match = name.match(groupMatchReg);
    if (match) {
        return `${match[1]}° Grupo ${match[2]}`;
    }
    
    // Traducir cruces provisionales de mejores terceros como "3 A/B/C/D/F"
    if (name.startsWith('3 ')) {
        return `3° ${name.substring(2)}`;
    }
    
    return name;
}

/* ==========================================================================
   SOBREESCRITURA DE PARTIDOS REQUERIDA POR EL USUARIO
   ========================================================================== */
function applyMatchOverrides(matches) {
    matches.forEach(m => {
        // Turquía vs EE. UU. (MatchID: 80158)
        if (m.team1.shortName === 'TUR' && m.team2.shortName === 'USA') {
            m.goals = [
                { goalID: 143894, scoreTeam1: 0, scoreTeam2: 1, matchMinute: 3, goalGetterName: "T. Weah", isPenalty: false, isOwnGoal: false, isOvertime: false },
                { goalID: 143895, scoreTeam1: 1, scoreTeam2: 1, matchMinute: 10, goalGetterName: "Arda Güler", isPenalty: false, isOwnGoal: false, isOvertime: false },
                { goalID: 143896, scoreTeam1: 2, scoreTeam2: 1, matchMinute: 31, goalGetterName: "H. Çalhanoğlu", isPenalty: false, isOwnGoal: false, isOvertime: false },
                { goalID: 143897, scoreTeam1: 2, scoreTeam2: 2, matchMinute: 49, goalGetterName: "C. Pulisic", isPenalty: false, isOwnGoal: false, isOvertime: false }
            ];
            m.matchResults = [
                { resultID: 125727, resultName: "Halbzeit", pointsTeam1: 2, pointsTeam2: 1, resultOrderID: 1, resultTypeID: 1, resultDescription: "" },
                { resultID: 125728, resultName: "Endergebnis", pointsTeam1: 2, pointsTeam2: 2, resultOrderID: 2, resultTypeID: 2, resultDescription: "" }
            ];
        }
        // Paraguay vs Australia (MatchID: 80159)
        else if (m.team1.shortName === 'PAR' && m.team2.shortName === 'AUS') {
            m.goals = [];
            m.matchResults = [
                { resultID: 125729, resultName: "Halbzeit", pointsTeam1: 0, pointsTeam2: 0, resultOrderID: 1, resultTypeID: 1, resultDescription: "" },
                { resultID: 125730, resultName: "Endergebnis", pointsTeam1: 0, pointsTeam2: 0, resultOrderID: 2, resultTypeID: 2, resultDescription: "" }
            ];
        }
    });
}

