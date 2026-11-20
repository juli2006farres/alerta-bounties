// Busca bounties de Algora en GitHub y avisa por Telegram de los que cumplen los filtros.
// GitHub Actions ejecuta este script cada hora, así que no hace falta tener el ordenador encendido.
// El contenido de los issues son datos ajenos: solo se extraen campos concretos y se tratan como texto.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---- Filtros: cámbialos aquí ----
const MINIMO_DOLARES = 150; // se avisa desde este importe, incluido
const MAXIMO_PR = 5;
// Ya no es un filtro: se acepta cualquier tema y este solo se usa para etiquetar el aviso.
const TEMAS = /\b(security|vulnerabilit\w*|cve|auth|authentication|authorization|oauth|oidc|saml|rbac|sso|encryption|sandbox\w*|injection|ssrf|xss|csrf|mcp|model context protocol|spain|spanish|espa(ñ|n)a|espa(ñ|n)ol|irpf|catalonia|catalunya|cataluña)\b/i;
// Repos descartados porque sus importes no se pudieron confirmar.
const REPOS_EXCLUIDOS = ["ClankerNation/", "UnsafeLabs/"];
// La tabla del bot no recoge todas las soluciones: muchos comentarios suelen indicar mucha competencia.
const MAXIMO_COMENTARIOS = 30;
// Un bounty anunciado hace más de un año suele estar abandonado aunque siga abierto.
const ANTIGUEDAD_MAXIMA_DIAS = 365;

// Cada candidato es una consulta a GitHub, que permite 1.000 por hora en Actions.
const MAXIMO_POR_EJECUCION = 60;
const SIETE_DIAS = 7 * 24 * 60 * 60 * 1000;
const UN_ANIO = 365 * 24 * 60 * 60 * 1000;
const ARCHIVO_ESTADO = "estado/vistos.json";
const BUSQUEDA = "commenter:app/algora-pbc is:issue is:open";

const CANCELADO = /(bount(y|ies)|algora).{0,80}(stopped|cancel+ed|discontinued|withdrawn|no longer)|(stopped|cancel+ed|discontinued|withdrawn|no longer).{0,80}(bount(y|ies)|algora)/is;
const IMPORTE = /\$\s?(\d[\d,]*(?:\.\d+)?)(k?)[\s*]*bounty/i;
const BOT_ALGORA = "algora-pbc[bot]";
const MAXIMO_PAGINAS = 5;
// Último año con datos fiscales en el servidor de IRPF.
const ULTIMO_ANIO_CON_DATOS = 2026;

// Lee varias páginas de resultados. GitHub puede devolver páginas incompletas aunque queden más,
// así que solo se para con una página vacía o con todos leídos. Un issue puede salir dos veces
// si cambia de posición mientras se lee: sin quitar los repetidos, se avisaría dos veces.
export async function leerPaginas(pedirPagina) {
  const porUrl = new Map();
  for (let pagina = 1; pagina <= MAXIMO_PAGINAS; pagina++) {
    const { items, total_count: total } = await pedirPagina(pagina);
    // Mejor fallar y que GitHub te avise que aparentar que no hay bounties.
    if (!Array.isArray(items)) throw new Error("GitHub ha devuelto un formato inesperado");
    for (const issue of items) porUrl.set(issue.html_url, issue);
    if (items.length === 0 || porUrl.size >= total) break;
  }
  return [...porUrl.values()];
}

// Paso 1: se queda con los issues que aún no se han revisado.
export function prefiltrar(items, estado, ahora = Date.now()) {
  const candidatos = [];
  for (const issue of items) {
    const repo = issue.repository_url.split("/").slice(-2).join("/");
    const etiquetas = issue.labels.map((l) => l.name);
    const visto = estado.vistos[issue.html_url];

    if (visto && (visto.avisado || ahora - visto.fecha < SIETE_DIAS)) continue;
    if (REPOS_EXCLUIDOS.some((r) => repo.startsWith(r))) continue;
    if (etiquetas.some((e) => /rewarded/i.test(e))) continue;
    // Bloqueado: los responsables han cerrado la conversación, a menudo por spam.
    if (issue.locked) continue;
    if ((issue.comments ?? 0) > MAXIMO_COMENTARIOS) continue;

    const texto = `${issue.title} ${etiquetas.join(" ")} ${String(issue.body ?? "").slice(0, 1500)}`;
    const tema = texto.match(TEMAS)?.[0].toLowerCase() ?? "otro tema";

    candidatos.push({
      url: issue.html_url,
      repo,
      numero: issue.number,
      titulo: issue.title.slice(0, 150),
      tema,
      urlComentarios: `${issue.comments_url}?per_page=100`,
    });
    if (candidatos.length >= MAXIMO_POR_EJECUCION) break;
  }
  return candidatos;
}

// El bot mantiene una tabla con una fila por intento: | 🟢 @usuario | fecha | #57 | Reward |
// Si la tercera columna tiene un número de PR, ese intento ya ha enviado su solución.
function contarTabla(cuerpo) {
  let intentos = 0;
  let prs = 0;
  for (const linea of cuerpo.split("\n")) {
    if (!/^\|[^|]*@[^|]*\|/.test(linea)) continue;
    intentos++;
    if (/#\d+/.test(linea.split("|")[3] ?? "")) prs++;
  }
  return { intentos, prs };
}

// Paso 2: decide con los comentarios. Aquí se detecta lo que falló con opal #661: un bounty
// ya pagado cuyas etiquetas se han retirado. Solo cuenta lo que publica el bot de Algora.
export function evaluar(comentarios, ahora = Date.now()) {
  // Nombre exacto: cualquiera podría crear una cuenta con "algora" en el nombre.
  const delBot = comentarios.filter((c) => c.user?.login === BOT_ALGORA);
  const anuncio = delBot.find((c) => IMPORTE.test(String(c.body)));
  const conAnuncio = Boolean(anuncio);

  if (delBot.some((c) => /has been awarded/i.test(String(c.body)))) return { avisar: false, conAnuncio, motivo: "pagado" };
  if (comentarios.some((c) => CANCELADO.test(String(c.body ?? "")))) return { avisar: false, conAnuncio, motivo: "cancelado" };
  if (!anuncio) return { avisar: false, conAnuncio, motivo: "sin importe" };
  const anunciado = Date.parse(anuncio.created_at ?? "");
  if (ahora - anunciado > ANTIGUEDAD_MAXIMA_DIAS * 24 * 60 * 60 * 1000) {
    return { avisar: false, conAnuncio, motivo: "antiguo" };
  }

  const cuerpo = String(anuncio.body);
  const coincidencia = cuerpo.match(IMPORTE);
  const dolares = Number(coincidencia[1].replace(/,/g, "")) * (coincidencia[2] ? 1000 : 1);
  const { intentos, prs } = contarTabla(cuerpo);

  if (dolares < MINIMO_DOLARES) return { avisar: false, conAnuncio, motivo: "importe bajo", dolares, prs, intentos };
  if (prs >= MAXIMO_PR) return { avisar: false, conAnuncio, motivo: "saturado", dolares, prs, intentos };
  return { avisar: true, conAnuncio, motivo: "cumple", dolares, prs, intentos };
}

// Va como texto plano para que un título malicioso no pueda colar formato ni enlaces disfrazados.
export function crearMensaje(candidato, { dolares, prs, intentos }) {
  return [
    `Bounty candidato: ${dolares} $ con ${prs} PR y ${intentos} intentos`,
    `${candidato.repo} #${candidato.numero} (${candidato.tema})`,
    candidato.titulo,
    candidato.url,
    "Antes de empezar, comprueba que un mantenedor siga activo y que el repositorio acepte PR externos.",
  ].join("\n");
}

// Recordatorio anual para añadir los datos fiscales del año nuevo al servidor de IRPF.
// No va en una tarea propia del 15 de enero porque GitHub puede saltarse ejecuciones:
// así se envía en la primera que ocurra a partir de ese día, y una sola vez al año.
export function recordatorioPendiente(estado, ahora = Date.now()) {
  const anio = new Date(ahora).getUTCFullYear();
  if (ahora < Date.UTC(anio, 0, 15)) return null;
  return anio > (estado.ultimoRecordatorioIrpf ?? ULTIMO_ANIO_CON_DATOS) ? anio : null;
}

export function crearRecordatorio(anio) {
  return [
    `Toca actualizar el IRPF de ${anio}.`,
    `Hay que revisar las escalas y mínimos de las 15 comunidades, las tablas de la cuota de autónomos y el calendario fiscal de ${anio + 1}, en el servidor MCP y en la web.`,
    `Abre Claude Code en la carpeta del proyecto y escribe: actualiza ${anio}.`,
    `Mientras tanto, el servidor rechaza ${anio} y los años anteriores siguen funcionando.`,
  ].join("\n");
}

// Avisos de la web de calculadoras. Igual que el anual, se envían en la primera ejecución que
// toque: GitHub puede retrasar o saltarse alguna, así que no se fía de una hora exacta.
// - Search Console: cada 2 días, a partir de las 18:00 de España (17:00 UTC en invierno),
//   mientras queden páginas por pedir a Google. Cada día solo se pueden pedir unas 10.
// - Revisión de números: una sola vez, a partir del 15 de diciembre de 2026.
const SEARCH_CONSOLE = { desde: Date.UTC(2026, 10, 21), hasta: Date.UTC(2026, 11, 11), horaUtc: 17, cadaDias: 2 };
const REVISION_WEB = Date.UTC(2026, 11, 15, 8);
const DIA = 24 * 60 * 60 * 1000;
const numeroDeDia = (instante) => Math.floor(instante / DIA);

export function avisoSearchConsolePendiente(estado, ahora = Date.now()) {
  if (ahora < SEARCH_CONSOLE.desde || ahora >= SEARCH_CONSOLE.hasta) return false;
  if (new Date(ahora).getUTCHours() < SEARCH_CONSOLE.horaUtc) return false;
  const ultimo = estado.ultimoAvisoSearchConsole;
  return ultimo === undefined || numeroDeDia(ahora) - numeroDeDia(ultimo) >= SEARCH_CONSOLE.cadaDias;
}

export function crearAvisoSearchConsole() {
  return [
    "Toca pedir a Google que mire más páginas de tu web (5 minutos).",
    "",
    "1. Abre la app de Claude en el ordenador.",
    "2. En el navegador de la app, entra en search.google.com/search-console con tu cuenta de Google.",
    "3. Escribe a Claude exactamente esto:",
    "",
    "ya he entrado en Search Console",
    "",
    "Claude hace el resto. Si hoy no puedes, no pasa nada: te vuelvo a avisar en 2 días.",
  ].join("\n");
}

export function avisoRevisionPendiente(estado, ahora = Date.now()) {
  return ahora >= REVISION_WEB && !estado.revisionWebAvisada;
}

export function crearAvisoRevision() {
  return [
    "Toca revisar cómo va la web de calculadoras (10 minutos).",
    "",
    "1. Abre la app de Claude en el ordenador.",
    "2. En el navegador de la app, entra en search.google.com/search-console y en el panel de Quipu (quipu.getrewardful.com).",
    "3. Escribe a Claude exactamente esto:",
    "",
    "revisa los números de la web",
  ].join("\n");
}

// Olvida lo antiguo para que el archivo no crezca sin límite.
export function limpiarEstado(estado, ahora = Date.now()) {
  for (const [url, visto] of Object.entries(estado.vistos)) {
    if (ahora - visto.fecha > (visto.avisado ? UN_ANIO : SIETE_DIAS * 2)) delete estado.vistos[url];
  }
  // Cambia una vez al mes: GitHub apaga las tareas programadas tras 60 días sin actividad.
  estado.mes = new Date(ahora).toISOString().slice(0, 7);
  return estado;
}

async function pedirGithub(url, token) {
  const cabeceras = {
    Accept: "application/vnd.github+json",
    "User-Agent": "alerta-bounties",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) cabeceras.Authorization = `Bearer ${token}`;
  const respuesta = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(30_000) });
  if (!respuesta.ok) throw new Error(`GitHub ha respondido con el estado ${respuesta.status}`);
  return respuesta.json();
}

async function enviarTelegram(texto, tokenBot, chatId) {
  let respuesta;
  try {
    respuesta = await fetch(`https://api.telegram.org/bot${tokenBot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // El error original incluye la URL y, con ella, el token: no se copia.
    throw new Error("No se ha podido conectar con Telegram");
  }
  if (!respuesta.ok) {
    throw new Error(`Telegram ha respondido con el estado ${respuesta.status}. Revisa los secretos del token y del chat.`);
  }
}

function leerEstado() {
  if (!existsSync(ARCHIVO_ESTADO)) return { vistos: {} };
  const estado = JSON.parse(readFileSync(ARCHIVO_ESTADO, "utf8"));
  estado.vistos = estado.vistos ?? {};
  return estado;
}

async function principal() {
  const simular = process.argv.includes("--simular");
  const tokenBot = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!simular) {
    if (!tokenBot) throw new Error("Falta el secreto TELEGRAM_BOT_TOKEN");
    if (!/^-?\d+$/.test(chatId ?? "")) throw new Error("El secreto TELEGRAM_CHAT_ID debe ser un número");
  }

  if (process.env.PROBAR_TELEGRAM === "true") {
    await enviarTelegram("Prueba correcta: las alertas de bounties pueden escribirte.", tokenBot, chatId);
    console.log("Mensaje de prueba enviado");
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const issues = await leerPaginas((pagina) => {
    const parametros = new URLSearchParams({ q: BUSQUEDA, sort: "updated", order: "desc", per_page: "100", page: String(pagina) });
    return pedirGithub(`https://api.github.com/search/issues?${parametros}`, token);
  });

  const estado = leerEstado();
  const candidatos = prefiltrar(issues, estado);
  console.log(`Recibidos: ${issues.length} | candidatos: ${candidatos.length}`);

  let fallos = 0;
  let conAnuncio = 0;
  let avisos = 0;
  try {
    for (const candidato of candidatos) {
      let comentarios;
      try {
        comentarios = await pedirGithub(candidato.urlComentarios, token);
      } catch {
        // No se marca como visto: se reintenta en la siguiente ejecución.
        fallos++;
        continue;
      }

      const resultado = evaluar(comentarios);
      if (resultado.conAnuncio) conAnuncio++;
      console.log(`${candidato.repo}#${candidato.numero}: ${resultado.motivo} (${resultado.dolares ?? "?"} $, ${resultado.prs ?? "?"} PR)`);

      if (resultado.avisar) {
        const mensaje = crearMensaje(candidato, resultado);
        if (simular) console.log(`--- Aviso simulado ---\n${mensaje}`);
        else await enviarTelegram(mensaje, tokenBot, chatId);
        avisos++;
      }
      // Se marca después de enviar: si Telegram falla, se reintenta la hora siguiente.
      estado.vistos[candidato.url] = { fecha: Date.now(), avisado: resultado.avisar };
    }

    const anioRecordatorio = recordatorioPendiente(estado);
    if (anioRecordatorio) {
      const mensaje = crearRecordatorio(anioRecordatorio);
      if (simular) console.log(`--- Recordatorio simulado ---\n${mensaje}`);
      else await enviarTelegram(mensaje, tokenBot, chatId);
      // Se anota después de enviar: si Telegram falla, se reintenta en la siguiente ejecución.
      estado.ultimoRecordatorioIrpf = anioRecordatorio;
    }

    // Avisos de la web. Se anotan después de enviarlos, por el mismo motivo.
    if (avisoSearchConsolePendiente(estado)) {
      const mensaje = crearAvisoSearchConsole();
      if (simular) console.log(`--- Aviso simulado ---\n${mensaje}`);
      else await enviarTelegram(mensaje, tokenBot, chatId);
      estado.ultimoAvisoSearchConsole = Date.now();
    }
    if (avisoRevisionPendiente(estado)) {
      const mensaje = crearAvisoRevision();
      if (simular) console.log(`--- Aviso simulado ---\n${mensaje}`);
      else await enviarTelegram(mensaje, tokenBot, chatId);
      estado.revisionWebAvisada = true;
    }
  } finally {
    if (!simular) writeFileSync(ARCHIVO_ESTADO, `${JSON.stringify(limpiarEstado(estado), null, 2)}\n`);
  }

  console.log(`Avisos: ${avisos} | fallos de lectura: ${fallos}`);
  if (candidatos.length > 0 && fallos === candidatos.length) throw new Error("No se ha podido leer ningún candidato");
  // Si el bot cambia su formato, los importes dejarían de detectarse sin que nada fallara.
  const leidos = candidatos.length - fallos;
  if (leidos >= 5 && conAnuncio === 0) throw new Error("Ningún comentario del bot tiene un importe reconocible: quizá ha cambiado de formato");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}
