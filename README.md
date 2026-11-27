# Alerta de bounties

Varias veces al día busca bounties de Algora y avisa por Telegram de los que cumplen todos estos filtros:

- 150 $ o más, según el importe que publica el bot de Algora.
- Cualquier tema. El aviso indica si es de seguridad, MCP o España.
- Menos de 5 PR en la tabla de intentos del bot.
- Fuera de los repositorios excluidos, cuyos importes no se pudieron confirmar.
- Anunciado hace menos de un año, porque los más antiguos suelen estar abandonados.
- Sin bloquear y con 30 comentarios o menos. La tabla del bot no recoge todas las soluciones enviadas, y muchos comentarios suelen indicar mucha competencia.
- Sin pagar y sin señales de cancelación en los comentarios.

Cada bounty se avisa una sola vez. Los descartados se vuelven a revisar a los 7 días.

Funciona con GitHub Actions, sin servidor propio y con el ordenador apagado. Es gratis mientras el repositorio sea público y use los ejecutores estándar, según la [documentación de GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Recordatorio del IRPF

Cada año, en la primera ejecución a partir del 15 de enero, envía un único mensaje por Telegram para añadir al servidor de IRPF los datos fiscales del año nuevo. El primero será en enero de 2027. El año del último aviso se guarda en `estado/vistos.json`. El recordatorio no cambia ningún dato del servidor.

## Avisos de la web de calculadoras

- **Search Console:** cada 2 días, entre las 8:00 y las 22:00 (hora de España) y del 21 de noviembre al 10 de diciembre de 2026, recuerda entrar en Google Search Console desde la app de Claude y escribir «ya he entrado en Search Console». Así se pide a Google que mire las páginas nuevas, unas 10 al día.
- **Revisión:** una sola vez, a partir del 15 de diciembre de 2026, recuerda escribir «revisa los números de la web».
- **Decreto de los autónomos:** de 8:00 a 22:00 (hora de España), hasta el 31 de enero de 2027, mira el sumario diario del BOE de los últimos 7 días (datos abiertos oficiales, `boe.es/datosabiertos/api/boe/sumario/AAAAMMDD`). Cuando sale el real decreto-ley aprobado el 24 de noviembre de 2026 (IRPF de 2026, pagos trimestrales y Verifactu), avisa una sola vez con el enlace y la frase «ha salido el decreto en el BOE». Si el BOE falla, no para el resto y se vuelve a mirar en la siguiente ejecución.
- **Convalidación del decreto:** de 8:00 a 22:00 (hora de España), del 26 de noviembre de 2026 al 28 de febrero de 2027, mira el sumario del BOE de los últimos 7 días. Cuando sale la resolución del Congreso sobre el Real Decreto-ley 43/2026, avisa una sola vez: si lo convalida, con la frase «se ha convalidado el decreto»; si lo deroga, con un aviso urgente y la frase «se ha derogado el decreto».
- **Dominio:** calculadorasautonomos.es vence el 25 de noviembre de 2027 y tiene la renovación automática desactivada. Avisa el 1 de octubre y el 1, 15 y 22 de noviembre de 2027, de 8:00 a 22:00 (hora de España), con la frase «renovación del dominio». Si GitHub se retrasa y han pasado varias fechas, solo manda la última.

Las marcas de envío se guardan en `estado/vistos.json`, como la del recordatorio anual.

## Limitaciones

- **No usa la API de Algora:** sus consultas públicas devuelven listas vacías, así que se leen en GitHub los issues donde ha comentado su bot.
- **Revisa hasta 500 issues:** los actualizados más recientemente, en cinco páginas de resultados.
- **No es exacto al minuto:** GitHub puede retrasar o, con mucha carga, saltarse alguna ejecución.
- **El aviso no garantiza el cobro:** antes de empezar, comprueba que un mantenedor siga activo y que el repositorio acepte PR externos.

## Secretos

Se guardan en *Settings → Secrets and variables → Actions* y nunca en el código:

| Secreto | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token de tu bot, de `@BotFather` |
| `TELEGRAM_CHAT_ID` | Tu número de chat, de `@userinfobot` |

El token de GitHub lo genera Actions en cada ejecución, así que no hay que crear ninguno.

## Uso

- **Probar Telegram:** en la pestaña *Actions*, abre *Alerta de bounties*, pulsa *Run workflow*, marca la casilla de prueba y ejecuta.
- **Si algo falla:** GitHub suele avisarte por correo, y el motivo aparece en el registro de esa ejecución. Ese registro es público, pero no contiene los secretos.
- **Pausar:** en *Actions*, abre *Alerta de bounties*, pulsa **⋯** y elige *Disable workflow*.
- **Cambiar los filtros:** edita las constantes del principio de `scripts/alerta.mjs`.

Para comprobarlo en tu equipo sin enviar nada:

```bash
node --test "test/*.test.mjs"
```

```bash
node scripts/alerta.mjs --simular
```
