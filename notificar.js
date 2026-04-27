import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RAIZ_RESULTADOS = path.resolve(process.env.RESULTADOS_DIR ?? 'resultados');
const MODO = process.argv[2] ?? 'auto';

if (!TOKEN || !CHAT_ID) {
  console.error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el entorno.');
  process.exit(2);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

async function callTelegram(metodo, form) {
  const res = await fetch(`${API}/${metodo}`, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(`Telegram ${metodo} falló: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.result;
}

async function enviarMensaje(texto) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('text', texto);
  form.append('parse_mode', 'Markdown');
  form.append('disable_web_page_preview', 'true');
  return callTelegram('sendMessage', form);
}

async function enviarDocumento(rutaArchivo, caption) {
  const datos = await readFile(rutaArchivo);
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
  }
  form.append(
    'document',
    new Blob([datos], { type: 'application/pdf' }),
    path.basename(rutaArchivo),
  );
  return callTelegram('sendDocument', form);
}

function fechaHoyBogota() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

async function archivoMasReciente(carpeta, prefijo, extension) {
  const archivos = await readdir(carpeta);
  const candidatos = archivos.filter(
    (n) => n.startsWith(prefijo) && n.endsWith(extension),
  );
  if (candidatos.length === 0) return null;
  const conMtime = await Promise.all(
    candidatos.map(async (n) => {
      const ruta = path.join(carpeta, n);
      const s = await stat(ruta);
      return { ruta, mtime: s.mtimeMs };
    }),
  );
  conMtime.sort((a, b) => b.mtime - a.mtime);
  return conMtime[0].ruta;
}

function captionDesdeResumen(md, fechaCarpeta) {
  // Toma las líneas de estadísticas (que empiezan con "- Total" y "- Con/Sin/Fallas")
  // y la primera sección "Con movimiento" si cabe.
  const lineas = md.split('\n');
  const stats = lineas.filter((l) => /^-\s+(Total|Con|Sin|Fallas)/.test(l));
  let caption = `*Reporte radicados · ${fechaCarpeta}*\n` + stats.join('\n');
  // Topamos en 1024 caracteres (límite de Telegram para captions).
  if (caption.length > 1000) caption = caption.slice(0, 990) + '\n…';
  return caption;
}

async function enviarReporteDeCarpeta(carpeta) {
  const fechaCarpeta = path.basename(carpeta);
  const rutaPDF = await archivoMasReciente(carpeta, 'consolidado_', '.pdf');
  const rutaResumen = await archivoMasReciente(carpeta, 'resumen_', '.md');

  if (!rutaPDF) {
    throw new Error(`No encontré consolidado_*.pdf en ${carpeta}`);
  }

  let caption = `*Reporte radicados · ${fechaCarpeta}*`;
  if (rutaResumen) {
    const md = await readFile(rutaResumen, 'utf8');
    caption = captionDesdeResumen(md, fechaCarpeta);
  }

  const tamMB = ((await stat(rutaPDF)).size / (1024 * 1024)).toFixed(2);
  console.log(`Enviando ${path.basename(rutaPDF)} (${tamMB} MB) a Telegram…`);
  await enviarDocumento(rutaPDF, caption);
  console.log('PDF enviado.');
}

async function enviarFalla(motivo) {
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const texto =
    `⚠️ *Reporte radicados — falla*\n` +
    `Fecha: ${fecha}\n` +
    `Motivo: ${motivo}\n` +
    'Revisa los logs con:\n' +
    '`journalctl -u radicados.service -n 200 --no-pager`';
  await enviarMensaje(texto);
  console.log('Notificación de falla enviada.');
}

async function modoAuto() {
  const fecha = fechaHoyBogota();
  const carpetaHoy = path.join(RAIZ_RESULTADOS, fecha);
  if (!existsSync(carpetaHoy)) {
    await enviarFalla(`no se generó la carpeta resultados/${fecha}`);
    return;
  }
  const rutaPDF = await archivoMasReciente(carpetaHoy, 'consolidado_', '.pdf');
  if (!rutaPDF) {
    await enviarFalla(`la carpeta resultados/${fecha} existe pero no tiene PDF consolidado`);
    return;
  }
  await enviarReporteDeCarpeta(carpetaHoy);
}

try {
  if (MODO === 'falla') await enviarFalla(process.argv[3] ?? 'invocación manual');
  else if (MODO === 'reporte') {
    // Compat: manda el PDF de hoy si existe; si no, lanza error (uso manual).
    const carpetaHoy = path.join(RAIZ_RESULTADOS, fechaHoyBogota());
    await enviarReporteDeCarpeta(carpetaHoy);
  } else await modoAuto();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
