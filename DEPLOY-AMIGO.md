# Despliegue paralelo: instancia para el amigo (correo)

Esta guía agrega una **segunda instancia** del buscador en la misma VPS,
sin tocar nada de la instancia tuya. Diferencias clave:

|  | Tuyo (existente) | Amigo (nuevo) |
|---|---|---|
| Usuario Linux | `radicados` | `radicados-amigo` |
| Repo | `/home/radicados/app` | `/home/radicados-amigo/app` |
| Lista | `radicados.md` | `radicados-amigo.md` |
| Env | `/etc/radicados.env` | `/etc/radicados-amigo.env` |
| Consulta | 02:30 Bogotá | **04:00 Bogotá** |
| Notificación | 06:00 (Telegram) | **06:00 (correo)** |
| Canal | Telegram bot | SMTP |

> Las consultas están escalonadas (02:30 vs 04:00) para no correr dos
> Chromium en paralelo. Las notificaciones a las 06:00 sí coinciden, pero
> son procesos cortos (segundos) y usan canales distintos, así que no
> hay choque de recursos.

## 1) Crear la cuenta de Gmail dedicada (si todavía no la tienes)

Ya cubierto en la conversación: cuenta nueva → activar 2FA → generar
**App Password** de 16 caracteres en `myaccount.google.com/apppasswords`.

Datos que vas a necesitar después:

```
SMTP_USER  = correo_dedicado@gmail.com
SMTP_PASS  = los 16 caracteres del App Password (sin espacios)
EMAIL_FROM = correo_dedicado@gmail.com
EMAIL_TO   = alejandro@velasquezcadavid.com
```

## 2) Crear el usuario `radicados-amigo` en la VPS

Como root:

```bash
adduser --disabled-password --gecos "" radicados-amigo
```

## 3) Clonar el repo en su home (como `radicados-amigo`)

```bash
sudo -iu radicados-amigo
git clone https://github.com/introduccionalderechofvp-star/buscador-radicados-vps.git app
cd app
git checkout claude/deploy-ubuntu-vps-w9dfD
npm ci
exit
```

`npm ci` esta vez instalará también `nodemailer` (es nueva dependencia).

## 4) Instalar Chromium para este usuario

Ya tienes las libs del sistema instaladas (paso del despliegue anterior),
así que solo falta el binario:

```bash
sudo -iu radicados-amigo
cd app
npx playwright install chromium
exit
```

(~150 MB, queda en `/home/radicados-amigo/.cache/ms-playwright/`. Es una
copia separada de la tuya, no se comparte — es lo correcto, evita
conflictos de permisos.)

## 5) Smoke test (1 radicado, sin tocar correo)

```bash
sudo -u radicados-amigo bash -c \
  'cd /home/radicados-amigo/app && node consultar.js 05001310301620220000200'
ls /home/radicados-amigo/app/resultados/$(date +%F)/
```

Esperado: PNG, JSON y posiblemente PDF + resumen. Si esto falla, no
sigas — es problema de Playwright o de red, no de correo.

## 6) Crear `/etc/radicados-amigo.env` con SMTP + destinatario

```bash
cp /home/radicados-amigo/app/deploy/amigo/radicados-amigo.env.example \
   /etc/radicados-amigo.env
chown root:radicados-amigo /etc/radicados-amigo.env
chmod 640 /etc/radicados-amigo.env
nano /etc/radicados-amigo.env
```

Llena los valores reales:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=correo_dedicado@gmail.com
SMTP_PASS=app_password_real_16_chars
EMAIL_FROM=correo_dedicado@gmail.com
EMAIL_TO=alejandro@velasquezcadavid.com
```

Guarda con `Ctrl+O`, `Enter`, sal con `Ctrl+X`.

## 7) Probar el envío de correo manualmente

Con el PDF del smoke test:

```bash
sudo -u radicados-amigo bash -c \
  'set -a; source /etc/radicados-amigo.env; set +a; \
   cd /home/radicados-amigo/app && node notificar-email.js'
```

Esperado: `Correo enviado.` y un mensaje en la bandeja de
`alejandro@velasquezcadavid.com` con el PDF adjunto.

**Si Gmail rechaza el login** (`Invalid login: 535 ...`), revisa:

- Que copiaste el **App Password** (16 letras), no la contraseña normal.
- Que la 2FA está activa en la cuenta.
- Que no hay espacios al inicio/final en `/etc/radicados-amigo.env`.

## 8) Instalar y activar las unidades systemd del amigo

```bash
cp /home/radicados-amigo/app/deploy/amigo/radicados-amigo.service        /etc/systemd/system/
cp /home/radicados-amigo/app/deploy/amigo/radicados-amigo.timer          /etc/systemd/system/
cp /home/radicados-amigo/app/deploy/amigo/radicados-amigo-notify.service /etc/systemd/system/
cp /home/radicados-amigo/app/deploy/amigo/radicados-amigo-notify.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now radicados-amigo.timer radicados-amigo-notify.timer
systemctl list-timers | grep radicados
```

Esperado: ahora ves **cuatro** timers:

| Timer | Próxima ejecución |
|---|---|
| `radicados.timer` (tuyo) | 02:30 |
| `radicados-amigo.timer` | 04:00 |
| `radicados-notify.timer` (tuyo) | 06:00 |
| `radicados-amigo-notify.timer` | 06:00 |

## 9) Probar la corrida completa de la instancia del amigo

Como root:

```bash
systemd-run --no-block --unit=radicados-amigo-prueba \
  /bin/sh -c 'systemctl start radicados-amigo.service; \
              systemctl start radicados-amigo-notify.service'
```

Tarda 10–25 min para 39 radicados. Cuando termine, llega el correo a
Alejandro. Puedes desconectar SSH; sigue corriendo.

Para revisar logs:

```bash
journalctl -u radicados-amigo.service -f
```

## 10) Mantenimiento

### Editar la lista del amigo

Edita `radicados-amigo.md` desde tu máquina y `git push` a la rama
`claude/deploy-ubuntu-vps-w9dfD`. La VPS hace `git pull --ff-only` antes
de cada corrida y aplica el cambio.

### Cambiar el destinatario o el asunto

Edita `/etc/radicados-amigo.env` (puedes cambiar `EMAIL_TO`,
`EMAIL_SUBJECT`, `EMAIL_BODY` sin reiniciar nada — la próxima corrida
los toma).

### Forzar una corrida o un envío

```bash
sudo systemctl start radicados-amigo.service          # solo consulta
sudo systemctl start radicados-amigo-notify.service   # solo correo
```

### Ver logs

```bash
journalctl -u radicados-amigo.service -n 200 --no-pager
journalctl -u radicados-amigo-notify.service -n 200 --no-pager
```

## 11) Solución de problemas específicos del correo

| Síntoma | Causa probable | Solución |
|---|---|---|
| `535 Username and Password not accepted` | App Password mal copiado o 2FA inactiva | Regenera el App Password, verifica 2FA |
| `534 Application-specific password required` | Contraseña normal en lugar de App Password | Genera App Password en `myaccount.google.com/apppasswords` |
| Correo no llega y tampoco hay error | Bloqueo por SPF/DPF en remitente nuevo | Revisa carpeta de spam; espera 24h y reintenta |
| `Message size exceeds fixed maximum (25 MB)` | PDF muy grande para Gmail | Comprimir con `gs -dPDFSETTINGS=/ebook` antes de enviar |
| `Connection timeout` o `ETIMEDOUT` | Puerto 587 bloqueado en la VPS | Probar puerto 465 (cambiar `SMTP_PORT=465` en el .env) |
