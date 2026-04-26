# Despliegue en VPS Ubuntu

Guía paso a paso para correr el buscador de radicados todas las noches en una
VPS con Ubuntu y recibir el PDF consolidado por Telegram.

> Diseñado para Ubuntu 22.04 / 24.04. Los comandos asumen que tienes acceso
> `sudo`. Reemplaza `radicados` por otro usuario si quieres, pero usa el mismo
> nombre en todos los archivos del directorio `deploy/`.

## 1) Crear el bot de Telegram (saltar si ya tienes token + chat_id)

1. En Telegram, abre un chat con [`@BotFather`](https://t.me/BotFather).
2. `/newbot` → elige nombre y username. Guarda el **token** que te entrega
   (formato `123456789:ABC...`).
3. Abre un chat con tu nuevo bot y mándale cualquier mensaje (ej. `hola`).
4. Para obtener tu `chat_id`, abre en el navegador:

   ```
   https://api.telegram.org/bot<TU_TOKEN>/getUpdates
   ```

   En el JSON busca `"chat":{"id": 123456789, ...}`. Ese número es tu
   `TELEGRAM_CHAT_ID`. (Si quieres recibirlo en un grupo, agrega el bot al
   grupo, manda un mensaje y revisa `getUpdates` — el id de grupo es
   negativo.)

## 2) Preparar la VPS (una sola vez, como root o con `sudo`)

### 2.1 Crear usuario dedicado

```bash
sudo adduser --disabled-password --gecos "" radicados
```

### 2.2 Instalar Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v   # debe imprimir v22.x
```

### 2.3 Configurar zona horaria a Bogotá

```bash
sudo timedatectl set-timezone America/Bogota
```

## 3) Clonar el repo y instalar dependencias (como `radicados`)

```bash
sudo -iu radicados
git clone https://github.com/introduccionalderechofvp-star/buscador-radicados-vps.git app
cd app
git checkout claude/deploy-ubuntu-vps-w9dfD   # mientras la rama no esté en main
npm ci
```

### 3.1 Instalar Chromium y sus dependencias del sistema

`install-deps` necesita root, los demás corren como `radicados`:

```bash
exit                                    # vuelve a tu usuario sudo
sudo npx --yes -p playwright@1.47.0 playwright install-deps chromium
sudo -iu radicados
cd app
npx playwright install chromium         # ~150 MB, en ~/.cache/ms-playwright
```

### 3.2 Smoke test (consulta puntual sin notificación)

```bash
node consultar.js 05266310300120130032400
ls resultados/$(date +%F)/
```

Deberías ver una `captura_*.png`, un `actuaciones_*.json` y, según el
script, un `consolidado_*.pdf`. Si esto funciona, la parte de Playwright
está bien y solo falta agendar.

## 4) Configurar las credenciales de Telegram

Como root:

```bash
sudo cp /home/radicados/app/deploy/radicados.env.example /etc/radicados.env
sudo chown root:radicados /etc/radicados.env
sudo chmod 640 /etc/radicados.env
sudo nano /etc/radicados.env       # pega TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
```

Probar el envío con la última corrida del smoke test:

```bash
sudo -u radicados \
  bash -c 'set -a; source /etc/radicados.env; set +a; cd /home/radicados/app && node notificar.js'
```

Si te llega el PDF a Telegram, listo.

## 5) Instalar las unidades systemd

```bash
sudo cp /home/radicados/app/deploy/radicados.service          /etc/systemd/system/
sudo cp /home/radicados/app/deploy/radicados.timer            /etc/systemd/system/
sudo cp /home/radicados/app/deploy/radicados-failure.service  /etc/systemd/system/
sudo cp /home/radicados/app/deploy/radicados-cleanup.service  /etc/systemd/system/
sudo cp /home/radicados/app/deploy/radicados-cleanup.timer    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now radicados.timer radicados-cleanup.timer
```

Verificar que el timer esté activo:

```bash
systemctl list-timers | grep radicados
```

Deberías ver la próxima ejecución a las **02:30** hora Bogotá.

## 6) Probar la corrida completa manualmente

```bash
sudo systemctl start radicados.service
journalctl -u radicados.service -f
```

Cuando termine, debería llegarte el PDF a Telegram. La corrida completa
de los ~97 radicados toma entre 20 y 60 min según la latencia del portal.

## 7) Mantenimiento

### Editar la lista de radicados

Edita `radicados.md` desde tu máquina y haz `git push`. El `.service`
hace `git pull --ff-only` antes de cada corrida (línea `ExecStartPre`),
así que el cambio aplica en la próxima ejecución.

Si quieres editar directamente en la VPS:

```bash
sudo -iu radicados
cd app && nano radicados.md && git commit -am "ajusta radicados" && git push
```

### Ver logs

```bash
journalctl -u radicados.service -n 200 --no-pager      # última corrida
journalctl -u radicados.service --since "yesterday"
```

### Forzar una corrida ahora

```bash
sudo systemctl start radicados.service
```

### Cambiar la hora

Edita `OnCalendar` en `/etc/systemd/system/radicados.timer` y:

```bash
sudo systemctl daemon-reload
sudo systemctl restart radicados.timer
```

### Borrar resultados antiguos a mano

```bash
sudo systemctl start radicados-cleanup.service
```

(El timer lo corre automáticamente cada domingo a las 03:30.)

## 8) Solución de problemas

| Síntoma | Probable causa | Qué revisar |
|---|---|---|
| `playwright: error while loading shared libraries` | Faltan deps de Chromium | Repetir `sudo npx playwright install-deps chromium` |
| Telegram responde `chat not found` | El bot no ha recibido el primer mensaje del chat (o `chat_id` mal copiado) | Mándale `/start` al bot desde el chat objetivo |
| Telegram responde `Request Entity Too Large` | El PDF pasó de 50 MB | Reducir radicados o comprimir con `gs -dPDFSETTINGS=/ebook` antes de enviar |
| `git pull` pide credenciales en `ExecStartPre` | El repo clonó por HTTPS y es privado | Cambiar a deploy key SSH: `git remote set-url origin git@github.com:...` y agregar la clave a la cuenta |
| El timer no dispara | Servidor estuvo apagado a las 02:30 | `Persistent=true` ya está, debe correr al arrancar; revisar con `systemctl list-timers` |

## 9) Recursos esperados

- **RAM**: ~500 MB pico durante la corrida (Chromium headless).
- **Disco por corrida**: ~15 MB de PDF + ~30–40 MB de capturas/JSON.
- **Disco con rotación 60 días**: ~3 GB en steady state.
- **CPU**: 1 vCPU es suficiente; la corrida es bound por la latencia del
  portal de la Rama, no por CPU.
