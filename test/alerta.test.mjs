import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crearMensaje, crearRecordatorio, evaluar, leerPaginas, limpiarEstado, prefiltrar, recordatorioPendiente } from "../scripts/alerta.mjs";

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
  it("acepta temas del nicho", () => {
    for (const title of ["Fix OAuth token leak", "Add MCP server", "Traducción a español", "SSRF in webhook"]) {
      assert.equal(prefiltrar([issue({ title })], vacio()).length, 1, title);
    }
  });

  it("no confunde author con auth ni acepta otros temas", () => {
    for (const title of ["Change author name in footer", "Add dark mode"]) {
      assert.equal(prefiltrar([issue({ title })], vacio()).length, 0, title);
    }
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
    const muchos = Array.from({ length: 40 }, (_, i) => issue({ html_url: `https://github.com/o/r/issues/${i}`, number: i }));
    assert.equal(prefiltrar(muchos, vacio()).length, 15);
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

  it("exige más de 500 $", () => {
    assert.equal(evaluar([bot("## 💎 $500 bounty")]).avisar, false);
    assert.equal(evaluar([bot("## 💎 $501 bounty")]).avisar, true);
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
