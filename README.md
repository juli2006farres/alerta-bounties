# Alerta de bounties

Cada hora busca bounties de Algora y avisa por Telegram de los que cumplen todos estos filtros:

- Más de 500 $, según el importe que publica el bot de Algora.
- Tema de seguridad, MCP o España.
- Menos de 5 PR en la tabla de intentos del bot.
- Sin pagar y sin señales de cancelación en los comentarios.

Cada bounty se avisa una sola vez. Los descartados se vuelven a revisar a los 7 días.

Funciona con GitHub Actions, sin servidor propio y con el ordenador apagado. Es gratis mientras el repositorio sea público y use los ejecutores estándar, según la [documentación de GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Limitaciones

- **No usa la API de Algora:** sus consultas públicas devuelven listas vacías, así que se leen en GitHub los issues donde ha comentado su bot.
- **Solo revisa los 100 issues actualizados más recientemente.**
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
