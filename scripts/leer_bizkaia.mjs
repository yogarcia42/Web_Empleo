import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const db = new DatabaseSync(
  new URL('../web_empleo.sqlite', import.meta.url)
);

const meses = {
  enero: '01', febrero: '02', marzo: '03',
  abril: '04', mayo: '05', junio: '06',
  julio: '07', agosto: '08', septiembre: '09',
  octubre: '10', noviembre: '11', diciembre: '12'
};

const boletines = [
  { numero: 1, mes: '01' },
  { numero: 2, mes: '01' },
  { numero: 3, mes: '01' },
  { numero: 183, mes: '09' }
];

const pendientes = [];

try {
  for (const { numero, mes } of boletines) {
    const existe = db.prepare(`
      SELECT numero FROM bizkaia
      WHERE numero = ? AND substr(fecha, 1, 4) = '2026'
    `).get(numero);

    if (existe) {
      console.log(`Boletín ${numero}: ya está guardado.`);
      continue;
    }

    const codigo = String(numero).padStart(3, '0');
    const url =
      `https://www.bizkaia.eus/lehendakaritza/Bao_bob/` +
      `2026/${mes}/BOB-2026a${codigo}.pdf`;

    console.log(`URL construida: ${url}`);

    const respuesta = await fetch(url, {
      signal: AbortSignal.timeout(60000)
    });

    if (!respuesta.ok) {
      throw new Error(`Boletín ${numero}: HTTP ${respuesta.status}`);
    }

    const pdf = Buffer.from(await respuesta.arrayBuffer());

    if (
      pdf.length > 100_000_000 ||
      pdf.subarray(0, 5).toString() !== '%PDF-'
    ) {
      throw new Error(`Boletín ${numero}: PDF inválido o demasiado grande.`);
    }

    const lectura = spawnSync(
      'pdftotext',
      ['-f', '1', '-l', '1', '-layout', '-', '-'],
      {
        input: pdf,
        encoding: 'utf8',
        maxBuffer: 5_000_000
      }
    );

    if (lectura.error || lectura.status !== 0) {
      throw new Error(
        `No se pudo leer el PDF ${numero}: ` +
        (lectura.error?.message || lectura.stderr)
      );
    }

    const texto = lectura.stdout.normalize('NFC');
    const cabecera = texto.slice(0, 3000);

    const numeroLeido = cabecera.match(
      /N[úu]m(?:ero)?\.?\s*[:º°]?\s*(\d+)/i
    );

    const fechaLeida = cabecera.match(
      /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/i
    );

    if (!numeroLeido || !fechaLeida) {
      console.log(cabecera);
      throw new Error(`No se reconoce la cabecera del boletín ${numero}.`);
    }

    const mesLeido = meses[fechaLeida[2].toLowerCase()];
    const fecha =
      `${fechaLeida[3]}-${mesLeido}-` +
      fechaLeida[1].padStart(2, '0');

    if (
      Number(numeroLeido[1]) !== numero ||
      fechaLeida[3] !== '2026' ||
      mesLeido !== mes
    ) {
      throw new Error(`La cabecera no coincide con la URL: ${numero}, ${fecha}.`);
    }

    pendientes.push({ numero, fecha, url });
    console.log(`PDF leído y verificado: n.º ${numero}, fecha ${fecha}.`);
  }

  db.exec('BEGIN');

  try {
    const insertar = db.prepare(
      'INSERT INTO bizkaia(numero, fecha, url) VALUES (?, ?, ?)'
    );

    for (const fila of pendientes) {
      insertar.run(fila.numero, fila.fecha, fila.url);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  console.log(`Carga inicial completada: ${pendientes.length} boletines añadidos.`);
} finally {
  db.close();
}
