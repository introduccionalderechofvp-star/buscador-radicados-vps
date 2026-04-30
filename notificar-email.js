import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM ?? SMTP_USER;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_SUBJECT_TEMPLATE =
  process.env.EMAIL_SUBJECT ?? 'Reporte radicados — {fecha}';
const EMAIL_BODY =
  process.env.EMAIL_BODY ??
  'Ahí te va. Me contás cómo lo ves.\n\nAtte. Pachito Asistente';

const RAIZ_RESULTADOS = path.resolve(process.env.RESULTADOS_DIR ?? 'resultados');
const MODO = process.argv[2] ?? 'auto';

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
  console.error('Faltan SMTP_HOST, SMTP_USER, SMTP_PASS o EMAIL_TO en el entorno.');
  process.exit(2);
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true para 465 (SSL), false para 587 (STARTTLS)
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

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

function statsDesdeResumen(md) {
  const lineas = md.split('\n');
  return lineas.filter((l) => /^-\s+(Total|Con|Sin|Fallas)/.test(l)).join('\n');
}

function asuntoConFecha(fecha) {
  return EMAIL_SUBJECT_TEMPLATE.replace('{fecha}', fecha);
}

function destinatarios() {
  return EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean);
}

async function enviarReporteDeCarpeta(carpeta) {
  const fechaCarpeta = path.basename(carpeta);
  const rutaPDF = await archivoMasReciente(carpeta, 'consolidado_', '.pdf');
  const rutaResumen = await archivoMasReciente(carpeta, 'resumen_', '.md');

  if (!rutaPDF) {
    throw new Error(`No encontré consolidado_*.pdf en ${carpeta}`);
  }

  let cuerpo = EMAIL_BODY;
  if (rutaResumen) {
    const md = await readFile(rutaResumen, 'utf8');
    const stats = statsDesdeResumen(md);
    if (stats) cuerpo = `${stats}\n\n${EMAIL_BODY}`;
  }

  const tamMB = ((await stat(rutaPDF)).size / (1024 * 1024)).toFixed(2);
  console.log(
    `Enviando ${path.basename(rutaPDF)} (${tamMB} MB) a ${EMAIL_TO}…`,
  );

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: destinatarios(),
    subject: asuntoConFecha(fechaCarpeta),
    text: cuerpo,
    attachments: [
      {
        filename: path.basename(rutaPDF),
        path: rutaPDF,
        contentType: 'application/pdf',
      },
    ],
  });

  console.log('Correo enviado.');
}

async function enviarFalla(motivo) {
  const fecha = fechaHoyBogota();
  const fechaLegible = new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota',
  });
  const cuerpo =
    `La corrida de radicados del ${fecha} no produjo PDF.\n\n` +
    `Motivo: ${motivo}\n` +
    `Fecha del aviso: ${fechaLegible}\n\n` +
    'Para diagnosticar en la VPS:\n' +
    '  journalctl -u radicados-amigo.service -n 200 --no-pager';
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: destinatarios(),
    subject: `[FALLA] ${asuntoConFecha(fecha)}`,
    text: cuerpo,
  });
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
    await enviarFalla(
      `la carpeta resultados/${fecha} existe pero no tiene PDF consolidado`,
    );
    return;
  }
  await enviarReporteDeCarpeta(carpetaHoy);
}

try {
  if (MODO === 'falla') await enviarFalla(process.argv[3] ?? 'invocación manual');
  else if (MODO === 'reporte') {
    const carpetaHoy = path.join(RAIZ_RESULTADOS, fechaHoyBogota());
    await enviarReporteDeCarpeta(carpetaHoy);
  } else await modoAuto();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
