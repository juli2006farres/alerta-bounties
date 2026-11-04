import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crearMensaje, evaluar, limpiarEstado, prefiltrar } from "../scripts/alerta.mjs";

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
