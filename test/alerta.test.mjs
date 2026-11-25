import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avisoDecretoPendiente, avisoDominioPendiente, crearAvisoDominio, avisoRevisionPendiente, buscarDecreto, crearAvisoDecreto, diasDecreto, encontrarDecreto, avisoSearchConsolePendiente, crearAvisoRevision, crearAvisoSearchConsole, crearMensaje, crearRecordatorio, evaluar, leerPaginas, limpiarEstado, prefiltrar, recordatorioPendiente } from "../scripts/alerta.mjs";

const issue = (cambios) => ({
  html_url: "https://github.com/o/r/issues/1",
  repository_url: "https://api.github.com/repos/o/r",
  number: 1,
  title: "Fix OAuth token leak",
  labels: [{ name: "💎 Bounty" }],
  body: "",
  comments_url: "https://api.github.com/repos/o/r/issues/1/comments",
  ...cambios,
});
const vacio = () => ({ vistos: {} });
const URL_ISSUE = "https://github.com/o/r/issues/1";

describe("leerPaginas", () => {
  const conUrl = (n) => issue({ html_url: `https://github.com/o/r/issues/${n}` });

  it("sigue leyendo tras una página incompleta y quita los repetidos", async () => {
    const paginas = [[conUrl(1), conUrl(2)], [conUrl(2), conUrl(3)], [conUrl(4)]];
    const r = await leerPaginas(async (p) => ({ total_count: 4, items: paginas[p - 1] }));
    assert.equal(r.length, 4);
  });

  it("para con una página vacía", async () => {
    let llamadas = 0;
    const r = await leerPaginas(async () => {
      llamadas++;
      return { total_count: 100, items: llamadas === 1 ? [conUrl(1)] : [] };
    });
    assert.equal(r.length, 1);
    assert.equal(llamadas, 2);
  });

  it("no pasa del máximo de páginas", async () => {
    let llamadas = 0;
    await leerPaginas(async () => ({ total_count: 9999, items: [conUrl(++llamadas)] }));
    assert.equal(llamadas, 5);
  });

  it("falla si GitHub cambia el formato", async () => {
    await assert.rejects(leerPaginas(async () => ({ mensaje: "x" })), /formato inesperado/);
  });
});

describe("prefiltrar", () => {
  it("acepta cualquier tema y etiqueta los del nicho", () => {
    assert.equal(prefiltrar([issue({ title: "Fix OAuth token leak" })], vacio())[0].tema, "oauth");
    assert.equal(prefiltrar([issue({ title: "Add dark mode" })], vacio())[0].tema, "otro tema");
  });

  it("no confunde author con auth al etiquetar", () => {
    assert.equal(prefiltrar([issue({ title: "Change author name in footer" })], vacio())[0].tema, "otro tema");
  });

  it("descarta los issues bloqueados y los que tienen demasiados comentarios", () => {
    assert.equal(prefiltrar([issue({ locked: true })], vacio()).length, 0);
    assert.equal(prefiltrar([issue({ comments: 31 })], vacio()).length, 0);
    assert.equal(prefiltrar([issue({ comments: 30 })], vacio()).length, 1);
  });

  it("descarta premiados y repos excluidos", () => {
    assert.equal(prefiltrar([issue({ labels: [{ name: "💰 Rewarded" }] })], vacio()).length, 0);
    assert.equal(prefiltrar([issue({ repository_url: "https://api.github.com/repos/UnsafeLabs/x" })], vacio()).length, 0);
  });

  it("no repite avisos y revisa de nuevo los descartes antiguos", () => {
    const ahora = 1_000_000_000_000;
    const con = (visto) => ({ vistos: { [URL_ISSUE]: visto } });
    assert.equal(prefiltrar([issue()], con({ fecha: 0, avisado: true }), ahora).length, 0);
    assert.equal(prefiltrar([issue()], con({ fecha: ahora, avisado: false }), ahora).length, 0);
    assert.equal(prefiltrar([issue()], con({ fecha: 0, avisado: false }), ahora).length, 1);
  });

  it("limita los candidatos por ejecución", () => {
    const muchos = Array.from({ length: 100 }, (_, i) => issue({ html_url: `https://github.com/o/r/issues/${i}`, number: i }));
    assert.equal(prefiltrar(muchos, vacio()).length, 60);
  });
});

describe("evaluar", () => {
  const bot = (body) => ({ user: { login: "algora-pbc[bot]" }, body });
  const fila = (i, solucion) => `| 🟢 @user${i} | May 14, 2026 | ${solucion} | ${solucion === "WIP" ? "" : "[Reward](x)"} |`;
  const tabla = (prs, wip = 0) =>
    [
      "## 💎 $1,500 bounty",
      "| Attempt | Started (UTC) | Solution | Actions |",
      "| --- | --- | --- | --- |",
      ...Array.from({ length: prs }, (_, i) => fila(i, `#${i + 10}`)),
      ...Array.from({ length: wip }, (_, i) => fila(i + 100, "WIP")),
    ].join("\n");

  it("lee el importe con coma o en miles", () => {
    assert.equal(evaluar([bot("## 💎 $1,500 bounty • Acme")]).dolares, 1500);
    assert.equal(evaluar([bot("💎 **$2k bounty**")]).dolares, 2000);
  });

  it("lee los decimales", () => {
    assert.equal(evaluar([bot("💎 **$1.5k bounty**")]).dolares, 1500);
    assert.equal(evaluar([bot("## 💎 $1,500.00 bounty")]).dolares, 1500);
  });

  it("descarta los bounties anunciados hace más de un año", () => {
    const ahora = Date.UTC(2026, 10, 15);
    const anunciado = (fecha) => [{ user: { login: "algora-pbc[bot]" }, body: "## 💎 $800 bounty", created_at: fecha }];
    assert.equal(evaluar(anunciado("2023-06-28T10:00:00Z"), ahora).motivo, "antiguo");
    assert.equal(evaluar(anunciado("2026-10-01T10:00:00Z"), ahora).motivo, "cumple");
  });

  it("exige 150 $ o más", () => {
    assert.equal(evaluar([bot("## 💎 $149 bounty")]).avisar, false);
    assert.equal(evaluar([bot("## 💎 $150 bounty")]).avisar, true);
  });

  it("cuenta los PR y no las filas en curso", () => {
    const r = evaluar([bot(tabla(4, 3))]);
    assert.deepEqual([r.avisar, r.prs, r.intentos], [true, 4, 7]);
  });

  it("descarta desde 5 PR", () => {
    assert.equal(evaluar([bot(tabla(5))]).motivo, "saturado");
  });

  it("descarta lo ya pagado aunque no tenga etiqueta (caso opal)", () => {
    assert.equal(evaluar([bot(tabla(1)), bot("🎉 @x has been awarded **$1,500**!")]).motivo, "pagado");
  });

  it("descarta lo cancelado (caso coolify)", () => {
    const mantenedor = { user: { login: "mant" }, body: "the Algora bounty program was stopped, payouts won't happen" };
    assert.equal(evaluar([bot(tabla(0)), mantenedor]).motivo, "cancelado");
  });

  it("ignora importes que no publica el bot", () => {
    const r = evaluar([{ user: { login: "spam" }, body: "$9,000 bounty" }]);
    assert.deepEqual([r.avisar, r.conAnuncio], [false, false]);
  });

  it("no se fía de cuentas que imitan el nombre del bot", () => {
    const r = evaluar([{ user: { login: "algora-pbc-fake" }, body: "$9,000 bounty" }]);
    assert.deepEqual([r.avisar, r.conAnuncio], [false, false]);
  });
});

describe("recordatorio anual", () => {
  const dia = (anio, mes, d) => Date.UTC(anio, mes - 1, d);

  it("no avisa antes del 15 de enero de 2027", () => {
    assert.equal(recordatorioPendiente(vacio(), dia(2026, 11, 4)), null);
    assert.equal(recordatorioPendiente(vacio(), dia(2027, 1, 14)), null);
  });

  it("avisa a partir de esa fecha, aunque GitHub se haya saltado ejecuciones", () => {
    assert.equal(recordatorioPendiente(vacio(), dia(2027, 1, 15)), 2027);
    assert.equal(recordatorioPendiente(vacio(), dia(2027, 2, 20)), 2027);
  });

  it("avisa una sola vez por año y vuelve al año siguiente", () => {
    const estado = { vistos: {}, ultimoRecordatorioIrpf: 2027 };
    assert.equal(recordatorioPendiente(estado, dia(2027, 3, 1)), null);
    assert.equal(recordatorioPendiente(estado, dia(2028, 1, 15)), 2028);
  });

  it("indica qué hay que hacer", () => {
    const texto = crearRecordatorio(2027);
    assert.ok(texto.includes("Toca actualizar el IRPF de 2027"));
    assert.ok(texto.includes("actualiza 2027"));
  });

  it("limpiarEstado conserva el año del último recordatorio", () => {
    const estado = limpiarEstado({ vistos: {}, ultimoRecordatorioIrpf: 2027 }, dia(2027, 2, 1));
    assert.equal(estado.ultimoRecordatorioIrpf, 2027);
  });
});

describe("crearMensaje y limpiarEstado", () => {
  it("incluye los datos del aviso", () => {
    const texto = crearMensaje({ repo: "o/r", numero: 1, tema: "oauth", titulo: "t", url: URL_ISSUE }, { dolares: 1500, prs: 2, intentos: 3 });
    assert.ok(texto.includes("1500 $ con 2 PR y 3 intentos"));
    assert.ok(texto.includes(URL_ISSUE));
  });

  it("olvida lo antiguo y anota el mes", () => {
    const ahora = Date.UTC(2026, 10, 4);
    const dia = 24 * 60 * 60 * 1000;
    const estado = limpiarEstado(
      {
        vistos: {
          viejo: { fecha: ahora - 20 * dia, avisado: false },
          reciente: { fecha: ahora - dia, avisado: false },
          avisado: { fecha: ahora - 20 * dia, avisado: true },
        },
      },
      ahora,
    );
    assert.deepEqual(Object.keys(estado.vistos).sort(), ["avisado", "reciente"]);
    assert.equal(estado.mes, "2026-11");
  });
});

describe("aviso del dominio", () => {
  const hora = (anio, mes, d, h) => Date.UTC(anio, mes - 1, d, h);

  it("no avisa antes del 1 de octubre de 2027 ni de noche", () => {
    assert.equal(avisoDominioPendiente(vacio(), hora(2026, 11, 25, 12)), null);
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 9, 30, 12)), null);
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 10, 1, 6)), null);
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 10, 1, 7)), 0);
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 10, 1, 21)), null);
  });

  it("avisa una vez en cada fecha y deja de avisar tras el vencimiento", () => {
    assert.equal(avisoDominioPendiente({ vistos: {}, avisoDominio: 0 }, hora(2027, 10, 20, 12)), null);
    assert.equal(avisoDominioPendiente({ vistos: {}, avisoDominio: 0 }, hora(2027, 11, 1, 9)), 1);
    assert.equal(avisoDominioPendiente({ vistos: {}, avisoDominio: 1 }, hora(2027, 11, 15, 9)), 2);
    assert.equal(avisoDominioPendiente({ vistos: {}, avisoDominio: 2 }, hora(2027, 11, 22, 9)), 3);
    assert.equal(avisoDominioPendiente({ vistos: {}, avisoDominio: 3 }, hora(2027, 11, 24, 9)), null);
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 11, 26, 9)), null);
  });

  it("si GitHub se retrasa, manda solo la última fecha pasada", () => {
    assert.equal(avisoDominioPendiente(vacio(), hora(2027, 11, 16, 9)), 2);
  });

  it("el mensaje dice la fecha, los días que quedan y la frase", () => {
    const texto = crearAvisoDominio(hora(2027, 10, 1, 7));
    assert.match(texto, /25 de noviembre de 2027/);
    assert.match(texto, /quedan 55 días/);
    assert.match(texto, /^renovación del dominio$/m);
  });
});

describe("avisos de la web", () => {
  const hora = (mes, d, h) => Date.UTC(2026, mes - 1, d, h);

  it("Search Console: empieza el 21 de noviembre y solo de 8:00 a 22:00 de España", () => {
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(11, 20, 12)), false);
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(11, 21, 6)), false);
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(11, 21, 7)), true);
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(11, 21, 20)), true);
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(11, 21, 21)), false);
  });

  it("Search Console: cada 2 días, aunque GitHub se retrase", () => {
    const estado = { vistos: {}, ultimoAvisoSearchConsole: hora(11, 21, 14) };
    assert.equal(avisoSearchConsolePendiente(estado, hora(11, 21, 20)), false);
    assert.equal(avisoSearchConsolePendiente(estado, hora(11, 22, 14)), false);
    assert.equal(avisoSearchConsolePendiente(estado, hora(11, 23, 4)), false);
    assert.equal(avisoSearchConsolePendiente(estado, hora(11, 23, 7)), true);
    assert.equal(avisoSearchConsolePendiente({ vistos: {}, ultimoAvisoSearchConsole: hora(11, 21, 20) }, hora(11, 23, 8)), true);
  });

  it("Search Console: deja de avisar el 11 de diciembre", () => {
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(12, 10, 14)), true);
    assert.equal(avisoSearchConsolePendiente(vacio(), hora(12, 11, 14)), false);
  });

  it("Search Console: el mensaje dice exactamente qué escribir", () => {
    const texto = crearAvisoSearchConsole();
    assert.ok(texto.includes("\nya he entrado en Search Console\n"));
    assert.ok(texto.includes("search.google.com/search-console"));
  });

  it("revisión: una sola vez, desde el 15 de diciembre", () => {
    assert.equal(avisoRevisionPendiente(vacio(), hora(12, 15, 7)), false);
    assert.equal(avisoRevisionPendiente(vacio(), hora(12, 15, 8)), true);
    assert.equal(avisoRevisionPendiente({ vistos: {}, revisionWebAvisada: true }, hora(12, 20, 9)), false);
    assert.ok(crearAvisoRevision().endsWith("\nrevisa los números de la web"));
  });

  it("limpiarEstado conserva las marcas de los avisos", () => {
    const estado = limpiarEstado({ vistos: {}, ultimoAvisoSearchConsole: 5, revisionWebAvisada: true }, hora(12, 1, 0));
    assert.equal(estado.ultimoAvisoSearchConsole, 5);
    assert.equal(estado.revisionWebAvisada, true);
  });
});

describe("aviso del decreto de los autónomos en el BOE", () => {
  const hora = (anio, mes, d, h) => Date.UTC(anio, mes - 1, d, h);
  const TITULO = "Real Decreto-ley 18/2026, de 24 de noviembre, por el que se prorroga para 2027 la aplicación del Impuesto sobre el margen de intereses y comisiones de determinadas entidades financieras, se adoptan medidas de naturaleza tributaria para incentivar la actividad económica llevada a cabo por los trabajadores autónomos y por el que se establecen medidas urgentes para el impulso de la competitividad económica.";
  // Misma forma que el sumario de datos abiertos del BOE: «item» puede ser una lista o un solo objeto.
  const sumario = (items) => ({
    status: { code: "200" },
    data: { sumario: { diario: [{ numero: "293", seccion: [{ codigo: "1", departamento: [
      { codigo: "1", nombre: "JEFATURA DEL ESTADO", epigrafe: { nombre: "Medidas urgentes", item: items } },
      { codigo: "2", nombre: "OTRO", epigrafe: [{ nombre: "Ayudas", item: [{ identificador: "BOE-A-2026-1", titulo: "Real Decreto 5/2026, sobre ayudas a la vivienda." }] }] },
    ] }] }] } },
  });
  const decreto = { identificador: "BOE-A-2026-24700", titulo: TITULO };

  it("encuentra el decreto tanto si el apartado es una lista como si es un solo objeto", () => {
    for (const items of [decreto, [{ identificador: "BOE-A-2026-2", titulo: "Orden de pesca." }, decreto]]) {
      const r = buscarDecreto(sumario(items));
      assert.equal(r.identificador, "BOE-A-2026-24700");
      assert.equal(r.url, "https://www.boe.es/buscar/doc.php?id=BOE-A-2026-24700");
    }
  });

  it("no confunde otros decretos ni otras normas sobre autónomos", () => {
    assert.equal(buscarDecreto(sumario([{ identificador: "BOE-A-2026-3", titulo: "Real Decreto-ley 9/2026, de vivienda." }])), null);
    assert.equal(buscarDecreto(sumario([{ identificador: "BOE-A-2026-4", titulo: "Orden por la que se regulan las ayudas a trabajadores autónomos." }])), null);
    assert.equal(buscarDecreto({ data: null }), null);
  });

  it("solo avisa una vez, desde el 24 de noviembre y de 8:00 a 22:00 de España", () => {
    assert.equal(avisoDecretoPendiente(vacio(), hora(2026, 11, 23, 12)), false);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2026, 11, 24, 22)), false);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2026, 11, 25, 6)), false);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2026, 11, 25, 7)), true);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2026, 11, 25, 21)), false);
    assert.equal(avisoDecretoPendiente({ vistos: {}, decretoBoeAvisado: "BOE-A-2026-24700" }, hora(2026, 11, 26, 10)), false);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2027, 1, 31, 10)), true);
    assert.equal(avisoDecretoPendiente(vacio(), hora(2027, 2, 1, 10)), false);
  });

  it("mira los últimos 7 días sin pasar del 24 de noviembre", () => {
    assert.deepEqual(diasDecreto(hora(2026, 11, 25, 9)), ["20261124", "20261125"]);
    assert.deepEqual(diasDecreto(hora(2026, 11, 27, 9)), ["20261124", "20261125", "20261126", "20261127"]);
    assert.deepEqual(diasDecreto(hora(2026, 12, 10, 9)), ["20261204", "20261205", "20261206", "20261207", "20261208", "20261209", "20261210"]);
  });

  it("encuentra el decreto en un día anterior aunque el de hoy aún no exista", async () => {
    const pedidos = [];
    const r = await encontrarDecreto(async (dia) => {
      pedidos.push(dia);
      if (dia === "20261128") return null;
      return sumario(dia === "20261126" ? decreto : []);
    }, hora(2026, 11, 28, 9));
    assert.equal(r.identificador, "BOE-A-2026-24700");
    assert.deepEqual(pedidos, ["20261124", "20261125", "20261126"]);
    assert.equal(await encontrarDecreto(async () => null, hora(2026, 11, 28, 9)), null);
  });

  it("el mensaje dice exactamente qué escribir y enlaza el BOE", () => {
    const texto = crearAvisoDecreto(buscarDecreto(sumario(decreto)));
    assert.ok(texto.endsWith("\nha salido el decreto en el BOE"));
    assert.ok(texto.includes("https://www.boe.es/buscar/doc.php?id=BOE-A-2026-24700"));
    assert.ok(texto.includes("...") && texto.length < 4096);
  });
});
